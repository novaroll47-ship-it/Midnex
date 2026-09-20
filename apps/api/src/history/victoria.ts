/**
 * Посекундный спред в VictoriaMetrics — для таймфрейма «1с» на графике.
 *
 * Раз в секунду сборщик отдаёт сюда спред лучшей пары по каждой монете
 * (`midnex_spread_best{base,exA,exB}`) и, если включено, спред по каждой
 * сверенной паре бирж (`midnex_spread_pair{base,exA,exB}`). Точки копятся
 * и раз в секунду улетают одним сжатым POST в Metrics Ingestion API
 * (`/api/v1/import/prometheus`, формат Prometheus с меткой времени в мс).
 * Чтение — `/api/v1/export`: сырые точки за интервал, без интерполяции.
 *
 * Хранение и retention — на стороне VictoriaMetrics (`-retentionPeriod=7d`,
 * см. deploy/run-local.ps1). Если VM недоступна, точки копятся недолго и
 * отбрасываются: история спредов в SQLite от этого не зависит, а график
 * «1с» просто покажет пропуск.
 */
import { gzipSync } from 'node:zlib';
import type { FastifyBaseLogger } from 'fastify';
import type { ExchangeId, SpreadRow } from '@cs/shared';

/** Больше стольких секунд очереди не держим, если VM не отвечает. */
const MAX_QUEUE_BATCHES = 30;
/** Как часто ругаться в лог о недоступной VM. */
const WARN_EVERY_MS = 5 * 60_000;

export interface SecondsSeries {
  /** Время первой точки, мс epoch (кратно секунде). */
  ts0: number;
  stepMs: 1000;
  /** Значения спреда по секундам; null — данных не было. */
  values: (number | null)[];
  /** Пары бирж для монеты: индекс в `pairs` на каждую секунду (null — нет). */
  pairIdx?: (number | null)[];
  pairs?: { exA: ExchangeId; exB: ExchangeId }[];
}

interface ExportLine {
  metric: Record<string, string>;
  values: number[];
  timestamps: number[];
}

export class VictoriaMetrics {
  private queue: string[][] = [];
  private flushing = false;
  private lastWarnAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly writePairs: boolean,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), 1000);
    this.timer.unref();
    void this.ping();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.flush();
  }

  private async ping(): Promise<void> {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.log.info(`victoria: доступна по ${this.url}, пары ${this.writePairs ? 'пишутся' : 'не пишутся'}`);
    } catch (err) {
      this.warn(`victoria: недоступна по ${this.url} (${String(err)}) — график «1с» будет без данных`);
    }
  }

  /** Записать одну секунду: спред лучшей пары по монетам и спреды по парам. */
  write(
    now: number,
    rows: SpreadRow[],
    pairs: { base: string; exA: ExchangeId; exB: ExchangeId; spreadPct: number }[],
  ): void {
    const ts = Math.floor(now / 1000) * 1000;
    const lines: string[] = [];
    for (const r of rows) {
      if (r.stale || r.suspect) continue;
      lines.push(
        `midnex_spread_best{base="${r.base}",exA="${r.longExchange}",exB="${r.shortExchange}"} ${r.spreadPct} ${ts}`,
      );
    }
    if (this.writePairs) {
      for (const p of pairs) {
        lines.push(`midnex_spread_pair{base="${p.base}",exA="${p.exA}",exB="${p.exB}"} ${p.spreadPct} ${ts}`);
      }
    }
    if (lines.length === 0) return;
    this.queue.push(lines);
    if (this.queue.length > MAX_QUEUE_BATCHES) this.queue.shift();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batches = this.queue;
    this.queue = [];
    try {
      const body = gzipSync(batches.map((b) => b.join('\n')).join('\n') + '\n');
      const res = await fetch(`${this.url}/api/v1/import/prometheus`, {
        method: 'POST',
        headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Не дошло — вернём в очередь (в пределах лимита), попробуем через секунду.
      this.queue = [...batches, ...this.queue].slice(-MAX_QUEUE_BATCHES);
      this.warn(`victoria: запись не удалась (${String(err)})`);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Посекундная серия по монете (лучшая пара) или по конкретной паре бирж.
   * У монеты пара со временем меняется — это разные серии VM, сливаем их
   * по времени в одну.
   */
  async querySeconds(
    base: string,
    from: number,
    to: number,
    pair?: { exA: ExchangeId; exB: ExchangeId },
  ): Promise<SecondsSeries | null> {
    const match = pair
      ? `midnex_spread_pair{base="${base}",exA="${pair.exA}",exB="${pair.exB}"}`
      : `midnex_spread_best{base="${base}"}`;
    const qs = new URLSearchParams({
      'match[]': match,
      start: String(Math.floor(from / 1000)),
      end: String(Math.ceil(to / 1000)),
    });
    let text: string;
    try {
      const res = await fetch(`${this.url}/api/v1/export?${qs}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      this.warn(`victoria: чтение не удалось (${String(err)})`);
      return null;
    }

    const bySec = new Map<number, { v: number; pair: number }>();
    const pairs: { exA: ExchangeId; exB: ExchangeId }[] = [];
    const pairIndex = new Map<string, number>();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row: ExportLine;
      try {
        row = JSON.parse(line) as ExportLine;
      } catch {
        continue;
      }
      const key = `${row.metric['exA']}|${row.metric['exB']}`;
      let idx = pairIndex.get(key);
      if (idx === undefined) {
        idx = pairs.length;
        pairIndex.set(key, idx);
        pairs.push({ exA: row.metric['exA'] as ExchangeId, exB: row.metric['exB'] as ExchangeId });
      }
      for (let i = 0; i < row.timestamps.length; i++) {
        const sec = Math.floor(row.timestamps[i]! / 1000);
        const v = row.values[i]!;
        if (!Number.isFinite(v)) continue;
        bySec.set(sec, { v, pair: idx });
      }
    }
    if (bySec.size === 0) return null;

    let minSec = Infinity;
    let maxSec = -Infinity;
    for (const sec of bySec.keys()) {
      if (sec < minSec) minSec = sec;
      if (sec > maxSec) maxSec = sec;
    }
    const n = maxSec - minSec + 1;
    const values: (number | null)[] = new Array(n).fill(null);
    const pairIdx: (number | null)[] = new Array(n).fill(null);
    for (const [sec, p] of bySec) {
      values[sec - minSec] = Math.round(p.v * 10_000) / 10_000;
      pairIdx[sec - minSec] = p.pair;
    }
    return pair
      ? { ts0: minSec * 1000, stepMs: 1000, values }
      : { ts0: minSec * 1000, stepMs: 1000, values, pairIdx, pairs };
  }

  private warn(msg: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = now;
    this.log.warn(msg);
  }
}
