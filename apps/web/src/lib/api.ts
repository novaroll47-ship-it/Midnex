/** Клиент бэкенда. initData уходит в заголовке — сервер проверяет подпись. */
import type {
  ApiKeyStatus,
  BillingMonths,
  PaymentInfo,
  SubscriptionInfo,
  ExchangeId,
  BotSettings,
  CoinDetail,
  LiquidityDetail,
  NotificationSettings,
  PlanId,
  Position,
  PositionFunding,
  PositionsSummary,
  RiskSettings,
  ScreenerSnapshot,
  SessionInfo,
  UiSettings,
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
  // POST без тела некоторые вебвью отправляют с content-type, который сервер
  // не знает, и получают 415. Поэтому у изменяющих запросов тело есть всегда.
  const withBody = method !== 'GET';
  const res = await fetch(path, {
    method,
    headers: withBody ? { ...headers(), 'Content-Type': 'application/json' } : headers(),
    body: withBody ? JSON.stringify(body ?? {}) : undefined,
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
  onboarding: { completed: string[] };
  ui: UiSettings;
  plan: PlanId;
  apiKeys: ApiKeyStatus[];
  version: string;
  /** Где лежат данные пользователя: база или память процесса. */
  storage: 'postgres' | 'memory';
  /** Что включено на этом этапе релиза. */
  features: { trading: boolean; admin: boolean };
  subscription: SubscriptionInfo;
}

export interface HistoryCandle {
  ts: number;
  base: string;
  exA: ExchangeId;
  exB: ExchangeId;
  open: number;
  high: number;
  low: number;
  close: number;
  samples: number;
  source: 'live' | 'reconstructed';
}

export type HistoryTf = '1s' | '1m' | '5m' | '15m' | '1h' | '1d';

/** Посекундная серия (таймфрейм «1с»): значения по секундам, null — пропуск. */
export interface HistorySeries {
  ts0: number;
  stepMs: number;
  values: (number | null)[];
  pairIdx?: (number | null)[];
  pairs?: { exA: ExchangeId; exB: ExchangeId }[];
}

export interface HistoryResponse {
  base: string;
  tf: HistoryTf;
  tfMs: number;
  from: number;
  to: number;
  /** Заданы, если история по конкретной паре бирж. */
  exA?: ExchangeId;
  exB?: ExchangeId;
  candles: HistoryCandle[];
  /** Только для tf=1s. */
  series?: HistorySeries | null;
}

export type PairStatus = 'candidate' | 'verified' | 'rejected' | 'delisted';
export type VerificationSource = 'auto_price' | 'auto_multiplier' | 'external_match' | 'manual';

export interface PairView {
  base: string;
  exchangeA: ExchangeId;
  symbolA: string;
  exchangeB: ExchangeId;
  symbolB: string;
  /** цена_A ≈ multiplier × цена_B. */
  multiplier: number;
  status: PairStatus;
  verificationSource: VerificationSource | null;
  ratio: number | null;
  externalA: string | null;
  externalB: string | null;
  note: string | null;
  category: 'nominal' | 'identity' | 'data' | 'risky' | null;
  anomalyLeg: string | null;
  updatedAt: number;
  updatedBy: string | null;
  verifiedAt: number | null;
  priceA: number | null;
  priceB: number | null;
  liveRatio: number | null;
}

export interface PairCounts {
  total: number;
  verified: number;
  auto: number;
  manual: number;
  anomalies: number;
  pending: number;
  rejected: number;
}

export type FundingPeriod = '1d' | '7d' | '30d' | '180d';

export interface FundingVenue {
  exchange: ExchangeId;
  symbol: string;
  longPct: number;
  shortPct: number;
  payouts: number;
  avgRatePct: number;
}

export type FundingBucket = 'payout' | 'day' | 'week';

export interface FundingBreakdown {
  bucket: FundingBucket;
  /** По каждой корзине времени — сумма ставок по биржам, % (шорт получает, лонг платит). */
  rows: { ts: number; rates: Partial<Record<ExchangeId, number>> }[];
}

export interface FundingResponse {
  base: string;
  period: FundingPeriod;
  venues: FundingVenue[];
  best: { longExchange: ExchangeId; shortExchange: ExchangeId; netPct: number } | null;
  breakdown: FundingBreakdown;
}

export interface AlertRule {
  id: string;
  userId: number;
  type: 'pair' | 'global';
  base: string | null;
  thresholdPct: number;
  isArmed: boolean;
  lastFiredAt: number | null;
  lastBase: string | null;
  createdAt: number;
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
  /** Оплата через @CryptoBot настроена на сервере. */
  cryptoBotAvailable: boolean;
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
  coin: (base: string, venues?: string) =>
    get<CoinDetail>(`/api/coin/${encodeURIComponent(base)}`, { venues }),
  coinLiquidity: (base: string, volume: number, venues?: string) =>
    get<LiquidityDetail>(`/api/coin/${encodeURIComponent(base)}/liquidity`, { volume, venues }),

  settings: () => get<SettingsResponse>('/api/settings'),
  patchBot: (body: Partial<BotSettings>) =>
    request<SettingsResponse>('PATCH', '/api/settings/bot', body),
  patchRisk: (body: Partial<RiskSettings>) =>
    request<SettingsResponse>('PATCH', '/api/settings/risk', body),
  patchNotifications: (body: Partial<NotificationSettings>) =>
    request<SettingsResponse>('PATCH', '/api/settings/notifications', body),
  patchPlan: (plan: PlanId) => request<SettingsResponse>('PATCH', '/api/settings/plan', { plan }),
  patchUi: (ui: Partial<UiSettings>) => request<SettingsResponse>('PATCH', '/api/settings/ui', ui),
  patchOnboarding: (completed: string[]) =>
    request<SettingsResponse>('PATCH', '/api/settings/onboarding', { completed }),

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

  history: (
    base: string,
    tf: HistoryTf,
    from: number,
    to: number,
    pair?: { exA: ExchangeId; exB: ExchangeId },
  ) =>
    get<HistoryResponse>(`/api/history/${encodeURIComponent(base)}`, {
      tf,
      from,
      to,
      exA: pair?.exA,
      exB: pair?.exB,
      // Дневные свечи режутся по местной полуночи.
      tz: tf === '1d' ? new Date().getTimezoneOffset() : undefined,
    }),

  adminPairLeg: (exchange: ExchangeId, symbol: string, factor: number) =>
    request<{ ok: true; counts: PairCounts }>('POST', '/api/admin/pairs/leg', { exchange, symbol, factor }),
  adminPairs: (filter: 'anomalies' | 'verified' | 'rejected' | 'pending') =>
    get<{ pairs: PairView[]; total: number; counts: PairCounts }>('/api/admin/pairs', { filter }),
  adminPairDecide: (
    pair: Pick<PairView, 'exchangeA' | 'symbolA' | 'exchangeB' | 'symbolB'>,
    status: 'verified' | 'rejected' | 'candidate',
    multiplier?: number,
  ) =>
    request<{ pair: PairView; counts: PairCounts }>('POST', '/api/admin/pairs/decide', {
      ...pair,
      status,
      multiplier,
    }),

  coinFunding: (base: string, period: FundingPeriod) =>
    get<FundingResponse>(`/api/coin/${encodeURIComponent(base)}/funding`, { period }),

  alerts: () => get<{ rules: AlertRule[]; active: boolean }>('/api/alerts'),
  createAlert: (body: { type: 'pair' | 'global'; base?: string; thresholdPct: number }) =>
    request<{ rule: AlertRule }>('POST', '/api/alerts', body),
  deleteAlert: (id: string) => request<{ ok: true }>('DELETE', `/api/alerts/${id}`),

  billing: () => get<BillingResponse>('/api/billing'),
  starsInvoice: (plan: PlanId, months: BillingMonths) =>
    request<{ link: string; payment: PaymentInfo }>('POST', '/api/billing/stars', { plan, months }),
  starsToChat: (id: string) => request<{ ok: true }>('POST', `/api/billing/stars/${id}/chat`),
  cryptoBotInvoice: (plan: PlanId, months: BillingMonths) =>
    request<{ payUrl: string; botUrl: string; payment: PaymentInfo }>('POST', '/api/billing/cryptobot', {
      plan,
      months,
    }),
  paymentStatus: (id: string) =>
    get<{ payment: PaymentInfo; subscription: SubscriptionInfo }>(`/api/billing/payment/${id}`),
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
