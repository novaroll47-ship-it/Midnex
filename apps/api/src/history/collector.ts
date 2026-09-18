/**
 * Сборщик истории: раз в секунду снимает состояние скринера и пишет его в
 * хранилище.
 *
 * Что пишется:
 * - сырые точки (тики) — по парам, где спред выше порога HISTORY_TICK_MIN_SPREAD:
 *   именно эти моменты интересны для анализа, а писать все 900 пар каждую
 *   секунду бессмысленно и дорого;
 * - минутные свечи — по всем живым парам: копятся в памяти и сбрасываются
 *   по закрытию минуты, так запись идёт одной транзакцией раз в минуту;
 * - раз в час — свёртка 1m → 5m/1h, раз в сутки — retention.
 *
 * Дыры: старт процесса, переход биржи на REST и обрывы регистрируются как
 * gap, чтобы потом отличать «спреда не было» от «данных не было».
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ExchangeId, SpreadRow } from '@cs/shared';

import type { MarketSource } from '../market.js';
import type { GapReason, HistoryStore, SpreadCandle, SpreadTick } from './store.js';

export interface CollectorOptions {
  store: HistoryStore;
  market: MarketSource;
  log: FastifyBaseLogger;
  /** Порог спреда для записи сырых точек, %. */
  tickMinSpreadPct: number;
  /** Сколько дней хранить сырые точки. */
  rawDays: number;
  /** Сколько дней хранить минутные свечи (5m/1h — бессрочно). */
  minuteDays: number;
}

const MINUTE = 60_000;

type Bucket = { key: string; candle: SpreadCandle };

