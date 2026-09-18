/**
 * Сверка пар: между какими ногами одной монеты спред считать можно.
 *
 * Одинаковый тикер на двух биржах ничего не доказывает: под «TA» или «BB»
 * могут торговаться разные проекты, а `1000SHIB` против `SHIB` — одна монета
 * с другим номиналом. Поэтому в ленту попадают только сверенные пары
 * (таблица verified_pairs), а множитель берётся оттуда же.
 *
 * Сверка автоматическая, раз в минуту по живым ценам:
 *  - цены совпадают в пределах допуска → auto_price;
 *  - отношение цен — стандартный множитель контракта (10…1 000 000 или
 *    обратный) в пределах допуска → auto_multiplier;
 *  - CoinGecko знает обе ноги и это один coin id → external_match
 *    (подтверждает ценовую проверку и расширяет допуск); разные id при
 *    нестандартном отношении → отклонено автоматически.
 * В ручную очередь попадают только аномалии: отношение не похоже ни на 1,
 * ни на стандартный множитель, либо цена сходится, а внешний источник
 * спорит. Сверенные автоматически пары перепроверяются: если цены разошлись
 * сильнее допуска три прохода подряд — пара возвращается в очередь.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ExchangeId } from '@cs/shared';
import { pairKey, type MarketEngine, type VenueMarket, type VerifiedPairSet } from '@cs/market';

import type { ExternalTickers } from './pairs-external.js';
import type { PairStatus, Repo, VerifiedPairRecord } from './repo/index.js';

export interface PairsOptions {
  repo: Repo;
  engine: MarketEngine | null;
  log: FastifyBaseLogger;
  external: ExternalTickers;
  /** Кого звать, когда после автосверки в ручной очереди появились новые аномалии. */
  onAnomalies?: (count: number) => void;
}

/** Пара с живыми ценами — для экрана сверки. */
export interface PairView extends VerifiedPairRecord {
  priceA: number | null;
  priceB: number | null;
  /** priceA / priceB сейчас; null — одной из цен нет. */
  liveRatio: number | null;
}

/**
 * Допуск по цене. Спред между биржами — это и есть то, что ищет скринер,
 * поэтому 1 % слишком мало: у неликвидных монет расхождение в 2–4 % —
 * норма, а не другой актив. Если CoinGecko подтверждает, что актив один,
 * допуск шире — расхождение тогда лишь большой спред.
 */
const TOLERANCE = 0.05;
const TOLERANCE_EXTERNAL = 0.25;
const DRIFT_TOLERANCE = 0.15;
const DRIFT_STRIKES = 3;
const PASS_MS = 60_000;
const STANDARD = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000];

function recordKey(r: { exchangeA: string; symbolA: string; exchangeB: string; symbolB: string }): string {
  return `${r.exchangeA}:${r.symbolA}|${r.exchangeB}:${r.symbolB}`;
}

/** Ближайший стандартный множитель (или обратный), если отношение в допуске. */
function standardMultiplier(ratio: number, tolerance = TOLERANCE): number | null {
  for (const m of STANDARD) {
    if (Math.abs(ratio / m - 1) <= tolerance) return m;
    if (m !== 1 && Math.abs(ratio * m - 1) <= tolerance) return 1 / m;
  }
  return null;
}

/** CoinGecko заводит отдельные id для 1000-контрактов («1000bonk») — это та же монета. */
function sameAsset(a: string, b: string): boolean {
  const norm = (id: string) => id.replace(/^(1000000|100000|10000|1000)(?=[a-z])/, '');
  return norm(a) === norm(b);
}

function fmtRatio(r: number): string {
  return r >= 1 ? `×${r >= 100 ? Math.round(r) : r.toFixed(2)}` : `×1/${(1 / r) >= 100 ? Math.round(1 / r) : (1 / r).toFixed(2)}`;
}

export class PairsService {
  private pairs = new Map<string, VerifiedPairRecord>();
  private strikes = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private passing = false;
  private syncChain: Promise<void> = Promise.resolve();

  constructor(private readonly o: PairsOptions) {}

