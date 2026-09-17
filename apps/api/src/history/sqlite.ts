/**
 * История в SQLite через встроенный node:sqlite (Node ≥ 22.5) — без нативных
 * зависимостей, работает и в Docker на alpine. WAL, чтобы запись раз в
 * секунду не блокировала чтение графиков.
 *
 * Все таблицы «как у Timescale»: время в миллисекундах, составной ключ
 * (пара, время). Свечи старших таймфреймов — отдельные таблицы, а не
 * представления: на SQLite представление считалось бы заново при каждом
 * запросе.
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExchangeId } from '@cs/shared';

import type {
  FundingRateRow,
  HistoryStatus,
  HistoryStore,
  SpreadCandle,
  SpreadGap,
  SpreadTick,
  Timeframe,
} from './store.js';

const TF_MS: Record<Timeframe, number> = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000 };
const CANDLE_TABLE: Record<Timeframe, string> = {
  '1m': 'spread_candles_1m',
  '5m': 'spread_candles_5m',
  '1h': 'spread_candles_1h',
};

const SCHEMA = `
create table if not exists spread_ticks (
  ts integer not null, base text not null, ex_a text not null, ex_b text not null,
  price_a real not null, price_b real not null, spread_pct real not null, source text not null
);
create index if not exists spread_ticks_base_ts on spread_ticks (base, ts);
create index if not exists spread_ticks_ts on spread_ticks (ts);

create table if not exists spread_candles_1m (
  ts integer not null, base text not null, ex_a text not null, ex_b text not null,
  open real not null, high real not null, low real not null, close real not null,
  samples integer not null, source text not null,
  primary key (base, ex_a, ex_b, ts)
);
create index if not exists spread_candles_1m_ts on spread_candles_1m (ts);
create table if not exists spread_candles_5m (
  ts integer not null, base text not null, ex_a text not null, ex_b text not null,
  open real not null, high real not null, low real not null, close real not null,
  samples integer not null, source text not null,
  primary key (base, ex_a, ex_b, ts)
);
create table if not exists spread_candles_1h (
  ts integer not null, base text not null, ex_a text not null, ex_b text not null,
  open real not null, high real not null, low real not null, close real not null,
  samples integer not null, source text not null,
  primary key (base, ex_a, ex_b, ts)
);

create table if not exists spread_gaps (
  id integer primary key autoincrement,
  from_ts integer not null, to_ts integer, exchange text not null, reason text not null
);
create index if not exists spread_gaps_from on spread_gaps (from_ts);

create table if not exists funding_rates (
  exchange text not null, symbol text not null, ts integer not null, rate real not null,
  primary key (exchange, symbol, ts)
);
`;

export class SqliteHistoryStore implements HistoryStore {
  private readonly db: DatabaseSync;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'pragma journal_mode = wal; pragma synchronous = normal; pragma temp_store = memory;',
    );
    this.db.exec(SCHEMA);
  }

  // ---------------------------------------------------------------- запись

  writeTicks(rows: SpreadTick[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      'insert into spread_ticks (ts, base, ex_a, ex_b, price_a, price_b, spread_pct, source) values (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.db.exec('begin');
    try {
      for (const r of rows) {
        stmt.run(r.ts, r.base, r.exA, r.exB, r.priceA, r.priceB, r.spreadPct, r.source);
      }
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  writeCandles(tf: Timeframe, rows: SpreadCandle[]): void {
    if (rows.length === 0) return;
    // Живая свеча перекрывает реконструированную, но не наоборот.
    const stmt = this.db.prepare(
      `insert into ${CANDLE_TABLE[tf]} (ts, base, ex_a, ex_b, open, high, low, close, samples, source)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (base, ex_a, ex_b, ts) do update set
         open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
         samples = excluded.samples, source = excluded.source
       where ${CANDLE_TABLE[tf]}.source = 'reconstructed' or excluded.source = 'live'`,
    );
    this.db.exec('begin');
    try {
      for (const r of rows) {
        stmt.run(r.ts, r.base, r.exA, r.exB, r.open, r.high, r.low, r.close, r.samples, r.source);
      }
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  openGap(gap: Omit<SpreadGap, 'toTs'>): number {
    const r = this.db
      .prepare('insert into spread_gaps (from_ts, to_ts, exchange, reason) values (?, null, ?, ?)')
      .run(gap.fromTs, gap.exchange, gap.reason);
    return Number(r.lastInsertRowid);
  }

  closeGap(id: number, toTs: number): void {
    this.db
      .prepare('update spread_gaps set to_ts = ? where id = ? and to_ts is null')
      .run(toTs, id);
  }

  // ---------------------------------------------------------------- чтение

  queryCandles(
    base: string,
    tf: Timeframe,
    from: number,
    to: number,
    exA?: ExchangeId,
    exB?: ExchangeId,
  ): SpreadCandle[] {
    const table = CANDLE_TABLE[tf];
    const rows = (
      exA && exB
        ? this.db
            .prepare(
              `select * from ${table} where base = ? and ex_a = ? and ex_b = ? and ts >= ? and ts < ? order by ts`,
            )
            .all(base, exA, exB, from, to)
        : this.db
            .prepare(`select * from ${table} where base = ? and ts >= ? and ts < ? order by ts`)
            .all(base, from, to)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      ts: Number(r['ts']),
      base: String(r['base']),
      exA: r['ex_a'] as ExchangeId,
      exB: r['ex_b'] as ExchangeId,
      open: Number(r['open']),
      high: Number(r['high']),
      low: Number(r['low']),
      close: Number(r['close']),
      samples: Number(r['samples']),
      source: r['source'] as SpreadCandle['source'],
    }));
  }

  lastCandleAt(): number | null {
    const r = this.db.prepare('select max(ts) as ts from spread_candles_1m').get() as
      { ts: number | null } | undefined;
    return r?.ts ?? null;
  }

  // ---------------------------------------------------------------- агрегаты

  /**
   * 1m → 5m и 1h за интервал. Первое open и последнее close берутся по
   * времени, а не по строке — иначе порядок вставки испортил бы свечу.
   */
  rollup(from: number, to: number): void {
    for (const tf of ['5m', '1h'] as const) {
      const bucket = TF_MS[tf];
      const start = Math.floor(from / bucket) * bucket;
      this.db
        .prepare(
          `insert into ${CANDLE_TABLE[tf]} (ts, base, ex_a, ex_b, open, high, low, close, samples, source)
           select b.bts, b.base, b.ex_a, b.ex_b,
             (select open from spread_candles_1m o where o.base = b.base and o.ex_a = b.ex_a and o.ex_b = b.ex_b and o.ts >= b.bts and o.ts < b.bts + ${bucket} order by o.ts limit 1),
             b.high, b.low,
             (select close from spread_candles_1m c where c.base = b.base and c.ex_a = b.ex_a and c.ex_b = b.ex_b and c.ts >= b.bts and c.ts < b.bts + ${bucket} order by c.ts desc limit 1),
             b.samples,
             case when b.live > 0 then 'live' else 'reconstructed' end
           from (
             select (ts / ${bucket}) * ${bucket} as bts, base, ex_a, ex_b,
               max(high) as high, min(low) as low, sum(samples) as samples,
               sum(case when source = 'live' then 1 else 0 end) as live
             from spread_candles_1m where ts >= ? and ts < ?
             group by bts, base, ex_a, ex_b
           ) b
           where true
           on conflict (base, ex_a, ex_b, ts) do update set
             open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
             samples = excluded.samples, source = excluded.source`,
        )
        .run(start, to);
    }
  }

  retention(rawDays: number, minuteDays: number): void {
    const now = Date.now();
    this.db.prepare('delete from spread_ticks where ts < ?').run(now - rawDays * 86_400_000);
    this.db
      .prepare('delete from spread_candles_1m where ts < ?')
      .run(now - minuteDays * 86_400_000);
  }

  // ---------------------------------------------------------------- фандинг

  writeFundingRates(rows: FundingRateRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      'insert or replace into funding_rates (exchange, symbol, ts, rate) values (?, ?, ?, ?)',
    );
    this.db.exec('begin');
    try {
      for (const r of rows) stmt.run(r.exchange, r.symbol, r.ts, r.rate);
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  latestFundingTs(exchange: ExchangeId, symbol: string): number | null {
    const r = this.db
      .prepare('select max(ts) as ts from funding_rates where exchange = ? and symbol = ?')
      .get(exchange, symbol) as { ts: number | null } | undefined;
    return r?.ts ?? null;
  }

  queryFundingRates(
    exchange: ExchangeId,
    symbol: string,
    from: number,
    to: number,
  ): FundingRateRow[] {
    const rows = this.db
      .prepare(
        'select exchange, symbol, ts, rate from funding_rates where exchange = ? and symbol = ? and ts >= ? and ts < ? order by ts',
      )
      .all(exchange, symbol, from, to) as Record<string, unknown>[];
    return rows.map((r) => ({
      exchange: r['exchange'] as ExchangeId,
      symbol: String(r['symbol']),
      ts: Number(r['ts']),
      rate: Number(r['rate']),
    }));
  }

  // ---------------------------------------------------------------- служебное

  status(): HistoryStatus {
    const count = (table: string) =>
      Number((this.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n);
    const max = (table: string) =>
      (this.db.prepare(`select max(ts) as ts from ${table}`).get() as { ts: number | null }).ts;
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(this.path).size;
    } catch {
      // Файл ещё не создан.
    }
    const dayAgo = Date.now() - 86_400_000;
    return {
      path: this.path,
      sizeBytes,
      ticks: count('spread_ticks'),
      candles1m: count('spread_candles_1m'),
      candles5m: count('spread_candles_5m'),
      candles1h: count('spread_candles_1h'),
      fundingRates: count('funding_rates'),
      lastTickAt: max('spread_ticks'),
      lastCandleAt: max('spread_candles_1m'),
      gapsLast24h: Number(
        (
          this.db
            .prepare('select count(*) as n from spread_gaps where from_ts >= ?')
            .get(dayAgo) as {
            n: number;
          }
        ).n,
      ),
    };
  }

  close(): void {
    this.db.close();
  }
}
