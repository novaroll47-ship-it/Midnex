/**
 * Backfill: реконструкция истории спредов по свечам бирж.
 *
 *   npm run backfill -w @cs/api -- [--tf 1h] [--days 180] [--base BTC] [--force]
 *
 * По каждой сверенной монете берём закрытия свечей всех её ног и на каждый
 * совпадающий таймстемп считаем лучший спред между биржами. Это оценка, а
 * не измерение: таймстемпы бирж совпадают с точностью до свечи, а короткие
 * всплески внутри свечи не видны. Все записи помечены source=reconstructed
 * и никогда не перекрывают живые.
 *
 * Почему часовые свечи, а не минутные: 180 дней по минутам — 260 тысяч
 * свечей на ногу, у Gate минутная история и вовсе ограничена неделей.
 * Часовые за полгода — 4320 на ногу, это несколько страниц; минутные
 * копятся живым сборщиком с момента запуска.
 *
 * Прогресс — в таблице backfill_progress: перезапуск продолжает с места
 * остановки; --force пересчитывает заново.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ccxt, { type Exchange } from 'ccxt';
import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import type { ExchangeId } from '@cs/shared';

import { SqliteHistoryStore } from '../history/sqlite.js';
import type { SpreadCandle, Timeframe } from '../history/store.js';
import { createRepo } from '../repo/index.js';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, '../../../../.env') });

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--'))
    args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') ? '1' : (process.argv[++i] ?? '1'));
}
const TF = (args.get('tf') ?? '1h') as Timeframe;
const DAYS = Number(args.get('days') ?? 180);
const ONLY_BASE = args.get('base')?.toUpperCase();
const FORCE = args.has('force');
const TF_MS: Record<Timeframe, number> = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000 };
const PAGE = 1000;

const CCXT_ID: Record<ExchangeId, string> = {
  binance: 'binance',
  bybit: 'bybit',
  okx: 'okx',
  mexc: 'mexc',
  bitget: 'bitget',
  bingx: 'bingx',
  gate: 'gate',
  kucoin: 'kucoinfutures',
};

const log = {
  info: (m: string) => console.log(new Date().toISOString().slice(11, 19), m),
  warn: (m: string) => console.warn(new Date().toISOString().slice(11, 19), 'WARN', m),
  error: (m: string) => console.error(new Date().toISOString().slice(11, 19), 'ERR', m),
  child: () => log,
} as unknown as import('fastify').FastifyBaseLogger;

const historyPath =
  process.env.HISTORY_DB_PATH?.trim() || join(here, '../../../../.data', 'history.sqlite');
const store = new SqliteHistoryStore(historyPath);
const progress = new DatabaseSync(historyPath);
progress.exec('pragma busy_timeout = 5000');
progress.exec(`create table if not exists backfill_progress (
  base text not null, tf text not null, done_until integer not null, updated_at integer not null,
  primary key (base, tf)
)`);

const repo = await createRepo(log);
const legsAll = (await repo.listVerifiedSymbols()).filter((l) => l.status === 'verified');
const byBase = new Map<string, typeof legsAll>();
for (const l of legsAll) byBase.set(l.base, [...(byBase.get(l.base) ?? []), l]);
const bases = [...byBase.entries()]
  .filter(([base, legs]) => legs.length >= 2 && (!ONLY_BASE || base === ONLY_BASE))
  .map(([base]) => base)
  .sort();

const clients = new Map<ExchangeId, Exchange>();
function clientFor(id: ExchangeId): Exchange {
  let c = clients.get(id);
  if (!c) {
    const Ctor = (ccxt as unknown as Record<string, new (cfg: object) => Exchange>)[CCXT_ID[id]]!;
    c = new Ctor({ enableRateLimit: true, timeout: 30_000, options: { defaultType: 'swap' } });
    clients.set(id, c);
  }
  return c;
}

const now = Date.now();
const from = Math.floor((now - DAYS * 86_400_000) / TF_MS[TF]) * TF_MS[TF];
log.info(
  `backfill ${TF} за ${DAYS} дн.: монет ${bases.length}, ног ${legsAll.length}, файл ${historyPath}`,
);

/** Закрытия одной ноги по таймстемпам, постранично. */
async function closes(id: ExchangeId, symbol: string, since: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const client = clientFor(id);
  let cursor = since;
  for (let page = 0; page < 400 && cursor < now; page++) {
    let rows: number[][];
    try {
      rows = (await client.fetchOHLCV(symbol, TF, cursor, PAGE)) as number[][];
    } catch (err) {
      const msg = String(err);
      if (/too long ago|out of range|Invalid time/i.test(msg)) {
        // Биржа не хранит так глубоко — начинаем с того, что есть.
        cursor += 7 * 86_400_000;
        continue;
      }
      throw err;
    }
    if (rows.length === 0) break;
    let last = cursor;
    for (const r of rows) {
      const ts = Math.floor(r[0]! / TF_MS[TF]) * TF_MS[TF];
      if (ts >= since && typeof r[4] === 'number') out.set(ts, r[4]);
      if (r[0]! > last) last = r[0]!;
    }
    if (last <= cursor) break;
    cursor = last + 1;
    if (rows.length < 50) break;
  }
  return out;
}