  /** Загрузить таблицу из базы и отдать движку. */
  async load(): Promise<void> {
    let rows = await this.o.repo.listVerifiedPairs();
    if (rows.length === 0) rows = await this.migrateManual();
    this.pairs = new Map(rows.map((r) => [recordKey(r), r]));
    this.push();
    const c = this.counts();
    this.o.log.info(`сверка: пар ${c.total}, сверено ${c.verified} (авто ${c.auto}), в очереди ${c.anomalies}`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.autoVerifyPass(), PASS_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Перенос из старой таблицы ног: только ручные решения администратора.
   * Всё остальное автосверка пересчитает сама за минуту.
   */
  private async migrateManual(): Promise<VerifiedPairRecord[]> {
    const legs = (await this.o.repo.listVerifiedSymbols()).filter((l) => l.updatedBy?.startsWith('admin:'));
    if (legs.length === 0) return [];
    const byBase = new Map<string, typeof legs>();
    for (const l of legs) byBase.set(l.base, [...(byBase.get(l.base) ?? []), l]);
    const out: VerifiedPairRecord[] = [];
    const now = Date.now();
    for (const list of byBase.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!;
          const b = list[j]!;
          if (a.exchange === b.exchange) continue;
          const [x, y] = a.exchange < b.exchange ? [a, b] : [b, a];
          const bothVerified = x.status === 'verified' && y.status === 'verified';
          const anyRejected = x.status === 'rejected' || y.status === 'rejected';
          if (!bothVerified && !anyRejected) continue;
          out.push({
            base: x.base,
            exchangeA: x.exchange,
            symbolA: x.symbol,
            exchangeB: y.exchange,
            symbolB: y.symbol,
            multiplier: x.multiplier / y.multiplier,
            status: anyRejected ? 'rejected' : 'verified',
            verificationSource: 'manual',
            ratio: null,
            externalA: null,
            externalB: null,
            note: 'перенос из сверки ног',
            updatedAt: now,
            updatedBy: x.updatedBy ?? y.updatedBy,
            verifiedAt: anyRejected ? null : now,
          });
        }
      }
    }
    if (out.length) await this.o.repo.upsertVerifiedPairs(out);
    this.o.log.info(`сверка: перенесено ручных решений — ${out.length}`);
    return out;
  }

  // ---------------------------------------------------------------- кандидаты

  /** Вызовы идут по очереди: параллельные создавали бы одни и те же пары дважды. */
  syncMarkets(exchange: ExchangeId, markets: VenueMarket[]): Promise<void> {
    const next = this.syncChain.then(() => this.syncMarketsNow(exchange, markets));
    this.syncChain = next.catch(() => {});
    return next;
  }

  /** Биржа отдала рынки: каждая нога получает пару-кандидата с каждой ногой той же монеты на других биржах. */
  private async syncMarketsNow(exchange: ExchangeId, markets: VenueMarket[]): Promise<void> {
    if (!this.o.engine) return;
    const byBase = new Map<string, VenueMarket[]>();
    for (const m of this.o.engine.allMarkets()) {
      if (m.exchange === exchange) continue;
      byBase.set(m.base, [...(byBase.get(m.base) ?? []), m]);
    }
    const fresh: VerifiedPairRecord[] = [];
    const now = Date.now();
    for (const m of markets) {
      for (const other of byBase.get(m.base) ?? []) {
        const [a, b] = m.exchange < other.exchange ? [m, other] : [other, m];
        const rec: VerifiedPairRecord = {
          base: m.base,
          exchangeA: a.exchange,
          symbolA: a.symbol,
          exchangeB: b.exchange,
          symbolB: b.symbol,
          multiplier: a.multiplier / b.multiplier,
          status: 'candidate',
          verificationSource: null,
          ratio: null,
          externalA: null,
          externalB: null,
          note: null,
          updatedAt: now,
          updatedBy: 'system',
          verifiedAt: null,
        };
        const key = recordKey(rec);
        if (this.pairs.has(key)) continue;
        this.pairs.set(key, rec);
        fresh.push(rec);
      }
    }
    if (fresh.length === 0) return;
    await this.o.repo.upsertVerifiedPairs(fresh);
    this.o.log.info(`сверка: ${exchange} — новых пар-кандидатов ${fresh.length}`);
  }

  // ---------------------------------------------------------------- автосверка

