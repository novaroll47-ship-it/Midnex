import type {
  BotSettings,
  FundingBotSettings,
  NotificationSettings,
  RiskSettings,
  UiSettings,
} from './types.js';

/**
 * Котировка старше этого возраста не участвует в расчёте спреда.
 * Без этого guard'а оборванный WebSocket даёт фантомный спред на замерших ценах —
 * самый опасный класс ложных сигналов.
 */
export const QUOTE_STALE_MS = 3_000;

/** Комиссия taker по умолчанию на ногу, % (уточняется из market.taker по каждой бирже). */
export const DEFAULT_TAKER_PCT = 0.055;

/** Вход (2 ордера) + выход (2 ордера) = 4 тейкера. */
export const ROUND_TRIP_LEGS = 4;

export const DEFAULT_RISK: RiskSettings = {
  maxOpenPairs: 3,
  maxLeverage: 10,
  maxNotionalPerLegUsdt: 100,
  dailyLossLimitPct: 5,
  holdTimeoutMinutes: 240,
  chaseAttempts: 3,
  chaseTimeoutMs: 5_000,
  limitOrderTimeoutMs: 3_000,
};

export const DEFAULT_BOT: BotSettings = {
  mode: 'semi',
  executionMode: 'live',
  running: true,
  refreshMs: 1_000,
  minSpreadPct: 0.5,
  defaultLeverage: 10,
  defaultNotionalUsdt: 100,
  enabledExchanges: ['binance', 'bybit', 'okx', 'mexc', 'bitget', 'bingx', 'gate', 'kucoin'],
  onlyProfitableFunding: true,
};

/** Лимит монет в списке для торговли по тарифам (ТЗ §9). null = без ограничений. */
export const PLAN_WATCHLIST_LIMIT: Record<string, number | null> = {
  screener: 0,
  limited: 10,
  unlimited: null,
};

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  onOpportunity: true,
  opportunityThresholdPct: 1,
  onPositionOpened: true,
  onPositionClosed: true,
  onRiskLimit: true,
  onConfirmationNeeded: true,
};

export const DEFAULT_UI: UiSettings = { view: 'list' };

export const APP_VERSION = '0.2.0';

export const DEFAULT_FUNDING_BOT: FundingBotSettings = {
  running: false,
  executionMode: 'live',
  exchanges: ['binance', 'bybit', 'okx', 'bitget', 'bingx', 'gate'],
  minRateDiffPct: 0.03,
  minAprPct: 20,
  maxEntrySpreadPct: 0.15,
  minPayouts: 3,
  exitBelowPct: 0.005,
  notionalUsdt: 200,
  leverage: 2,
  maxPositions: 3,
};
