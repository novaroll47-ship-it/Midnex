/**
 * Дозаполнение дыр в истории по свечам бирж.
 *
 * Пока процесс не работал (перезапуск, обрыв сети), живых свечей нет.
 * Раз в полчаса смотрим на последние двое суток: часы без свечи по монете
 * восстанавливаем из часовых закрытий бирж — так же, как разовый backfill,
 * только по узкому окну и только там, где пусто. Заодно пишем часовые
 * свечи по каждой сверенной паре за те же часы. Всё помечено
 * source=reconstructed: на графике это пунктир.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ExchangeId } from '@cs/shared';
import { pairKey, type MarketEngine } from '@cs/market';

import type { HistoryStore, SpreadCandle } from './store.js';

const HOUR = 3_600_000;
const WINDOW_HOURS = 48;
const EVERY_MS = 30 * 60_000;
const FIRST_RUN_DELAY_MS = 90_000;

export class GapFiller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly o: {
      store: HistoryStore;
      engine: MarketEngine | null;
      log: FastifyBaseLogger;
    },
  ) {}

  start(): void {
    if (this.timer || !this.o.engine) return;
    setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS);
    this.timer = setInterval(() => void this.run(), EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Дозаполнение по одной монете по запросу графика — не чаще раза в 10 минут на монету. */
  private readonly askedAt = new Map<string, number>();

  fillBase(base: string): void {
    const now = Date.now();
    if (now - (this.askedAt.get(base) ?? 0) < 10 * 60_000) return;
    this.askedAt.set(base, now);
    void this.run([base]);
  }

  async run(only?: string[]): Promise<void> {
    const engine = this.o.engine;
    if (!engine || (this.running && !only)) return;
    if (!only) this.running = true;
    const t0 = Date.now();
    let coins = 0;
    let hours = 0;
    let requests = 0;
    try {
      const now = Date.now();
      const lastFull = Math.floor(now / HOUR) * HOUR - HOUR; // текущий час ещё не закрыт
      const from = lastFull - (WINDOW_HOURS - 1) * HOUR;
      for (const base of only ?? engine.bases()) {
        const have = new Set(
          this.o.store.queryCandles(base, '1h', from, lastFull + HOUR).map((c) => c.ts),
        );
        const missing: number[] = [];
        for (let ts = from; ts <= lastFull; ts += HOUR) if (!have.has(ts)) missing.push(ts);
        if (missing.length === 0) continue;

        const since = missing[0]!;
        const legs = engine.legsWithMultiplier(base);
        const series: { exchange: ExchangeId; data: Map<number, [number, number]> }[] = [];
        await Promise.all(
          legs.map(async (leg) => {
            const client = engine.clientFor(leg.exchange);
            if (!client) return;
            try {
              requests++;
              const rows = (await client.fetchOHLCV(
                leg.symbol,
                '1h',
                since,
                WINDOW_HOURS + 2,
              )) as number[][];
              // [открытие, закрытие] часа — чтобы у восстановленной свечи было тело.
              const data = new Map<number, [number, number]>();
              for (const r of rows) {
                const ts = Math.floor(r[0]! / HOUR) * HOUR;
                const o = typeof r[1] === 'number' && r[1] > 0 ? r[1] : r[4];
                if (typeof r[4] === 'number' && r[4] > 0) {
                  data.set(ts, [(o as number) / leg.multiplier, r[4] / leg.multiplier]);
                }
              }
              if (data.size) series.push({ exchange: leg.exchange, data });
            } catch (err) {
              this.o.log.debug(
                { base, exchange: leg.exchange, err: String(err).slice(0, 80) },
                'дозаполнение: свечи не получены',
              );
            }
          }),
        );
        if (series.length < 2) continue;

        const allowed = engine.pairsOf(base).map((p) => pairKey(p.exA, p.exB));
        const allowedSet = new Set(allowed);
        const coinRows: SpreadCandle[] = [];
        const pairRows: SpreadCandle[] = [];
        for (const ts of missing) {
          let best: { exA: ExchangeId; exB: ExchangeId; spread: number; open: number } | null = null;
          for (let i = 0; i < series.length; i++) {
            for (let j = i + 1; j < series.length; j++) {
              const a = series[i]!;
              const b = series[j]!;
              const ca = a.data.get(ts);
              const cb = b.data.get(ts);
              if (ca === undefined || cb === undefined) continue;
              const key = pairKey(a.exchange, b.exchange);
              if (allowedSet.size && !allowedSet.has(key)) continue;
              const [pa, pb] = [ca[1], cb[1]];
              const openSpread = (Math.abs(ca[0] - cb[0]) / Math.min(ca[0], cb[0])) * 100;
              const spread = (Math.abs(pa - pb) / Math.min(pa, pb)) * 100;
              const [exA, exB] = key.split('|') as [ExchangeId, ExchangeId];
              pairRows.push({
                ts,
                base,
                exA,
                exB,
                open: openSpread,
                high: Math.max(openSpread, spread),
                low: Math.min(openSpread, spread),
                close: spread,
                samples: 1,
                source: 'reconstructed',
              });
              if (!best || spread > best.spread) {
                best =
                  pa < pb
                    ? { exA: a.exchange, exB: b.exchange, spread, open: openSpread }
                    : { exA: b.exchange, exB: a.exchange, spread, open: openSpread };
              }
            }
          }
          if (best) {
            coinRows.push({
              ts,
              base,
              exA: best.exA,
              exB: best.exB,
              open: best.open,
              high: Math.max(best.open, best.spread),
              low: Math.min(best.open, best.spread),
              close: best.spread,
              samples: 1,
              source: 'reconstructed',
            });
          }
        }
        if (coinRows.length) {
          this.o.store.writeCandles('1h', coinRows);
          this.o.store.writePairCandles('1h', pairRows);
          coins++;
          hours += coinRows.length;
        }
      }
      if (coins) {
        this.o.log.info(
          `дозаполнение: монет ${coins}, часов ${hours}, запросов ${requests}, ${Math.round((Date.now() - t0) / 1000)} с`,
        );
      }
    } catch (err) {
      this.o.log.warn({ err: String(err).slice(0, 200) }, 'дозаполнение: сбой');
    } finally {
      if (!only) this.running = false;
    }
  }
}
