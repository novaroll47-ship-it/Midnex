/**
 * Сверка пар: между какими ногами одной монеты спред считать можно.
 *
 * Одинаковый тикер на двух биржах ничего не доказывает: под «TA» или «BB»
 * могут торговаться разные проекты, а `1000SHIB` против `SHIB` — одна монета
 * с другим номиналом. Поэтому в ленту попадают только сверенные пары
 * (таблица verified_pairs), а множитель берётся оттуда же.
 *
 * Сверка автоматическая, раз в минуту, и идёт от ноги, а не от пары:
 *  1. номинал каждой ноги — из префикса тикера (1000SHIB), метаданных биржи
 *     (contract size) или ручного решения; остаток проверяется по ценам:
 *     ноги одной монеты, чьи цены сходятся с точностью до стандартного
 *     множителя (10…1 000 000, ±2 %), образуют кластер; нога вне кластера —
 *     аномалия номинала, и все её пары идут в очередь одной карточкой;
 *  2. пара двух нормальных ног получает точный множитель (отношение
 *     номиналов), а остаток расхождения цен — это и есть спред: до 5 % —
 *     пара сверена, больше — «проверить данные» (котировка одной из бирж
 *     скорее всего устарела), в ленту не идёт;
 *  3. CoinGecko — второй сигнал: разные id при сходящихся ценах — очередь
 *     «идентичность» (PUMP ≠ pump-fun), разные id и разные цены — отклонено;
 *     id для 1000X-контрактов приводятся к базовому активу.
 * Короткие тикеры (1–2 символа, цифры) автоматически не подтверждаются никогда.
 * Ручные решения — по паре или по инструменту — окончательны.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ExchangeId } from '@cs/shared';
import { pairKey, type MarketEngine, type VenueMarket, type VerifiedPairSet } from '@cs/market';

import type { ExternalTickers } from './pairs-external.js';
import type {
  InstrumentNominalRecord,
  PairCategory,
  PairStatus,
  Repo,
  VerifiedPairRecord,
} from './repo/index.js';

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
/** Допуск при распознавании стандартного множителя: узкий, иначе «×107» сошёл бы за ×100. */
const NOMINAL_TOLERANCE = 0.02;
/** Остаток после точного множителя — спред; больше этого — данные под вопросом. */
const PRICE_TOLERANCE = 0.05;
const DRIFT_TOLERANCE = 0.15;
const DRIFT_STRIKES = 3;
const PASS_MS = 60_000;
const STANDARD = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000];
const PREFIXES = [1_000_000, 100_000, 10_000, 1000, 100, 10];

function recordKey(r: {
  exchangeA: string;
  symbolA: string;
  exchangeB: string;
  symbolB: string;
}): string {
  return `${r.exchangeA}:${r.symbolA}|${r.exchangeB}:${r.symbolB}`;
}

/** Ближайший стандартный множитель (или обратный), если отношение в допуске. */
function standardMultiplier(ratio: number, tolerance = NOMINAL_TOLERANCE): number | null {
  for (const m of STANDARD) {
    if (Math.abs(ratio / m - 1) <= tolerance) return m;
    if (m !== 1 && Math.abs(ratio * m - 1) <= tolerance) return 1 / m;
  }
  return null;
}

/**
 * Один ли это актив по CoinGecko. У 1000X-контрактов там свой id
 * («1000shib», «1000bonk»): срезаем префикс и сравниваем с базовым — либо
 * буквально, либо как начало имени («shib» ↔ «shiba-inu»).
 */
function sameAsset(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (id: string) => {
    for (const p of PREFIXES) {
      const pre = String(p);
      if (id.startsWith(pre) && /[a-z]/.test(id[pre.length] ?? ''))
        return { core: id.slice(pre.length), prefixed: true };
    }
    return { core: id, prefixed: false };
  };
  const x = strip(a);
  const y = strip(b);
  if (x.core === y.core) return true;
  if (x.prefixed !== y.prefixed) {
    const short = x.prefixed ? x.core : y.core;
    const long = x.prefixed ? y.core : x.core;
    return short.length >= 3 && long.startsWith(short);
  }
  return false;
}

