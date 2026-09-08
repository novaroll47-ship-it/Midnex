/** Клиент бэкенда. initData уходит в заголовке — сервер проверяет подпись. */
import type {
  ApiKeyStatus,
  BotSettings,
  NotificationSettings,
  PlanId,
  Position,
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

  if (!res.ok) throw new ApiError(`${method} ${path} -> ${res.status}`, res.status);
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
}

export const api = {
  health: () =>
    get<{ ok: boolean; version: string; devFakeUser: boolean; botTokenConfigured: boolean }>(
      '/api/health',
    ),

  screener: (minSpread?: number) => get<ScreenerSnapshot>('/api/screener', { minSpread }),

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
  adjustPosition: (id: string, body: { targetSpreadPct?: number | null; stopSpreadPct?: number | null }) =>
    request<PositionDetail>('PATCH', `/api/positions/${id}`, body),
  closePosition: (id: string) => request<{ position: Position }>('POST', `/api/positions/${id}/close`),

  sessions: () => get<{ sessions: SessionInfo[] }>('/api/sessions'),
};