  async autoVerifyPass(): Promise<void> {
    if (this.passing || !this.o.engine) return;
    this.passing = true;
    try {
      const prices = this.o.engine.rawPrices();
      const changed: VerifiedPairRecord[] = [];
      let newAnomalies = 0;
      const now = Date.now();

      for (const rec of this.pairs.values()) {
        if (rec.status === 'delisted' || rec.verificationSource === 'manual') continue;
        const pa = prices.get(`${rec.exchangeA}:${rec.symbolA}`);
        const pb = prices.get(`${rec.exchangeB}:${rec.symbolB}`);
        const extA = this.o.external.coinId(rec.exchangeA, rec.symbolA);
        const extB = this.o.external.coinId(rec.exchangeB, rec.symbolB);
        const ext = extA && extB ? (sameAsset(extA, extB) ? 'match' : 'mismatch') : 'unknown';

        if (rec.status === 'verified') {
          // Перепроверка: цены разошлись — три прохода подряд, и пара снова в очереди.
          if (pa === undefined || pb === undefined || pb <= 0) continue;
          const drift = Math.abs(pa / pb / rec.multiplier - 1);
          const key = recordKey(rec);
          if (drift <= DRIFT_TOLERANCE) {
            this.strikes.delete(key);
            continue;
          }
          const n = (this.strikes.get(key) ?? 0) + 1;
          this.strikes.set(key, n);
          if (n < DRIFT_STRIKES) continue;
          this.strikes.delete(key);
          changed.push({
            ...rec,
            status: 'candidate',
            verificationSource: null,
            ratio: pa / pb,
            note: `цены разошлись: ${fmtRatio(pa / pb)} при множителе ${fmtRatio(rec.multiplier)}`,
            updatedAt: now,
            updatedBy: 'auto',
          });
          newAnomalies++;
          continue;
        }

        if (rec.status === 'rejected') {
          // Отклонённые автоматически пересматриваем, только если внешний источник передумал.
          if (rec.updatedBy === 'auto' && ext === 'match') {
            changed.push({ ...rec, status: 'candidate', note: null, updatedAt: now, updatedBy: 'auto' });
          }
          continue;
        }

        // Кандидат. Без цен решения нет: внешний источник — второй сигнал, не единственный.
        if (pa === undefined || pb === undefined || pb <= 0 || pa <= 0) continue;
        const ratio = pa / pb;
        const std = standardMultiplier(ratio, ext === 'match' ? TOLERANCE_EXTERNAL : TOLERANCE);
        const wasAnomaly = rec.note !== null;
        let next: VerifiedPairRecord | null = null;

        if (std !== null && ext !== 'mismatch') {
          next = {
            ...rec,
            status: 'verified',
            multiplier: std,
            verificationSource: ext === 'match' ? 'external_match' : std === 1 ? 'auto_price' : 'auto_multiplier',
            ratio,
            externalA: extA,
            externalB: extB,
            note: null,
            updatedAt: now,
            updatedBy: 'auto',
            verifiedAt: rec.verifiedAt ?? now,
          };
        } else if (std === null && ext === 'mismatch') {
          next = {
            ...rec,
            status: 'rejected',
            ratio,
            externalA: extA,
            externalB: extB,
            note: `CoinGecko: ${extA} ≠ ${extB}, цены ${fmtRatio(ratio)}`,
            updatedAt: now,
            updatedBy: 'auto',
          };
        } else {
          const note =
            ext === 'mismatch'
              ? `цены совпадают (${fmtRatio(ratio)}), но CoinGecko: ${extA} ≠ ${extB}`
              : `${fmtRatio(ratio)} — нестандартный множитель${ext === 'match' ? `, CoinGecko: один актив (${extA})` : ''}`;
          // Аномалия остаётся в очереди; обновляем только если отношение заметно сдвинулось.
          const moved = rec.ratio === null || Math.abs(ratio / rec.ratio - 1) > 0.02 || rec.note !== note;
          if (moved) {
            next = { ...rec, ratio, externalA: extA, externalB: extB, note, updatedAt: now, updatedBy: 'auto' };
          }
          if (!wasAnomaly) newAnomalies++;
        }
        if (next) changed.push(next);
      }

      if (changed.length) {
        for (const r of changed) this.pairs.set(recordKey(r), r);
        await this.o.repo.upsertVerifiedPairs(changed);
        if (changed.some((r) => r.status === 'verified' || r.status === 'candidate')) this.push();
        const verified = changed.filter((r) => r.status === 'verified').length;
        const rejected = changed.filter((r) => r.status === 'rejected').length;
        if (verified || rejected) {
          this.o.log.info(`сверка: автоматически сверено ${verified}, отклонено ${rejected}, в очередь ${newAnomalies}`);
        }
      }
      if (newAnomalies > 0) this.o.onAnomalies?.(newAnomalies);
    } catch (err) {
      this.o.log.warn({ err: String(err).slice(0, 200) }, 'сверка: проход не удался');
    } finally {
      this.passing = false;
    }
  }