/** Короткий или цифровой тикер — слишком легко совпадает у разных проектов. */
function riskyTicker(base: string): boolean {
  return base.length <= 2 || /^\d+$/.test(base);
}

function fmtRatio(r: number): string {
  return r >= 1
    ? `×${r >= 100 ? Math.round(r) : r.toFixed(2)}`
    : `×1/${1 / r >= 100 ? Math.round(1 / r) : (1 / r).toFixed(2)}`;
}

function legId(exchange: string, symbol: string): string {
  return `${exchange}:${symbol}`;
}

export class PairsService {
  private pairs = new Map<string, VerifiedPairRecord>();
  /** Ручные номиналы инструментов: сырая цена = factor × цена монеты; 0 — отклонён. */
  private nominals = new Map<string, InstrumentNominalRecord>();
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
    this.nominals = new Map(
      (await this.o.repo.listInstrumentNominals()).map((n) => [legId(n.exchange, n.symbol), n]),
    );
    this.push();
    const c = this.counts();
    this.o.log.info(
      `сверка: пар ${c.total}, сверено ${c.verified} (авто ${c.auto}), в очереди ${c.anomalies}`,
    );
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
    const legs = (await this.o.repo.listVerifiedSymbols()).filter((l) =>
      l.updatedBy?.startsWith('admin:'),
    );
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
            category: null,
            anomalyLeg: null,
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
          category: null,
          anomalyLeg: null,
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
      const engine = this.o.engine;
      const prices = engine.rawPrices();
      const contractSizes = engine.contractSizes();
      const tickerMult = new Map<string, number>();
      for (const m of engine.allMarkets())
        tickerMult.set(legId(m.exchange, m.symbol), m.multiplier);

      // Пары по монетам — сверяем ногами внутри монеты.
      const byBase = new Map<string, VerifiedPairRecord[]>();
      for (const rec of this.pairs.values()) {
        if (rec.status === 'delisted') continue;
        byBase.set(rec.base, [...(byBase.get(rec.base) ?? []), rec]);
      }

      const changed: VerifiedPairRecord[] = [];
      let newAnomalies = 0;
      const now = Date.now();

      for (const [base, recs] of byBase) {
        // 1. Ноги монеты с сырой ценой и известным заранее номиналом.
        const legs = new Map<
          string,
          { exchange: ExchangeId; symbol: string; raw: number; known: number | null }
        >();
        for (const r of recs) {
          for (const [ex, sym] of [
            [r.exchangeA, r.symbolA],
            [r.exchangeB, r.symbolB],
          ] as [ExchangeId, string][]) {
            const id = legId(ex, sym);
            if (legs.has(id)) continue;
            const raw = prices.get(id);
            if (raw === undefined || raw <= 0) continue;
            const manual = this.nominals.get(id);
            legs.set(id, { exchange: ex, symbol: sym, raw, known: manual ? manual.factor : null });
          }
        }
        const factor = this.clusterNominals(base, legs, tickerMult, contractSizes);

        for (const rec of recs) {
          if (rec.verificationSource === 'manual') continue;
          const idA = legId(rec.exchangeA, rec.symbolA);
          const idB = legId(rec.exchangeB, rec.symbolB);
          const la = legs.get(idA);
          const lb = legs.get(idB);
          const next = this.decide(rec, base, la, lb, factor.get(idA), factor.get(idB), now);
          if (!next) continue;
          if (next.status === 'candidate' && next.category && rec.category !== next.category)
            newAnomalies++;
          changed.push(next);
        }
      }

