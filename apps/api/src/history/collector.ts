/**
 * Сборщик истории: раз в секунду снимает состояние скринера и пишет его в
 * хранилище.
 *
 * Что пишется:
 * - посекундные точки — в VictoriaMetrics (таймфрейм «1с», retention 7 дней);
 *   в SQLite сырые тики больше не пишутся — таблица spread_ticks весила
 *   полгигабайта и никем не читалась;
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
import type { VictoriaMetrics } from './victoria.js';
import type { GapReason, HistoryStore, PairTimeframe, SpreadCandle } from './store.js';

export interface CollectorOptions {
  store: HistoryStore;
  market: MarketSource;
  log: FastifyBaseLogger;
  /** Посекундный спред — в VictoriaMetrics (таймфрейм «1с»). */
  victoria: VictoriaMetrics;
  /** Порог спреда для записи сырых точек, %. */
  /** Сколько дней хранить сырые точки. */
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
      `история: сборщик запущен (1m ${this.o.minuteDays} дн., посекундно — VictoriaMetrics)`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flushMinute(Date.now());
    this.flushPairs('15m');
    this.flushPairs('1h');
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
      for (const r of rows) {
        if (r.stale || r.suspect) continue;
        this.accumulate(r, minute);
      }
      const pairSpreads = this.o.market.engine?.pairSpreads() ?? [];
      this.accumulatePairs(now, pairSpreads);
      this.o.victoria.write(now, rows, pairSpreads);
      this.followExchangeGaps();

      // Незакрытые 15m/1h по парам — в базу раз в минуту (insert or replace):
      // иначе жёсткий перезапуск терял бы до часа накопленного.
      const minuteNo = Math.floor(now / MINUTE);
      if (minuteNo !== this.lastPairSnapshotMinute) {
        this.lastPairSnapshotMinute = minuteNo;
        this.snapshotPairs();
      }

      const hour = Math.floor(now / 3_600_000);
      if (hour !== this.lastRollupHour) {
        this.lastRollupHour = hour;
        // Сворачиваем прошлый час целиком плюс текущий — идемпотентно.
        this.o.store.rollup(now - 2 * 3_600_000, now);
      }
      const day = Math.floor(now / 86_400_000);
      if (day !== this.lastRetentionDay) {
        this.lastRetentionDay = day;
        this.o.store.retention(this.o.minuteDays);
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

  // ---------------------------------------------------------------- по парам

  /**
   * Свечи по каждой сверенной паре: 15m и 1h. Пар около четырнадцати тысяч,
   * поэтому таймфреймы крупнее, чем у свечей «лучшая пара монеты», а
   * накопление — в памяти с записью раз в 15 минут / раз в час.
   */
  private pairBuckets: Record<PairTimeframe, Map<string, SpreadCandle>> = {
    '15m': new Map(),
    '1h': new Map(),
  };
  private pairBucketStart: Record<PairTimeframe, number> = { '15m': 0, '1h': 0 };
  private static readonly PAIR_TF_MS: Record<PairTimeframe, number> = {
    '15m': 900_000,
    '1h': 3_600_000,
  };

  private accumulatePairs(
    now: number,
    spreads: { base: string; exA: ExchangeId; exB: ExchangeId; spreadPct: number }[],
  ): void {
    for (const tf of ['15m', '1h'] as PairTimeframe[]) {
      const ms = HistoryCollector.PAIR_TF_MS[tf];
      const start = Math.floor(now / ms) * ms;
      if (this.pairBucketStart[tf] && start !== this.pairBucketStart[tf]) this.flushPairs(tf);
      this.pairBucketStart[tf] = start;
      const buckets = this.pairBuckets[tf];
      for (const p of spreads) {
        const key = `${p.base}|${p.exA}|${p.exB}`;
        const c = buckets.get(key);
        if (!c) {
          buckets.set(key, {
            ts: start,
            base: p.base,
            exA: p.exA,
            exB: p.exB,
            open: p.spreadPct,
            high: p.spreadPct,
            low: p.spreadPct,
            close: p.spreadPct,
            samples: 1,
            source: 'live',
          });
          continue;
        }
        if (p.spreadPct > c.high) c.high = p.spreadPct;
        if (p.spreadPct < c.low) c.low = p.spreadPct;
        c.close = p.spreadPct;
        c.samples++;
      }
    }
  }

  private lastPairSnapshotMinute = 0;

  private snapshotPairs(): void {
    for (const tf of ['15m', '1h'] as PairTimeframe[]) {
      const rows = [...this.pairBuckets[tf].values()];
      if (rows.length === 0) continue;
      try {
        this.o.store.writePairCandles(tf, rows);
      } catch (err) {
        this.o.log.warn({ err: String(err) }, `история: промежуточные свечи пар ${tf} не записаны`);
      }
    }
  }

  private flushPairs(tf: PairTimeframe): void {
    const rows = [...this.pairBuckets[tf].values()];
    this.pairBuckets[tf] = new Map();
    if (rows.length === 0) return;
    try {
      this.o.store.writePairCandles(tf, rows);
    } catch (err) {
      this.o.log.warn({ err: String(err) }, `история: свечи по парам ${tf} не записаны`);
    }
  }

  /** Незакрытая свеча пары — чтобы график не отставал. */
  currentPair(
    base: string,
    exA: ExchangeId,
    exB: ExchangeId,
    tf: PairTimeframe,
  ): SpreadCandle | null {
    const c = this.pairBuckets[tf].get(`${base}|${exA}|${exB}`);
    return c ? { ...c } : null;
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