  // ---------------------------------------------------------------- ручные решения

  /** Решение администратора по паре. */
  async setStatus(
    id: { exchangeA: ExchangeId; symbolA: string; exchangeB: ExchangeId; symbolB: string },
    status: PairStatus,
    multiplier: number | undefined,
    by: string,
  ): Promise<VerifiedPairRecord | null> {
    const rec = this.pairs.get(recordKey(id));
    if (!rec) return null;
    const next: VerifiedPairRecord = {
      ...rec,
      status,
      multiplier: multiplier && multiplier > 0 ? multiplier : rec.multiplier,
      verificationSource: 'manual',
      note: null,
      updatedAt: Date.now(),
      updatedBy: by,
      verifiedAt: status === 'verified' ? (rec.verifiedAt ?? Date.now()) : rec.verifiedAt,
    };
    this.pairs.set(recordKey(next), next);
    await this.o.repo.upsertVerifiedPairs([next]);
    this.push();
    return next;
  }

  /** Нога исчезла с биржи — все её пары уходят из ленты. */
  async markDelisted(exchange: ExchangeId, symbol: string, by: string): Promise<number> {
    const changed: VerifiedPairRecord[] = [];
    for (const rec of this.pairs.values()) {
      const hit =
        (rec.exchangeA === exchange && rec.symbolA === symbol) ||
        (rec.exchangeB === exchange && rec.symbolB === symbol);
      if (!hit || rec.status === 'delisted') continue;
      const next: VerifiedPairRecord = { ...rec, status: 'delisted', updatedAt: Date.now(), updatedBy: by };
      this.pairs.set(recordKey(next), next);
      changed.push(next);
    }
    if (changed.length) {
      await this.o.repo.upsertVerifiedPairs(changed);
      this.push();
    }
    return changed.length;
  }

