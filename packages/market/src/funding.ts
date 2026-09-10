/**
 * Ставки фандинга.
 *
 * Обновляются раз в минуту REST-запросом — чаще незачем: ставка меняется
 * плавно, а выплата раз в восемь часов. Там, где биржа не отдаёт ставки
 * одним запросом (MEXC, KuCoin), фандинг помечается неизвестным и в расчёт
 * чистого профита не входит. Это честнее, чем подставить ноль и выдать его
 * за знание.
 */
import type { Exchange } from 'ccxt';
import type { ExchangeId } from '@cs/shared';

import type { FeedLogger } from './feed.js';
import type { VenueMarket } from './universe.js';

export interface FundingInfo {
  /** Ставка за период, доля (0.0001 = 0.01%). */
  rate: number;
  /** Следующая выплата, мс epoch. */
  nextAt: number | null;
  updatedAt: number;
}

export class FundingTracker {
  private readonly rates = new Map<string, FundingInfo>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Биржи, где ставки получить не удаётся — чтобы не долбить их впустую. */
  readonly unsupported = new Set<ExchangeId>();

  constructor(
    private readonly clients: Map<ExchangeId, Exchange>,
    private readonly markets: Map<ExchangeId, VenueMarket[]>,
    private readonly log: FeedLogger,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(exchange: ExchangeId, symbol: string): FundingInfo | undefined {
    return this.rates.get(`${exchange}:${symbol}`);
  }

  private async refreshAll(): Promise<void> {
    await Promise.all([...this.clients].map(([id, ex]) => this.refresh(id, ex)));
  }

  private async refresh(id: ExchangeId, ex: Exchange): Promise<void> {
    if (this.unsupported.has(id)) return;
    if (!ex.has['fetchFundingRates']) {
      this.unsupported.add(id);
      this.log.info(`${id}: биржа не отдаёт ставки фандинга списком — фандинг для неё неизвестен`);
      return;
    }

    try {
      const symbols = (this.markets.get(id) ?? []).map((m) => m.symbol);
      const all = await ex.fetchFundingRates(symbols);
      const now = Date.now();
      for (const [symbol, fr] of Object.entries(all)) {
        const rate = typeof fr.fundingRate === 'number' ? fr.fundingRate : undefined;
        if (rate === undefined) continue;
        this.rates.set(`${id}:${symbol}`, {
          rate,
          nextAt: typeof fr.fundingTimestamp === 'number' ? fr.fundingTimestamp : null,
          updatedAt: now,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`${id}: не получил ставки фандинга (${message.slice(0, 80)})`);
    }
  }
}
