import type { ExchangeId } from './exchanges.js';

export type BotMode = 'screener' | 'semi' | 'auto';
export type ExecutionMode = 'paper' | 'testnet' | 'live';
export type PlanId = 'screener' | 'limited' | 'unlimited';

/** Одна строка скринера: лучшая пара бирж по конкретной монете. */
export interface SpreadRow {
  /** Унифицированный символ ccxt, например 'BTC/USDT:USDT'. */
  symbol: string;
  /** Базовый тикер для показа: BTC. */
  base: string;
  /** Полное имя монеты: Bitcoin. */
  name: string;
  /** Нога LONG — покупаем там, где дешевле. */
  longExchange: ExchangeId;
  longPrice: number;
  /** Нога SHORT — продаём там, где дороже. */
  shortExchange: ExchangeId;
  shortPrice: number;
  /** Абсолютный спред в котируемой валюте (USDT). */
  spreadAbs: number;
  /** Грязный спред, %. */
  spreadPct: number;
  /**
   * Чистый ожидаемый профит, % — спред минус комиссии за 4 маркет-ордера
   * минус/плюс ожидаемый фандинг за горизонт удержания (ТЗ §7.1).
   * Именно эта цифра решает, стоит ли входить.
   */
  netPct: number;
  /** Ожидаемая стоимость фандинга за горизонт удержания, % (плюс = в нашу пользу). */
  fundingPct: number;
  /** Комиссии round-trip, %. */
  feesPct: number;
  /** Время самой старой из двух котировок, мс epoch. */
  quotedAt: number;
  /** Котировка устарела (см. QUOTE_STALE_MS) — в расчёт входа не берётся. */
  stale: boolean;
}

export interface ScreenerSnapshot {
  rows: SpreadRow[];
  /** Сколько строк проходит порог минимального спреда пользователя. */
  opportunities: number;
  /** Средний спред по прошедшим порог, %. */
  avgSpreadPct: number;
  /** История значения opportunities для спарклайна в карточке. */
  trend: number[];
  /** Частота пересчёта, мс. */
  refreshMs: number;
  updatedAt: number;
  botRunning: boolean;
}

export type PositionStatus = 'open' | 'closed';

export interface PositionLeg {
  exchange: ExchangeId;
  side: 'long' | 'short';
  entryPrice: number;
  /** Объём ноги в монете. */
  amount: number;
  /** Объём ноги в USDT по цене входа. */
  notional: number;
}

export interface Position {
  id: string;
  symbol: string;
  base: string;
  name: string;
  status: PositionStatus;
  executionMode: ExecutionMode;
  long: PositionLeg;
  short: PositionLeg;
  /** Спред на момент входа, %. */
  entrySpreadPct: number;
  /** Текущий спред, % (live). */
  currentSpreadPct: number;
  leverage: number;
  pnlUsdt: number;
  pnlPct: number;
  openedAt: number;
  closedAt?: number;
  /** Позиция открыта фандинг-стратегией (ТЗ §7.2) — задел на будущее. */
  fundingStrategy?: boolean;
}

export interface PositionsSummary {
  openCount: number;
  totalPnlUsdt: number;
  unrealizedPnlUsdt: number;
  capitalInUseUsdt: number;
}

/** Риск-лимиты. Все значения задаёт пользователь, ничего не зашито (ТЗ §8). */
export interface RiskSettings {
  maxOpenPairs: number;
  maxLeverage: number;
  maxNotionalPerLegUsdt: number;
  dailyLossLimitPct: number;
  holdTimeoutMinutes: number;
  chaseAttempts: number;
  chaseTimeoutMs: number;
  limitOrderTimeoutMs: number;
}

export interface BotSettings {
  mode: BotMode;
  executionMode: ExecutionMode;
  running: boolean;
  refreshMs: number;
  minSpreadPct: number;
  defaultLeverage: number;
  defaultNotionalUsdt: number;
  enabledExchanges: ExchangeId[];
  /** Не входить, если фандинг делает сделку убыточной (ТЗ §7.3). */
  onlyProfitableFunding: boolean;
}

export interface ApiKeyStatus {
  exchange: ExchangeId;
  connected: boolean;
  /** Права проверены по API биржи; false — биржа не отдаёт права, проверка ручная. */
  permissionsVerified: boolean;
  withdrawalDisabled: boolean | null;
  label?: string;
}

/** Уведомления (ТЗ §11). Порог — в процентах спреда. */
export interface NotificationSettings {
  enabled: boolean;
  onOpportunity: boolean;
  opportunityThresholdPct: number;
  onPositionOpened: boolean;
  onPositionClosed: boolean;
  onRiskLimit: boolean;
  /** Полуавтомат: запрос подтверждения сделки приходит в чат бота. */
  onConfirmationNeeded: boolean;
}

/** Что пользователь может поменять у уже открытой позиции (ТЗ §4.3, «Изменить»). */
export interface PositionAdjustment {
  /** Целевой спред для автозакрытия, %. */
  targetSpreadPct: number | null;
  /** Ручной стоп: закрыть, если спред расширился до этого значения, %. */
  stopSpreadPct: number | null;
}

export interface SessionInfo {
  id: string;
  platform: string;
  telegramVersion: string;
  current: boolean;
  lastSeenAt: number;
}