export class HistoryCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private buckets = new Map<string, Bucket>();
  private currentMinute = 0;
  private lastRollupHour = 0;
  private lastRetentionDay = 0;
  private startGapId: number | null = null;
  private readonly openGaps = new Map<ExchangeId, number>();
  private wasLive = false;

  constructor(private readonly o: CollectorOptions) {}

  start(): void {
    if (this.timer) return;
    // Со времени последней записи до сейчас данных не было — это дыра.
    const last = this.o.store.lastCandleAt();
    this.startGapId = this.o.store.openGap({
      fromTs: last ?? Date.now(),
      exchange: 'all',
      reason: 'process_start',
    });
    this.timer = setInterval(() => this.tick(), 1000);
    this.o.log.info(
      `история: сборщик запущен (тики от ${this.o.tickMinSpreadPct}%, сырые ${this.o.rawDays} дн., 1m ${this.o.minuteDays} дн.)`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flushMinute(Date.now());
  }

  /** Незакрытая минутная свеча монеты — чтобы график не отставал на минуту. */
  current(base: string): SpreadCandle | null {
    const b = this.buckets.get(base);
    return b ? { ...b.candle } : null;
  }

  /** Биржа перестала давать данные — открыть дыру (одну на биржу). */
  gapOpen(exchange: ExchangeId, reason: GapReason): void {
    if (this.openGaps.has(exchange)) return;
    try {
      this.openGaps.set(exchange, this.o.store.openGap({ fromTs: Date.now(), exchange, reason }));
    } catch (err) {
      this.o.log.warn({ err: String(err) }, 'история: не записал дыру');
    }
  }

  /** Биржа снова даёт данные — закрыть дыру. */
  gapClose(exchange: ExchangeId): void {
    const id = this.openGaps.get(exchange);
    if (id === undefined) return;
    this.openGaps.delete(exchange);
    try {
      this.o.store.closeGap(id, Date.now());
    } catch (err) {
      this.o.log.warn({ err: String(err) }, 'история: не закрыл дыру');
    }
  }

  // ---------------------------------------------------------------- тик

  private tick(): void {
    const now = Date.now();
    try {
      if (!this.o.market.live()) return;
      if (!this.wasLive) {
        this.wasLive = true;
        if (this.startGapId !== null) {
          this.o.store.closeGap(this.startGapId, now);
          this.startGapId = null;
        }
      }

      const minute = Math.floor(now / MINUTE) * MINUTE;
      if (this.currentMinute && minute !== this.currentMinute) this.flushMinute(this.currentMinute);
      this.currentMinute = minute;

      const rows = this.o.market.snapshot(0).rows;
      const ticks: SpreadTick[] = [];
      for (const r of rows) {
        if (r.stale || r.suspect) continue;
        this.accumulate(r, minute);
        if (r.spreadPct >= this.o.tickMinSpreadPct) {
          ticks.push({
            ts: now,
            base: r.base,
            exA: r.longExchange,
            exB: r.shortExchange,
            priceA: r.longPrice,
            priceB: r.shortPrice,
            spreadPct: r.spreadPct,
            source: 'live',
          });
        }
      }
      this.o.store.writeTicks(ticks);
      this.followExchangeGaps();

      const hour = Math.floor(now / 3_600_000);
      if (hour !== this.lastRollupHour) {
        this.lastRollupHour = hour;
        // Сворачиваем прошлый час целиком плюс текущий — идемпотентно.
        this.o.store.rollup(now - 2 * 3_600_000, now);
      }
      const day = Math.floor(now / 86_400_000);
      if (day !== this.lastRetentionDay) {
        this.lastRetentionDay = day;
        this.o.store.retention(this.o.rawDays, this.o.minuteDays);
      }
    } catch (err) {
      this.o.log.warn({ err: String(err) }, 'история: сбой записи');
    }
  }

  /**
   * Свеча — одна на монету в минуту: OHLC по лучшему спреду, а пара бирж —
   * та, на которой в эту минуту спред был максимальным. Ключ по паре дал бы
   * по 2–3 свечи на монету в минуту и в сумме гигабайты в месяц.
   */
  private accumulate(r: SpreadRow, minute: number): void {
    const b = this.buckets.get(r.base);
    if (!b) {
      this.buckets.set(r.base, {
        key: r.base,
        candle: {
          ts: minute,
          base: r.base,
          exA: r.longExchange,
          exB: r.shortExchange,
          open: r.spreadPct,
          high: r.spreadPct,
          low: r.spreadPct,
          close: r.spreadPct,
          samples: 1,
          source: 'live',
        },
      });
      return;
    }
    const c = b.candle;
    if (r.spreadPct > c.high) {
      c.high = r.spreadPct;
      c.exA = r.longExchange;
      c.exB = r.shortExchange;
    }
    c.low = Math.min(c.low, r.spreadPct);
    c.close = r.spreadPct;
    c.samples++;
  }

  private flushMinute(minute: number): void {
    if (this.buckets.size === 0) return;
    const rows = [...this.buckets.values()].map((b) => ({ ...b.candle, ts: minute }));
    this.buckets = new Map();
    try {
      this.o.store.writeCandles('1m', rows);
    } catch (err) {
      this.o.log.warn({ err: String(err) }, 'история: минутные свечи не записаны');
    }
  }

  /**
   * Дыры по биржам — по статусу движка: биржа в состоянии down/reconnecting
   * или без обновлений дольше 20 с считается молчащей.
   */
  private followExchangeGaps(): void {
    const status = this.o.market.status();
    if (!status) return;
    const now = Date.now();
    for (const f of status.feeds) {
      // Молчание — это отсутствие тиков, а не надпись в статусе: биржа в
      // «reconnecting» с живыми котировками дырой не считается.
      const silent =
        f.status === 'down' || (f.lastUpdateAt !== null && now - f.lastUpdateAt > 20_000);
      if (silent) {
        this.gapOpen(f.exchange, f.mode === 'rest' ? 'rest_error' : 'ws_stall');
      } else if (f.lastUpdateAt !== null) {
        this.gapClose(f.exchange);
      }
    }
  }
}
