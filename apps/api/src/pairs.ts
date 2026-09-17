/**
 * Сверка ног: какой символ на какой бирже — та самая монета.
 *
 * Одинаковый тикер на двух биржах ничего не доказывает: под «TA» или «BB»
 * могут торговаться разные проекты, а `1000SHIB` против `SHIB` — одна монета
 * с другим номиналом. Поэтому в ленту попадают только пары, у которых обе
 * ноги сверены (таблица verified_symbols), а множитель берётся оттуда же.
 *
 * Кандидаты создаются автоматически при загрузке рынков; подтверждает их
 * администратор в приложении. Единственное исключение — нулевая сверка при
 * самом первом запуске: ноги, чья цена совпадает с медианой по другим биржам
 * в пределах 1 %, помечаются сверенными, чтобы лента не опустела в день
 * выкладки. Дальше — только руками.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ExchangeId } from '@cs/shared';
import {
  legKey,
  type LegStatus,
  type LegVerification,
  type MarketEngine,
  type VenueMarket,
} from '@cs/market';

import type { Repo, VerifiedSymbolRecord } from './repo/index.js';

export interface PairsOptions {
  repo: Repo;
  engine: MarketEngine | null;
  log: FastifyBaseLogger;
  /** Кого звать, когда появились новые кандидаты. */
  onNewCandidates?: (count: number) => void;
}

/** Нога с живой ценой и отношением к медиане — для экрана сверки. */
export interface LegView extends VerifiedSymbolRecord {
  price: number | null;
  /** price / медиана сверенных ног той же монеты; null — сравнивать не с чем. */
  ratio: number | null;
  /** Сколько сверенных ног у этой монеты (кроме этой). */
  peers: number;
}

const AUTO_TOLERANCE = 0.01;

export class PairsService {
  private entries = new Map<string, LegVerification>();
  private bootstrapped = false;

  constructor(private readonly o: PairsOptions) {}

  /** Загрузить таблицу из базы и отдать движку. */
  async load(): Promise<void> {
    const rows = await this.o.repo.listVerifiedSymbols();
    this.entries = new Map(
      rows.map((r) => [
        legKey(r.exchange, r.symbol),
        { status: r.status, multiplier: r.multiplier, verifiedAt: r.verifiedAt ?? undefined },
      ]),
    );
    this.o.engine?.setVerification(this.entries);
    this.o.log.info(
      `сверка: ног в таблице ${rows.length}, сверено ${rows.filter((r) => r.status === 'verified').length}`,
    );
  }

  /**
   * Биржа отдала рынки: всё, чего нет в таблице, становится кандидатом.
   * Множитель по умолчанию — из тикера (1000PEPE → 1000).
   */
  private syncChain: Promise<void> = Promise.resolve();

  /** Вызовы идут по очереди: параллельные создавали бы одних и тех же кандидатов дважды. */
  syncMarkets(exchange: ExchangeId, markets: VenueMarket[]): Promise<void> {
    const next = this.syncChain.then(() => this.syncMarketsNow(exchange, markets));
    this.syncChain = next.catch(() => {});
    return next;
  }

  private async syncMarketsNow(exchange: ExchangeId, markets: VenueMarket[]): Promise<void> {
    const fresh: VerifiedSymbolRecord[] = [];
    for (const m of markets) {
      if (this.entries.has(legKey(m.exchange, m.symbol))) continue;
      fresh.push({
        base: m.base,
        exchange: m.exchange,
        symbol: m.symbol,
        multiplier: m.multiplier,
        status: 'candidate',
        note: null,
        updatedAt: Date.now(),
        updatedBy: 'system',
        verifiedAt: null,
      });
    }
    if (fresh.length === 0) return;
    await this.o.repo.upsertVerifiedSymbols(fresh);
    for (const r of fresh) {
      this.entries.set(legKey(r.exchange, r.symbol), {
        status: r.status,
        multiplier: r.multiplier,
        verifiedAt: r.verifiedAt ?? undefined,
      });
    }
    this.o.engine?.setVerification(this.entries);
    this.o.log.info(`сверка: ${exchange} — новых кандидатов ${fresh.length}`);
    if (this.bootstrapped) this.o.onNewCandidates?.(fresh.length);
  }

