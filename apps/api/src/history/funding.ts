/**
 * История ставок фандинга.
 *
 * Биржи хранят её сами (fetchFundingRateHistory), поэтому копить с нуля
 * не нужно: при старте — очередь по всем сверенным ногам с глубиной 180
 * дней, дальше раз в час — только новые выплаты. Всё уважает rateLimit
 * ccxt (enableRateLimit) и идёт по одной бирже параллельно с другими.
 *
 * Агрегаты по периодам считаются на запрос из хранилища и кешируются на
 * час: сумма ставок за период — это и есть накопленный фандинг; лонг его
 * платит (−Σ), шорт получает (+Σ).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ExchangeId } from '@cs/shared';
import type { MarketEngine } from '@cs/market';

import type { FundingRateRow, HistoryStore } from './store.js';

export type FundingPeriod = '1d' | '7d' | '30d' | '180d';
export const FUNDING_PERIODS: FundingPeriod[] = ['1d', '7d', '30d', '180d'];
const PERIOD_MS: Record<FundingPeriod, number> = {
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '180d': 180 * 86_400_000,
};

export interface FundingAggregate {
  exchange: ExchangeId;
  symbol: string;
  /** Накопленный фандинг за период, % от позиции: лонг платит, шорт получает. */
  longPct: number;
  shortPct: number;
  /** Сколько выплат учтено. */
  payouts: number;
  /** Средняя ставка за выплату, %. */
  avgRatePct: number;
}

/** Разбивка фандинга по времени: сутки — по выплатам, неделя и месяц — по дням, полгода — по неделям. */
export type FundingBucket = 'payout' | 'day' | 'week';
export const FUNDING_BUCKET: Record<FundingPeriod, FundingBucket> = {
  '1d': 'payout',
  '7d': 'day',
  '30d': 'day',
  '180d': 'week',
};
const BUCKET_MS: Record<FundingBucket, number> = { payout: 0, day: 86_400_000, week: 7 * 86_400_000 };

export interface FundingBreakdown {
  bucket: FundingBucket;
  /** Точки по времени; по каждой бирже — сумма ставок за корзину, % (шорт получает, лонг платит). */
  rows: { ts: number; rates: Partial<Record<ExchangeId, number>> }[];
}

export interface FundingHistoryOptions {
  store: HistoryStore;
  engine: MarketEngine | null;
  log: FastifyBaseLogger;
  /** Какие ноги грузить: (exchange, symbol) сверенных ног. */
  legs: () => { exchange: ExchangeId; symbol: string }[];
  backfillDays: number;
}

export class FundingHistory {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly cache = new Map<string, { at: number; value: FundingAggregate[] }>();

  constructor(private readonly o: FundingHistoryOptions) {}

  start(): void {
    if (this.timer) return;
    // Первый проход — через минуту после старта, когда биржи подключились.
    setTimeout(() => void this.sync(), 60_000);
    this.timer = setInterval(() => void this.sync(), 60 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Один проход: по каждой бирже — очередь её ног, биржи параллельно. */
  async sync(): Promise<void> {
    if (this.running || !this.o.engine) return;
    this.running = true;
    const t0 = Date.now();
    const byExchange = new Map<ExchangeId, string[]>();
    for (const leg of this.o.legs()) {
      byExchange.set(leg.exchange, [...(byExchange.get(leg.exchange) ?? []), leg.symbol]);
    }
    let rows = 0;
    let failed = 0;
    await Promise.all(
      [...byExchange].map(async ([exchange, symbols]) => {
        const client = this.o.engine?.clientFor(exchange);
        if (!client || !client.has['fetchFundingRateHistory']) return;
        for (const symbol of symbols) {
          try {
            rows += await this.syncLeg(exchange, symbol, client);
          } catch (err) {
            failed++;
            if (failed <= 5) {
              this.o.log.warn(
                { exchange, symbol, err: String(err).slice(0, 120) },
                'фандинг: история не загрузилась',
              );
            }
          }
        }
      }),
    );
    this.cache.clear();
    this.o.log.info(
      `фандинг: история обновлена, +${rows} ставок, ошибок ${failed}, ${Math.round((Date.now() - t0) / 1000)} с`,
    );
    this.running = false;
  }

  private async syncLeg(
    exchange: ExchangeId,
    symbol: string,
    client: NonNullable<ReturnType<MarketEngine['clientFor']>>,
  ): Promise<number> {
    const latest = this.o.store.latestFundingTs(exchange, symbol);
    let since = latest !== null ? latest + 1 : Date.now() - this.o.backfillDays * 86_400_000;
    let total = 0;
    // Постранично: биржи отдают 100–1000 записей за раз; 180 дней по 8 ч — 540.
    for (let page = 0; page < 12; page++) {
      const batch = (await client.fetchFundingRateHistory(symbol, since, 500)) as {
        timestamp?: number;
        fundingRate?: number;
      }[];
      const rows: FundingRateRow[] = [];
      for (const r of batch) {
        if (typeof r.timestamp !== 'number' || typeof r.fundingRate !== 'number') continue;
        if (r.timestamp <= since - 1) continue;
        rows.push({ exchange, symbol, ts: r.timestamp, rate: r.fundingRate });
      }
      if (rows.length === 0) break;
      this.o.store.writeFundingRates(rows);
      total += rows.length;
      const last = rows[rows.length - 1]!.ts;
      if (rows.length < 50 || last <= since) break;
      since = last + 1;
    }
    return total;
  }

  /** Разбивка по корзинам времени — для таблицы и столбиков на экране монеты. */
  breakdown(legs: { exchange: ExchangeId; symbol: string }[], period: FundingPeriod): FundingBreakdown {
    const bucket = FUNDING_BUCKET[period];
    const to = Date.now();
    const from = to - PERIOD_MS[period];
    const byTs = new Map<number, Partial<Record<ExchangeId, number>>>();
    for (const leg of legs) {
      for (const r of this.o.store.queryFundingRates(leg.exchange, leg.symbol, from, to)) {
        // По выплатам биржи расходятся на минуты — сводим к 5 минутам, чтобы строки совпали.
        const ts = bucket === 'payout' ? Math.round(r.ts / 300_000) * 300_000 : Math.floor(r.ts / BUCKET_MS[bucket]) * BUCKET_MS[bucket];
        const row = byTs.get(ts) ?? {};
        row[leg.exchange] = (row[leg.exchange] ?? 0) + r.rate * 100;
        byTs.set(ts, row);
      }
    }
    return {
      bucket,
      rows: [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, rates]) => ({ ts, rates })),
    };
  }

  /** Агрегаты по всем ногам монеты за период. */
  aggregate(
    legs: { exchange: ExchangeId; symbol: string }[],
    period: FundingPeriod,
  ): FundingAggregate[] {
    const key = legs.map((l) => `${l.exchange}:${l.symbol}`).join('|') + '|' + period;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.value;

    const to = Date.now();
    const from = to - PERIOD_MS[period];
    const out: FundingAggregate[] = [];
    for (const leg of legs) {
      const rows = this.o.store.queryFundingRates(leg.exchange, leg.symbol, from, to);
      if (rows.length === 0) continue;
      const sum = rows.reduce((s, r) => s + r.rate, 0);
      out.push({
        exchange: leg.exchange,
        symbol: leg.symbol,
        longPct: -sum * 100,
        shortPct: sum * 100,
        payouts: rows.length,
        avgRatePct: (sum / rows.length) * 100,
      });
    }
    this.cache.set(key, { at: Date.now(), value: out });
    return out;
  }
}