      if (changed.length) {
        for (const r of changed) this.pairs.set(recordKey(r), r);
        await this.o.repo.upsertVerifiedPairs(changed);
        if (changed.some((r) => r.status === 'verified' || r.status === 'candidate')) this.push();
        const verified = changed.filter((r) => r.status === 'verified').length;
        const rejected = changed.filter((r) => r.status === 'rejected').length;
        if (verified || rejected || newAnomalies) {
          this.o.log.info(
            `сверка: автоматически сверено ${verified}, отклонено ${rejected}, в очередь ${newAnomalies}`,
          );
        }
      }
      if (newAnomalies > 0) this.o.onAnomalies?.(newAnomalies);
    } catch (err) {
      this.o.log.warn({ err: String(err).slice(0, 200) }, 'сверка: проход не удался');
    } finally {
      this.passing = false;
    }
  }

  /**
   * Номинал каждой ноги монеты: сырая цена = factor × цена монеты.
   * Ручной номинал и префикс тикера — заранее; остальное — по ценам: ищем
   * ногу-опору, с которой сходится больше всего других (с точностью до
   * стандартного множителя), кластер вокруг неё — нормальные ноги.
   * Нога вне кластера — аномалия (factor не задан). Множитель — только
   * точный стандартный: остаток расхождения остаётся спредом, а не
   * «подгоняется».
   */
  private clusterNominals(
    base: string,
    legs: Map<string, { exchange: ExchangeId; symbol: string; raw: number; known: number | null }>,
    tickerMult: Map<string, number>,
    contractSizes: Map<string, number>,
  ): Map<string, number> {
    const out = new Map<string, number>();
    // Цена «за монету» по известной части номинала: префикс тикера.
    const norm = new Map<string, number>();
    for (const [id, leg] of legs) {
      if (leg.known !== null) {
        if (leg.known > 0) out.set(id, leg.known);
        continue; // 0 — инструмент отклонён вручную
      }
      norm.set(id, leg.raw / (tickerMult.get(id) ?? 1));
    }
    const ids = [...norm.keys()];
    if (ids.length === 0) return out;

    // Опора: нога, с которой сходится больше всего остальных. Ручные ноги —
    // тоже опора (их цена за монету известна точно).
    const manualAnchors = [...legs.entries()].filter(([, l]) => l.known !== null && l.known > 0);
    let bestRef: { price: number; members: string[] } | null = null;
    const candidates: number[] = [
      ...manualAnchors.map(([, l]) => l.raw / l.known!),
      ...ids.map((id) => norm.get(id)!),
    ];
    for (const ref of candidates) {
      const members = ids.filter((id) => standardMultiplier(norm.get(id)! / ref) !== null);
      if (
        !bestRef ||
        members.length > bestRef.members.length ||
        (members.length === bestRef.members.length && ref < bestRef.price)
      ) {
        bestRef = { price: ref, members };
      }
    }
    if (!bestRef) return out;
    // Кластер из одной ноги без ручной опоры ничего не доказывает (два
    // разных актива — тоже «кластеры» по одной ноге), но пара из двух ног
    // с точным стандартным отношением — нормальна: обе входят в кластер.
    if (bestRef.members.length < 2 && manualAnchors.length === 0) return out;
    const refPrice = bestRef.price;
    for (const id of bestRef.members) {
      const m = standardMultiplier(norm.get(id)! / refPrice)!;
      out.set(id, (tickerMult.get(id) ?? 1) * m);
    }
    // Нога вне кластера: может, номинал объясняет размер контракта из метаданных.
    for (const id of ids) {
      if (out.has(id)) continue;
      const cs = contractSizes.get(id) ?? 1;
      if (cs !== 1) {
        const r = norm.get(id)! / refPrice;
        if (Math.abs(r / cs - 1) <= NOMINAL_TOLERANCE) out.set(id, (tickerMult.get(id) ?? 1) * cs);
        else if (Math.abs(r * cs - 1) <= NOMINAL_TOLERANCE)
          out.set(id, (tickerMult.get(id) ?? 1) / cs);
      }
    }
    void base;
    return out;
  }

  /** Решение по одной паре; null — ничего не менять. */
  private decide(
    rec: VerifiedPairRecord,
    base: string,
    la: { raw: number } | undefined,
    lb: { raw: number } | undefined,
    fa: number | undefined,
    fb: number | undefined,
    now: number,
  ): VerifiedPairRecord | null {
    const extA = this.o.external.coinId(rec.exchangeA, rec.symbolA);
    const extB = this.o.external.coinId(rec.exchangeB, rec.symbolB);
    const ext = extA && extB ? (sameAsset(extA, extB) ? 'match' : 'mismatch') : 'unknown';
    const idA = legId(rec.exchangeA, rec.symbolA);
    const idB = legId(rec.exchangeB, rec.symbolB);
    const rejectedLeg =
      this.nominals.get(idA)?.factor === 0
        ? idA
        : this.nominals.get(idB)?.factor === 0
          ? idB
          : null;

    if (rejectedLeg) {
      if (rec.status === 'rejected') return null;
      return {
        ...rec,
        status: 'rejected',
        note: `инструмент отклонён вручную`,
        category: null,
        anomalyLeg: rejectedLeg,
        updatedAt: now,
        updatedBy: 'auto',
      };
    }
    if (!la || !lb) return null; // без цен решения нет
    const ratio = la.raw / lb.raw;

    const queue = (
      category: PairCategory,
      note: string,
      anomalyLeg: string | null,
    ): VerifiedPairRecord | null => {
      const moved =
        rec.status !== 'candidate' ||
        rec.category !== category ||
        rec.ratio === null ||
        Math.abs(ratio / rec.ratio - 1) > 0.02 ||
        rec.note !== note;
      if (!moved) return null;
      return {
        ...rec,
        status: 'candidate',
        verificationSource: null,
        ratio,
        externalA: extA,
        externalB: extB,
        note,
        category,
        anomalyLeg,
        updatedAt: now,
        updatedBy: 'auto',
      };
    };

    // Короткий тикер — только руками.
    if (riskyTicker(base)) {
      if (rec.status === 'verified') return null;
      return queue(
        'risky',
        `короткий тикер «${base}» — только ручное решение (${fmtRatio(ratio)})`,
        null,
      );
    }

    // Нога с неизвестным номиналом — очередь одной карточкой на инструмент.
    if (fa === undefined || fb === undefined) {
      const culprit =
        fa === undefined && fb !== undefined
          ? idA
          : fb === undefined && fa !== undefined
            ? idB
            : null;
      if (rec.status === 'verified') {
        // Уже сверенная пара: цены разошлись? Три прохода подряд — в очередь.
        return this.driftCheck(rec, ratio, now);
      }
      // Расхождение меньше чем втрое — это не номинал (множители кратны 10),
      // а расходящиеся цены: котировка одной из бирж под вопросом.
      if (ratio > 1 / 3 && ratio < 3) {
        const off = ((Math.max(ratio, 1 / ratio) - 1) * 100).toFixed(1);
        return queue(
          'data',
          `цены расходятся на ${off} % без стандартного множителя — проверить котировки${culprit ? ` (${culprit.split(':')[0]})` : ''}`,
          culprit,
        );
      }
      const note = culprit
        ? `номинал ${culprit.split(':')[0]} отличается от остальных бирж (${fmtRatio(ratio)})`
        : `номиналы не сходятся ни к одному стандартному множителю (${fmtRatio(ratio)})`;
      return queue('nominal', note, culprit ?? idA);
    }

    // Обе ноги нормальные: точный множитель, остаток — спред.
    const multiplier = fa / fb;
    const residual = ratio / multiplier - 1;
    if (ext === 'mismatch') {
      if (Math.abs(residual) <= PRICE_TOLERANCE) {
        return queue(
          'identity',
          `цены совпадают (${fmtRatio(ratio)}), но CoinGecko: ${extA} ≠ ${extB}`,
          null,
        );
      }
      if (rec.status === 'rejected') return null;
      return {
        ...rec,
        status: 'rejected',
        ratio,
        externalA: extA,
        externalB: extB,
        note: `CoinGecko: ${extA} ≠ ${extB}, цены ${fmtRatio(ratio)}`,
        category: null,
        anomalyLeg: null,
        updatedAt: now,
        updatedBy: 'auto',
      };
    }
    if (Math.abs(residual) > PRICE_TOLERANCE) {
      if (rec.status === 'verified') return this.driftCheck(rec, ratio, now);
      return queue(
        'data',
        `актив один, а цены расходятся на ${(Math.abs(residual) * 100).toFixed(1)} % при номинале ${fmtRatio(multiplier)} — проверить котировки`,
        null,
      );
    }
    // Сверено.
    const source =
      ext === 'match' ? 'external_match' : multiplier === 1 ? 'auto_price' : 'auto_multiplier';
    if (
      rec.status === 'verified' &&
      rec.multiplier === multiplier &&
      rec.verificationSource === source
    ) {
      this.strikes.delete(recordKey(rec));
      return null;
    }
    return {
      ...rec,
      status: 'verified',
      multiplier,
      verificationSource: source,
      ratio,
      externalA: extA,
      externalB: extB,
      note: null,
      category: null,
      anomalyLeg: null,
      updatedAt: now,
      updatedBy: 'auto',
      verifiedAt: rec.verifiedAt ?? now,
    };
  }

  /** Сверенная пара, у которой цены разошлись: три прохода подряд — обратно в очередь. */
  private driftCheck(
    rec: VerifiedPairRecord,
    ratio: number,
    now: number,
  ): VerifiedPairRecord | null {
    const drift = Math.abs(ratio / rec.multiplier - 1);
    const key = recordKey(rec);
    if (drift <= DRIFT_TOLERANCE) {
      this.strikes.delete(key);
      return null;
    }
    const n = (this.strikes.get(key) ?? 0) + 1;
    this.strikes.set(key, n);
    if (n < DRIFT_STRIKES) return null;
    this.strikes.delete(key);
    return {
      ...rec,
      status: 'candidate',
      verificationSource: null,
      ratio,
      note: `цены разошлись: ${fmtRatio(ratio)} при множителе ${fmtRatio(rec.multiplier)} — проверить котировки`,
      category: 'data',
      anomalyLeg: null,
      updatedAt: now,
      updatedBy: 'auto',
    };
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
      category: null,
      anomalyLeg: null,
      updatedAt: Date.now(),
      updatedBy: by,
      verifiedAt: status === 'verified' ? (rec.verifiedAt ?? Date.now()) : rec.verifiedAt,
    };
    this.pairs.set(recordKey(next), next);
    await this.o.repo.upsertVerifiedPairs([next]);
    this.push();
    return next;
  }

  /**
   * Решение по инструменту: номинал (сырая цена = factor × цена монеты) или
   * отклонение (factor = 0). Одно решение закрывает все пары с этой ногой —
   * их пересчитает ближайший проход, который запускаем сразу.
   */
  async setLegNominal(
    exchange: ExchangeId,
    symbol: string,
    factor: number,
    by: string,
  ): Promise<void> {
    const rec: InstrumentNominalRecord = {
      exchange,
      symbol,
      factor,
      updatedAt: Date.now(),
      updatedBy: by,
    };
    this.nominals.set(legId(exchange, symbol), rec);
    await this.o.repo.upsertInstrumentNominal(rec);
    // Ручные решения по парам с этой ногой больше не нужны — пусть считает автомат.
    const reset: VerifiedPairRecord[] = [];
    for (const r of this.pairs.values()) {
      const hit =
        legId(r.exchangeA, r.symbolA) === legId(exchange, symbol) ||
        legId(r.exchangeB, r.symbolB) === legId(exchange, symbol);
      if (hit && r.status !== 'delisted' && r.verificationSource !== 'manual') {
        reset.push({
          ...r,
          status: 'candidate',
          verificationSource: null,
          note: null,
          category: null,
          anomalyLeg: null,
          updatedAt: Date.now(),
          updatedBy: by,
        });
      }
    }
    for (const r of reset) this.pairs.set(recordKey(r), r);
    if (reset.length) await this.o.repo.upsertVerifiedPairs(reset);
    await this.autoVerifyPass();
  }

  /** Нога исчезла с биржи — все её пары уходят из ленты. */
  async markDelisted(exchange: ExchangeId, symbol: string, by: string): Promise<number> {
    const changed: VerifiedPairRecord[] = [];
    for (const rec of this.pairs.values()) {
      const hit =
        (rec.exchangeA === exchange && rec.symbolA === symbol) ||
        (rec.exchangeB === exchange && rec.symbolB === symbol);
      if (!hit || rec.status === 'delisted') continue;
      const next: VerifiedPairRecord = {
        ...rec,
        status: 'delisted',
        updatedAt: Date.now(),
        updatedBy: by,
      };
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
      if (
        r.base === base &&
        r.status === 'verified' &&
        (r.exchangeA === exchange || r.exchangeB === exchange)
      ) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- чтение

  list(filter: 'anomalies' | 'verified' | 'rejected' | 'pending'): PairView[] {
    const prices = this.o.engine?.rawPrices() ?? new Map<string, number>();
    const out: PairView[] = [];
    for (const rec of this.pairs.values()) {
      const ok =
        filter === 'anomalies'
          ? rec.status === 'candidate' && rec.category !== null
          : filter === 'pending'
            ? rec.status === 'candidate' && rec.category === null
            : filter === 'verified'
              ? rec.status === 'verified'
              : rec.status === 'rejected';
      if (!ok) continue;
      const priceA = prices.get(`${rec.exchangeA}:${rec.symbolA}`) ?? null;
      const priceB = prices.get(`${rec.exchangeB}:${rec.symbolB}`) ?? null;
      out.push({
        ...rec,
        priceA,
        priceB,
        liveRatio: priceA !== null && priceB ? priceA / priceB : null,
      });
    }
    // Свежие решения и аномалии — сверху.
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  counts(): {
    total: number;
    verified: number;
    auto: number;
    manual: number;
    anomalies: number;
    pending: number;
    rejected: number;
  } {
    const c = { total: 0, verified: 0, auto: 0, manual: 0, anomalies: 0, pending: 0, rejected: 0 };
    for (const r of this.pairs.values()) {
      c.total++;
      if (r.status === 'verified') {
        c.verified++;
        if (r.verificationSource === 'manual') c.manual++;
        else c.auto++;
      } else if (r.status === 'candidate') {
        if (r.category !== null) c.anomalies++;
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
        symbolVotes.set(
          `${r.exchangeA}:${r.symbolA}`,
          (symbolVotes.get(`${r.exchangeA}:${r.symbolA}`) ?? 0) + 1,
        );
        symbolVotes.set(
          `${r.exchangeB}:${r.symbolB}`,
          (symbolVotes.get(`${r.exchangeB}:${r.symbolB}`) ?? 0) + 1,
        );
      }
      const symbolOf = new Map<ExchangeId, string>();
      for (const [key, votes] of symbolVotes) {
        const [exchange, symbol] = key.split(/:(.*)/s) as [ExchangeId, string];
        const cur = symbolOf.get(exchange);
        if (!cur || votes > (symbolVotes.get(`${exchange}:${cur}`) ?? 0))
          symbolOf.set(exchange, symbol);
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
      for (const e of edges)
        pairs.set(pairKey(e.exchangeA, e.exchangeB), e.verifiedAt ?? undefined);
      out.set(base, { pairs, legs });
    }
    this.o.engine.setVerifiedPairs(out);
  }
}