  /** Есть ли у монеты сверенная пара с этой биржей — для предупреждений о делистинге. */
  hasVerifiedLeg(base: string, exchange: ExchangeId): boolean {
    for (const r of this.pairs.values()) {
      if (r.base === base && r.status === 'verified' && (r.exchangeA === exchange || r.exchangeB === exchange)) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- чтение

  list(filter: 'anomalies' | 'verified' | 'rejected'): PairView[] {
    const prices = this.o.engine?.rawPrices() ?? new Map<string, number>();
    const out: PairView[] = [];
    for (const rec of this.pairs.values()) {
      const ok =
        filter === 'anomalies'
          ? rec.status === 'candidate' && rec.note !== null
          : filter === 'verified'
            ? rec.status === 'verified'
            : rec.status === 'rejected';
      if (!ok) continue;
      const priceA = prices.get(`${rec.exchangeA}:${rec.symbolA}`) ?? null;
      const priceB = prices.get(`${rec.exchangeB}:${rec.symbolB}`) ?? null;
      out.push({ ...rec, priceA, priceB, liveRatio: priceA !== null && priceB ? priceA / priceB : null });
    }
    // Свежие решения и аномалии — сверху.
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  counts(): { total: number; verified: number; auto: number; manual: number; anomalies: number; pending: number; rejected: number } {
    const c = { total: 0, verified: 0, auto: 0, manual: 0, anomalies: 0, pending: 0, rejected: 0 };
    for (const r of this.pairs.values()) {
      c.total++;
      if (r.status === 'verified') {
        c.verified++;
        if (r.verificationSource === 'manual') c.manual++;
        else c.auto++;
      } else if (r.status === 'candidate') {
        if (r.note !== null) c.anomalies++;
        else c.pending++;
      } else if (r.status === 'rejected') c.rejected++;
    }
    return c;
  }

  // ---------------------------------------------------------------- движок

  /**
   * Сверенные пары → множители ног. Множитель каждой ноги считается от
   * опорной через цепочку пар, потом всё нормируется так, чтобы у самого
   * «мелкого» контракта множитель был 1 — это и есть цена за монету.
   */
  private push(): void {
    if (!this.o.engine) return;
    const byBase = new Map<string, VerifiedPairRecord[]>();
    for (const r of this.pairs.values()) {
      if (r.status !== 'verified') continue;
      byBase.set(r.base, [...(byBase.get(r.base) ?? []), r]);
    }
    const out = new Map<string, VerifiedPairSet>();
    for (const [base, list] of byBase) {
      // На бирже могут быть и PEPE, и 1000PEPE — берём символ с наибольшим числом пар.
      const symbolVotes = new Map<string, number>();
      for (const r of list) {
        symbolVotes.set(`${r.exchangeA}:${r.symbolA}`, (symbolVotes.get(`${r.exchangeA}:${r.symbolA}`) ?? 0) + 1);
        symbolVotes.set(`${r.exchangeB}:${r.symbolB}`, (symbolVotes.get(`${r.exchangeB}:${r.symbolB}`) ?? 0) + 1);
      }
      const symbolOf = new Map<ExchangeId, string>();
      for (const [key, votes] of symbolVotes) {
        const [exchange, symbol] = key.split(/:(.*)/s) as [ExchangeId, string];
        const cur = symbolOf.get(exchange);
        if (!cur || votes > (symbolVotes.get(`${exchange}:${cur}`) ?? 0)) symbolOf.set(exchange, symbol);
      }
      const edges = list.filter(
        (r) => symbolOf.get(r.exchangeA) === r.symbolA && symbolOf.get(r.exchangeB) === r.symbolB,
      );
      if (edges.length === 0) continue;

      // Обход графа от первой биржи: factor(A) = multiplier × factor(B).
      const factor = new Map<ExchangeId, number>();
      const queue: ExchangeId[] = [edges[0]!.exchangeA];
      factor.set(edges[0]!.exchangeA, 1);
      while (queue.length) {
        const x = queue.shift()!;
        for (const e of edges) {
          if (e.exchangeA === x && !factor.has(e.exchangeB)) {
            factor.set(e.exchangeB, factor.get(x)! / e.multiplier);
            queue.push(e.exchangeB);
          } else if (e.exchangeB === x && !factor.has(e.exchangeA)) {
            factor.set(e.exchangeA, factor.get(x)! * e.multiplier);
            queue.push(e.exchangeA);
          }
        }
      }
      // Несвязные куски (редкость) — отдельными обходами.
      for (const e of edges) {
        for (const ex of [e.exchangeA, e.exchangeB]) {
          if (factor.has(ex)) continue;
          factor.set(ex, 1);
          queue.push(ex);
          while (queue.length) {
            const x = queue.shift()!;
            for (const f of edges) {
              if (f.exchangeA === x && !factor.has(f.exchangeB)) {
                factor.set(f.exchangeB, factor.get(x)! / f.multiplier);
                queue.push(f.exchangeB);
              } else if (f.exchangeB === x && !factor.has(f.exchangeA)) {
                factor.set(f.exchangeA, factor.get(x)! * f.multiplier);
                queue.push(f.exchangeA);
              }
            }
          }
        }
      }
      const min = Math.min(...factor.values());
      const legs = new Map<ExchangeId, { symbol: string; factor: number }>();
      for (const [ex, f] of factor) legs.set(ex, { symbol: symbolOf.get(ex)!, factor: f / min });
      const pairs = new Map<string, number | undefined>();
      for (const e of edges) pairs.set(pairKey(e.exchangeA, e.exchangeB), e.verifiedAt ?? undefined);
      out.set(base, { pairs, legs });
    }
    this.o.engine.setVerifiedPairs(out);
  }
}
