/**
 * Хранилище истории спредов и фандинга.
 *
 * Интерфейс намеренно узкий: писать пачками, читать свечи по паре за
 * период, считать дыры. Реализация сейчас — SQLite на той же машине, где
 * работает движок (файл переезжает вместе с процессом); на сервере её можно
 * заменить на TimescaleDB, не трогая сборщик и API.
 *
 * Объёмы: сырые точки раз в секунду пишутся только по парам выше порога,
 * минутные свечи — по всем парам; 5m/1h строятся из 1m. Иначе 900 пар ×
 * 86 400 с — это 78 млн строк в сутки, столько не нужно никому.
 */
import type { ExchangeId } from '@cs/shared';

export type Timeframe = '1m' | '5m' | '1h';
export type HistorySource = 'live' | 'reconstructed';

export interface SpreadTick {
  ts: number;
  base: string;
  exA: ExchangeId;
  exB: ExchangeId;
  priceA: number;
  priceB: number;
  spreadPct: number;
  source: HistorySource;
}

export interface SpreadCandle {
  ts: number;
  base: string;
  exA: ExchangeId;
  exB: ExchangeId;
  open: number;
  high: number;
  low: number;
  close: number;
  samples: number;
  source: HistorySource;
}

export type GapReason =
  | 'process_start'
  | 'ws_closed'
  | 'ws_stall'
  | 'rest_429'
  | 'rest_error'
  | 'rest_fallback'
  | 'markets_failed';

export interface SpreadGap {
  fromTs: number;
  toTs: number | null;
  exchange: ExchangeId | 'all';
  reason: GapReason;
}

export interface FundingRateRow {
  exchange: ExchangeId;
  symbol: string;
  ts: number;
  rate: number;
}

export interface HistoryStatus {
  path: string;
  sizeBytes: number;
  ticks: number;
  candles1m: number;
  candles5m: number;
  candles1h: number;
  fundingRates: number;
  lastTickAt: number | null;
  lastCandleAt: number | null;
  gapsLast24h: number;
}

export interface HistoryStore {
  writeTicks(rows: SpreadTick[]): void;
  writeCandles(tf: Timeframe, rows: SpreadCandle[]): void;
  /** Открыть дыру; возвращает id, чтобы закрыть её при восстановлении. */
  openGap(gap: Omit<SpreadGap, 'toTs'>): number;
  closeGap(id: number, toTs: number): void;
  queryCandles(
    base: string,
    tf: Timeframe,
    from: number,
    to: number,
    exA?: ExchangeId,
    exB?: ExchangeId,
  ): SpreadCandle[];
  /** Последняя записанная минута — чтобы на старте отметить дыру от неё. */
  lastCandleAt(): number | null;
  /** Свернуть 1m в старшие таймфреймы за интервал (идемпотентно). */
  rollup(from: number, to: number): void;
  /** Удалить сырые точки старше rawDays и 1m-свечи старше minuteDays. */
  retention(rawDays: number, minuteDays: number): void;
  writeFundingRates(rows: FundingRateRow[]): void;
  latestFundingTs(exchange: ExchangeId, symbol: string): number | null;
  queryFundingRates(
    exchange: ExchangeId,
    symbol: string,
    from: number,
    to: number,
  ): FundingRateRow[];
  status(): HistoryStatus;
  close(): void;
}
