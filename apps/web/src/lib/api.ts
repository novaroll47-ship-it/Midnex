/** Клиент бэкенда. initData уходит в заголовке — сервер проверяет подпись. */
import type {
  ApiKeyStatus,
  BillingMonths,
  PaymentInfo,
  SubscriptionInfo,
  ExchangeId,
  BotSettings,
  CoinDetail,
  NotificationSettings,
  PlanId,
  Position,
  PositionFunding,
  PositionsSummary,
  RiskSettings,
  ScreenerSnapshot,
  SessionInfo,
} from '@cs/shared';

import { initData, platform, tgVersion } from './telegram';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Машинный код причины из тела ответа, если сервер его дал. */
    readonly code?: string,
  ) {
    super(message);
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'X-Tg-Platform': platform,
    'X-Tg-Version': tgVersion,
  };
  if (initData) h['X-Telegram-Init-Data'] = initData;
  return h;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { ...headers(), 'Content-Type': 'application/json' } : headers(),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    // Сервер объясняет отказ в теле — пробрасываем, чтобы экран мог показать причину.
    let detail: { error?: string; status?: string } = {};
    try {
      detail = (await res.json()) as typeof detail;
    } catch {
      // Тело не JSON — достаточно кода.
    }
    throw new ApiError(
      detail.error ?? `${method} ${path} -> ${res.status}`,
      res.status,
      detail.status,
    );
  }
  return (await res.json()) as T;
}

function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return request<T>('GET', url.pathname + url.search);
}

export interface PositionsResponse {
  tab: string;
  positions: Position[];
  summary: PositionsSummary;
}

export interface PositionDetail {
  position: Position;
  targetSpreadPct: number | null;
  stopSpreadPct: number | null;
  feesUsdt: number;
  funding: PositionFunding;
  closeReason: string | null;
  holdTimeoutMinutes: number;
}

export interface SettingsResponse {
  bot: BotSettings;
  risk: RiskSettings;
  notifications: NotificationSettings;
  plan: PlanId;
  apiKeys: ApiKeyStatus[];
  version: string;
  /** Где лежат данные пользователя: база или память процесса. */
  storage: 'postgres' | 'memory';
  /** Что включено на этом этапе релиза. */
  features: { trading: boolean };
  subscription: SubscriptionInfo;
}

export interface BillingResponse {
  botUsername: string | null;
  subscription: SubscriptionInfo;
  pending: PaymentInfo | null;
  purchasable: PlanId[];
  starsPerUsd: number;
  /** Сети, на которые принимается USDT. */
  wallets: string[];
  starsAvailable: boolean;
}

export type ExchangeKeyStatus = 'unverified' | 'ok' | 'invalid' | 'withdrawal_enabled';

/** Ключ биржи так, как его видит интерфейс: без секретов. */
export interface ExchangeKeyPublic {
  exchange: ExchangeId;
  label: string;
  keyHint: string;
  status: ExchangeKeyStatus;
  withdrawalDisabled: boolean | null;
  permissionsVerified: boolean;
  lastError: string | null;
  createdAt: number;
  lastCheckedAt: number | null;
}

export interface KeysResponse {
  encryption: boolean;
  keys: ExchangeKeyPublic[];
}

export interface ConnectKeyResponse {
  key: ExchangeKeyPublic;
  usdtBalance: number | null;
  manualChecklist: boolean;
}

export interface FeedStatus {
  exchange: ExchangeId;
  mode: 'ws' | 'rest';
  status: 'starting' | 'live' | 'reconnecting' | 'down';
  symbols: number;
  quoted: number;
  lastUpdateAt: number | null;
  latencyMs: number | null;
  reconnects: number;
  lastError: string | null;
}

export interface MarketStatus {
  mode: 'live' | 'mock';
  live: boolean;
  engine: {
    ready: boolean;
    startedAt: number | null;
    universeSize: number;
    feeds: FeedStatus[];
    fundingUnsupported: ExchangeId[];
  } | null;
}

export const api = {
  marketStatus: () => get<MarketStatus>('/api/market/status'),
  health: () =>
    get<{ ok: boolean; version: string; devFakeUser: boolean; botTokenConfigured: boolean }>(
      '/api/health',
    ),

  screener: (minSpread?: number, venues?: string) =>
    get<ScreenerSnapshot>('/api/screener', { minSpread, venues }),
  coin: (base: string) => get<CoinDetail>(`/api/coin/${encodeURIComponent(base)}`),

  settings: () => get<SettingsResponse>('/api/settings'),
  patchBot: (body: Partial<BotSettings>) =>
    request<SettingsResponse>('PATCH', '/api/settings/bot', body),
  patchRisk: (body: Partial<RiskSettings>) =>
    request<SettingsResponse>('PATCH', '/api/settings/risk', body),
  patchNotifications: (body: Partial<NotificationSettings>) =>
    request<SettingsResponse>('PATCH', '/api/settings/notifications', body),
  patchPlan: (plan: PlanId) => request<SettingsResponse>('PATCH', '/api/settings/plan', { plan }),

  positions: (tab: string) => get<PositionsResponse>('/api/positions', { tab }),
  position: (id: string) => get<PositionDetail>(`/api/positions/${id}`),
  adjustPosition: (
    id: string,
    body: { targetSpreadPct?: number | null; stopSpreadPct?: number | null },
  ) => request<PositionDetail>('PATCH', `/api/positions/${id}`, body),
  closePosition: (id: string) =>
    request<{ position: Position }>('POST', `/api/positions/${id}/close`),

  watchlist: () => get<{ bases: string[] }>('/api/watchlist'),
  setWatchlist: (bases: string[]) =>
    request<{ bases: string[] }>('PUT', '/api/watchlist', { bases }),

  keys: () => get<KeysResponse>('/api/keys'),
  connectKey: (
    exchange: ExchangeId,
    body: { apiKey: string; secret: string; passphrase?: string; label?: string },
  ) => request<ConnectKeyResponse>('POST', `/api/keys/${exchange}`, body),
  verifyKey: (exchange: ExchangeId) =>
    request<{ key: ExchangeKeyPublic; usdtBalance: number | null }>(
      'POST',
      `/api/keys/${exchange}/verify`,
    ),
  deleteKey: (exchange: ExchangeId) => request<{ ok: true }>('DELETE', `/api/keys/${exchange}`),

  billing: () => get<BillingResponse>('/api/billing'),
  starsInvoice: (plan: PlanId, months: BillingMonths) =>
    request<{ link: string; sentToChat: boolean; payment: PaymentInfo }>(
      'POST',
      '/api/billing/stars',
      {
        plan,
        months,
      },
    ),
  cryptoRequest: (plan: PlanId, months: BillingMonths, network: string) =>
    request<{ payment: PaymentInfo; address: string }>('POST', '/api/billing/crypto', {
      plan,
      months,
      network,
    }),
  cryptoSubmit: (id: string, txHash: string) =>
    request<{ payment: PaymentInfo }>('POST', `/api/billing/crypto/${id}/tx`, { txHash }),
  cryptoCancel: (id: string) => request<{ ok: true }>('POST', `/api/billing/crypto/${id}/cancel`),

  sessions: () => get<{ sessions: SessionInfo[] }>('/api/sessions'),
  logoutOthers: () => request<{ removed: number }>('POST', '/api/sessions/logout-others'),
};
