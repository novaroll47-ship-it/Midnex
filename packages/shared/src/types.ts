import type { ExchangeId } from './exchanges.js';

/** Режим бота: полуавтомат подтверждает вход, автомат входит сам. */
export type BotMode = 'semi' | 'auto';
/**
 * Исполнение: реальные деньги; «бумажная торговля» — скрытый режим для
 * обкатки разработчиком, пользователю не показывается и не выбирается.
 */
export type ExecutionMode = 'paper' | 'live';
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
  /**
   * Известны ли ставки фандинга по обеим ногам. Если нет, fundingPct равен
   * нулю не потому, что фандинга нет, а потому, что биржа его не отдаёт.
   */
  fundingKnown?: boolean;
  /**
   * Спред неправдоподобно велик — почти наверняка под одним тикером на двух
   * биржах торгуются разные активы (BB на Binance и BB на OKX — не одна
   * монета). Такая строка в возможности не попадает и уходит в конец списка.
   */
  suspect?: boolean;
  /** Одна из ног сверена меньше недели назад — свежий листинг. */
  isNew?: boolean;
  /** С какого момента спред держится выше порога заметности; null — сейчас ниже. */
  heldSinceAt?: number | null;
  /** Сколько раз за сегодня спред поднимался выше порога заметности. */
  cyclesToday?: number;
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
  /** Без подписки: отдана только верхушка списка. */
  preview?: boolean;
  /** Сколько строк всего, когда отдано превью. */
  totalRows?: number;
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
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Котировка одной монеты на одной бирже — для экрана деталей монеты. */
export interface VenueQuote {
  exchange: ExchangeId;
  price: number;
  bid: number;
  ask: number;
  /** Текущая ставка фандинга, % за период выплаты. */
  fundingPct: number;
  /** Время следующей выплаты фандинга, мс epoch. */
  nextFundingAt: number;
  updatedAt: number;
  stale: boolean;
}

/** Полная картина по монете: цены на всех биржах и лучшая пара для входа. */
export interface CoinDetail {
  symbol: string;
  base: string;
  name: string;
  quotes: VenueQuote[];
  best: {
    longExchange: ExchangeId;
    shortExchange: ExchangeId;
    spreadAbs: number;
    spreadPct: number;
    netPct: number;
    feesPct: number;
    fundingPct: number;
  };
  updatedAt: number;
}

/**
 * Фандинг по парной позиции.
 *
 * На лонг-ноге фандинг платим мы (при положительной ставке), на шорт-ноге —
 * получаем. Значение имеет именно разница ставок, а не каждая по отдельности.
 */
export interface PositionFunding {
  /** Ставка на бирже, где открыт лонг, % за период. */
  longRatePct: number;
  /** Ставка на бирже, где открыт шорт, % за период. */
  shortRatePct: number;
  /** Итог за время удержания, % от объёма. Плюс — в нашу пользу. */
  netPct: number;
  /** То же в деньгах. */
  netUsdt: number;
  /** Время следующей выплаты, мс epoch. */
  nextAt: number;
  /** Сколько выплат уже прошло с момента входа. */
  periodsElapsed: number;
}

/**
 * Бот «Фандинг»: дельта-нейтральная пара ради разницы ставок фандинга.
 * Лонг там, где ставка ниже (или отрицательная), шорт — где выше; доход
 * капает каждую выплату, пока разница держится.
 */
export interface FundingBotSettings {
  running: boolean;
  executionMode: ExecutionMode;
  exchanges: ExchangeId[];
  /** Минимальная разница ставок за период выплаты, %. */
  minRateDiffPct: number;
  /** Минимальная годовая доходность разницы, %. */
  minAprPct: number;
  /** Максимальный ценовой спред при входе, % — иначе вход съест доход. */
  maxEntrySpreadPct: number;
  /** Минимум выплат, которые нужно пересидеть, прежде чем выходить. */
  minPayouts: number;
  /** Выход, когда разница ставок падает ниже этого, %. */
  exitBelowPct: number;
  notionalUsdt: number;
  leverage: number;
  maxPositions: number;
}

/** Личные настройки вида: список или карточки в скринере. */
export interface UiSettings {
  view: 'list' | 'cards';
}

/** Прогресс обучения: какие модули пройдены (или пропущены). */
export interface OnboardingState {
  completed: string[];
}