  /**
   * Нулевая сверка — только если в таблице ещё нет ни одной сверенной ноги.
   * Вызывать, когда котировки уже идут (минуту-две после старта).
   */
  async bootstrapIfEmpty(): Promise<number> {
    this.bootstrapped = true;
    const rows = await this.o.repo.listVerifiedSymbols();
    if (rows.some((r) => r.status === 'verified')) return 0;
    if (!this.o.engine) return 0;

    // Цена каждой ноги за одну монету; медиана по монете; в пределах 1 % — сверено.
    const byBase = new Map<string, { rec: VerifiedSymbolRecord; price: number }[]>();
    for (const rec of rows) {
      if (rec.status !== 'candidate') continue;
      const price = this.o.engine.legPrice(rec.exchange, rec.symbol, rec.multiplier);
      if (price === null) continue;
      const list = byBase.get(rec.base) ?? [];
      list.push({ rec, price });
      byBase.set(rec.base, list);
    }
    const verified: VerifiedSymbolRecord[] = [];
    for (const list of byBase.values()) {
      if (list.length < 2) continue;
      const med = median(list.map((x) => x.price));
      const agree = list.filter((x) => Math.abs(x.price / med - 1) <= AUTO_TOLERANCE);
      // Совпадение с медианой из двух ног — тавтология; нужна хотя бы третья
      // или обе ноги в пределах допуска друг к другу.
      if (agree.length >= 2) {
        for (const x of agree) {
          verified.push({
            ...x.rec,
            status: 'verified',
            note: 'auto',
            updatedBy: 'bootstrap',
            updatedAt: Date.now(),
            // Нулевая сверка — это не листинг: помечать сотни монет «новыми» незачем.
            verifiedAt: Date.now() - 30 * 86_400_000,
          });
        }
      }
    }
    if (verified.length) {
      await this.o.repo.upsertVerifiedSymbols(verified);
      for (const r of verified) {
        this.entries.set(legKey(r.exchange, r.symbol), {
          status: r.status,
          multiplier: r.multiplier,
        });
      }
      this.o.engine.setVerification(this.entries);
    }
    this.o.log.info(`сверка: нулевая сверка — сверено ${verified.length} ног из ${rows.length}`);
    return verified.length;
  }

  /** Ручное решение администратора. */
  async setStatus(
    exchange: ExchangeId,
    symbol: string,
    status: LegStatus,
    multiplier: number | undefined,
    by: string,
  ): Promise<VerifiedSymbolRecord | null> {
    const rows = await this.o.repo.listVerifiedSymbols();
    const rec = rows.find((r) => r.exchange === exchange && r.symbol === symbol);
    if (!rec) return null;
    const next: VerifiedSymbolRecord = {
      ...rec,
      status,
      multiplier: multiplier && multiplier > 0 ? multiplier : rec.multiplier,
      updatedAt: Date.now(),
      updatedBy: by,
      verifiedAt: status === 'verified' ? (rec.verifiedAt ?? Date.now()) : rec.verifiedAt,
    };
    await this.o.repo.upsertVerifiedSymbols([next]);
    this.entries.set(legKey(exchange, symbol), {
      status: next.status,
      multiplier: next.multiplier,
      verifiedAt: next.verifiedAt ?? undefined,
    });
    this.o.engine?.setVerification(this.entries);
    return next;
  }

  /** Массово: все кандидаты, чья цена в пределах допуска к медиане сверенных ног. */
  async verifyAllMatching(by: string, tolerance = AUTO_TOLERANCE): Promise<number> {
    const legs = await this.list();
    const ok = legs.filter(
      (l) => l.status === 'candidate' && l.ratio !== null && Math.abs(l.ratio - 1) <= tolerance,
    );
    if (ok.length === 0) return 0;
    const rows = ok.map((l) => ({
      ...toRecord(l),
      status: 'verified' as const,
      note: 'auto-ratio',
      updatedAt: Date.now(),
      updatedBy: by,
      verifiedAt: l.verifiedAt ?? Date.now(),
    }));
    await this.o.repo.upsertVerifiedSymbols(rows);
    for (const r of rows) {
      this.entries.set(legKey(r.exchange, r.symbol), {
        status: r.status,
        multiplier: r.multiplier,
        verifiedAt: r.verifiedAt ?? undefined,
      });
    }
    this.o.engine?.setVerification(this.entries);
    return rows.length;
  }

  /** Все ноги с ценой и отношением к медиане сверенных той же монеты. */
  async list(): Promise<LegView[]> {
    const rows = await this.o.repo.listVerifiedSymbols();
    const engine = this.o.engine;
    const verifiedPrices = new Map<string, number[]>();
    const priceOf = new Map<string, number | null>();
    for (const r of rows) {
      const price = engine ? engine.legPrice(r.exchange, r.symbol, r.multiplier) : null;
      priceOf.set(legKey(r.exchange, r.symbol), price);
      if (r.status === 'verified' && price !== null) {
        verifiedPrices.set(r.base, [...(verifiedPrices.get(r.base) ?? []), price]);
      }
    }
    return rows.map((r) => {
      const price = priceOf.get(legKey(r.exchange, r.symbol)) ?? null;
      const peersAll = verifiedPrices.get(r.base) ?? [];
      // Свою цену из медианы исключаем, иначе одинокая сверенная нога всегда «совпадает».
      const peers = r.status === 'verified' && price !== null ? without(peersAll, price) : peersAll;
      const ratio = price !== null && peers.length > 0 ? price / median(peers) : null;
      return { ...r, price, ratio, peers: peers.length };
    });
  }

  counts(): { total: number; verified: number; candidate: number } {
    let verified = 0;
    let candidate = 0;
    for (const v of this.entries.values()) {
      if (v.status === 'verified') verified++;
      else if (v.status === 'candidate') candidate++;
    }
    return { total: this.entries.size, verified, candidate };
  }
}

function toRecord(l: LegView): VerifiedSymbolRecord {
  return {
    base: l.base,
    exchange: l.exchange,
    symbol: l.symbol,
    multiplier: l.multiplier,
    status: l.status,
    note: l.note,
    updatedAt: l.updatedAt,
    updatedBy: l.updatedBy,
    verifiedAt: l.verifiedAt,
  };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function without(values: number[], one: number): number[] {
  const i = values.indexOf(one);
  return i < 0 ? values : [...values.slice(0, i), ...values.slice(i + 1)];
}