let done = 0;
for (const base of bases) {
  const legs = byBase.get(base)!;
  const prev = progress
    .prepare('select done_until from backfill_progress where base = ? and tf = ?')
    .get(base, TF) as { done_until: number } | undefined;
  if (prev && !FORCE && prev.done_until >= now - TF_MS[TF] * 2) {
    done++;
    continue;
  }
  const t0 = Date.now();
  const series: { exchange: ExchangeId; data: Map<number, number> }[] = [];
  await Promise.all(
    legs.map(async (leg) => {
      try {
        const data = await closes(leg.exchange, leg.symbol, from);
        // Приводим к одной монете: свечи биржи — за контракт с множителем.
        if (leg.multiplier !== 1) for (const [k, v] of data) data.set(k, v / leg.multiplier);
        if (data.size) series.push({ exchange: leg.exchange, data });
      } catch (err) {
        log.warn(`${base} ${leg.exchange}: ${String(err).slice(0, 100)}`);
      }
    }),
  );
  if (series.length < 2) {
    progress
      .prepare('insert or replace into backfill_progress values (?, ?, ?, ?)')
      .run(base, TF, now, now);
    done++;
    continue;
  }

  // На каждый таймстемп — лучшая пара: лонг там, где дешевле, шорт — где дороже.
  const stamps = new Set<number>();
  for (const s of series) for (const ts of s.data.keys()) stamps.add(ts);
  const candles: SpreadCandle[] = [];
  for (const ts of stamps) {
    let lo: { exchange: ExchangeId; price: number } | null = null;
    let hi: { exchange: ExchangeId; price: number } | null = null;
    for (const s of series) {
      const p = s.data.get(ts);
      if (p === undefined || p <= 0) continue;
      if (!lo || p < lo.price) lo = { exchange: s.exchange, price: p };
      if (!hi || p > hi.price) hi = { exchange: s.exchange, price: p };
    }
    if (!lo || !hi || lo.exchange === hi.exchange) continue;
    const spread = ((hi.price - lo.price) / lo.price) * 100;
    // Реконструкция даёт одну точку на свечу — OHLC совпадают.
    candles.push({
      ts,
      base,
      exA: lo.exchange,
      exB: hi.exchange,
      open: spread,
      high: spread,
      low: spread,
      close: spread,
      samples: 1,
      source: 'reconstructed',
    });
  }
  store.writeCandles(TF, candles);
  progress
    .prepare('insert or replace into backfill_progress values (?, ?, ?, ?)')
    .run(base, TF, now, now);
  done++;
  log.info(
    `${base}: ног ${series.length}, свечей ${candles.length}, ${Math.round((Date.now() - t0) / 1000)} с — ${done}/${bases.length}`,
  );
}

log.info('backfill завершён');
await repo.close();
store.close();
progress.close();
process.exit(0);
