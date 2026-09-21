/**
 * Стаканы: два уровня глубины по REST.
 *
 * - Неглубокий (топ-20) — для «горячего набора» ног: верхние строки ленты
 *   (см. `setHot`), обновление каждые ~SHALLOW_EVERY_MS. Набор меняется
 *   вместе с лентой; ноги, выпавшие из него, перестают опрашиваться.
 * - Глубокий (до DEEP_LIMIT уровней) — для монеты, открытой в деталях
 *   (`watchDeep`), пока её продолжают запрашивать; через DEEP_TTL_MS без
 *   запросов подписка гаснет.
 *
 * Почему REST, а не WebSocket: потоковый стакан у ccxt — это REST-снимок и
 * ведение книги по диффам на каждый символ; на сотни ног это сотни
 * снимков в минуту и постоянная работа на главном потоке. Опрос по REST
 * раз в несколько секунд по ста с небольшим ногам — ~5 запросов в секунду
 * на биржу, внутри лимитов, и парсинг маленьких ответов. Потоки частичных
 * стаканов (books5/depth20) можно добавить по биржам позже, интерфейс
 * модуля от этого не изменится.
 */
import type { ExchangeId } from '@cs/shared';

import { normalizeBook, type BookLevel } from './liquidity.js';
import { legKey, type VenueMarket } from './universe.js';
import type { ExchangeClient } from './worker/host.js';

export interface BookSnapshot {
  asks: BookLevel[];
  bids: BookLevel[];
  /** Когда получен, мс epoch. */
  updatedAt: number;
  /** Сколько уровней запрошено — «глубокий» или «неглубокий» снимок. */
  limit: number;
  /** Ошибка последнего запроса, если стакан не обновляется. */
  error: string | null;
}

export interface BooksLogger {
  debug(msg: string): void;
  warn(msg: string): void;
}

const SHALLOW_LIMIT = 20;
const DEEP_LIMIT = 100;
/** Как часто обновлять неглубокий стакан одной ноги. */
const SHALLOW_EVERY_MS = 4000;
/** Как часто обновлять глубокий. */
const DEEP_EVERY_MS = 2000;
/** Сколько держать глубокую подписку без запросов. */
const DEEP_TTL_MS = 15_000;
/** Нога выпала из горячего набора — держим её ещё столько (гистерезис у границы топа). */
const HOT_TTL_MS = 5000;
/** Одновременных запросов к одной бирже. */
const CONCURRENCY = 4;
/** Стакан старше этого — не считается (данные устарели). */
export const BOOK_STALE_MS = 10_000;
/** Минимальная пауза между запросами к одной бирже, мс: у MEXC лимит жёстче остальных. */
const MIN_GAP_MS: Partial<Record<ExchangeId, number>> = { mexc: 300, gate: 150, kucoin: 150, bingx: 150 };
const DEFAULT_GAP_MS = 100;

interface Want {
  market: VenueMarket;
  limit: number;
  everyMs: number;
  /** Для глубоких — когда последний раз спрашивали. */
  lastAskedAt: number;
}

export class BookTracker {
  private readonly books = new Map<string, BookSnapshot>();
  private readonly shallow = new Map<string, Want>();
  private readonly deep = new Map<string, Want>();
  private readonly inFlight = new Map<ExchangeId, number>();
  private readonly lastSentAt = new Map<ExchangeId, number>();
  private readonly nextAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly clients: Map<ExchangeId, ExchangeClient>,
    private readonly log: BooksLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 200);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Горячий набор: ноги, для которых нужен неглубокий стакан. Ноги, которых
   * в новом наборе нет, живут ещё HOT_TTL_MS — у границы топа строки
   * меняются местами каждую секунду, и без гистерезиса их стаканы
   * пришлось бы качать заново.
   */
  setHot(legs: VenueMarket[]): void {
    const now = Date.now();
    for (const m of legs) {
      const key = legKey(m.exchange, m.symbol);
      const w = this.shallow.get(key);
      if (w) w.lastAskedAt = now;
      else this.shallow.set(key, { market: m, limit: SHALLOW_LIMIT, everyMs: SHALLOW_EVERY_MS, lastAskedAt: now });
    }
    for (const [key, w] of this.shallow) {
      if (now - w.lastAskedAt > HOT_TTL_MS) {
        this.shallow.delete(key);
        if (!this.deep.has(key)) this.books.delete(key);
      }
    }
  }

  /** Глубокий стакан по ногам монеты — пока её смотрят. */
  watchDeep(legs: VenueMarket[]): void {
    const now = Date.now();
    for (const m of legs) {
      const key = legKey(m.exchange, m.symbol);
      const w = this.deep.get(key);
      if (w) w.lastAskedAt = now;
      else this.deep.set(key, { market: m, limit: DEEP_LIMIT, everyMs: DEEP_EVERY_MS, lastAskedAt: now });
    }
  }

  /** Снимок стакана ноги (любой глубины) или null. */
  get(exchange: ExchangeId, symbol: string): BookSnapshot | null {
    return this.books.get(legKey(exchange, symbol)) ?? null;
  }

  /** Сколько ног опрашивается — для статуса. */
  stats(): { shallow: number; deep: number; books: number; fresh: number; errors: number; fetches: number; avgMs: number } {
    const now = Date.now();
    let fresh = 0;
    let errors = 0;
    for (const b of this.books.values()) {
      if (b.error) errors++;
      else if (now - b.updatedAt <= BOOK_STALE_MS) fresh++;
    }
    return {
      shallow: this.shallow.size,
      deep: this.deep.size,
      books: this.books.size,
      fresh,
      errors,
      fetches: this.fetchCount,
      avgMs: this.fetchCount ? Math.round(this.fetchMs / this.fetchCount) : 0,
    };
  }

  private fetchCount = 0;
  private fetchMs = 0;

  private tick(): void {
    const now = Date.now();
    // Глубокие подписки без запросов — гасим.
    for (const [key, w] of this.deep) {
      if (now - w.lastAskedAt > DEEP_TTL_MS) {
        this.deep.delete(key);
        if (!this.shallow.has(key)) this.books.delete(key);
      }
    }
    // Что пора обновить: глубокие важнее — они на экране у человека.
    const due: [string, Want][] = [];
    for (const [key, w] of this.deep) if ((this.nextAt.get(key) ?? 0) <= now) due.push([key, w]);
    for (const [key, w] of this.shallow) {
      if (this.deep.has(key)) continue;
      if ((this.nextAt.get(key) ?? 0) <= now) due.push([key, w]);
    }
    // Сначала те, у кого стакана ещё нет вообще, потом по очереди.
    due.sort((x, y) => Number(this.books.has(x[0])) - Number(this.books.has(y[0])));
    for (const [key, w] of due) {
      const ex = w.market.exchange;
      if ((this.inFlight.get(ex) ?? 0) >= CONCURRENCY) continue;
      if (now - (this.lastSentAt.get(ex) ?? 0) < (MIN_GAP_MS[ex] ?? DEFAULT_GAP_MS)) continue;
      const client = this.clients.get(ex);
      if (!client) continue;
      this.lastSentAt.set(ex, now);
      this.inFlight.set(ex, (this.inFlight.get(ex) ?? 0) + 1);
      this.nextAt.set(key, now + w.everyMs);
      void this.fetch(client, key, w).finally(() => {
        this.inFlight.set(ex, (this.inFlight.get(ex) ?? 1) - 1);
      });
    }
  }

  private async fetch(client: ExchangeClient, key: string, w: Want): Promise<void> {
    const m = w.market;
    const t0 = Date.now();
    try {
      const ob = await client.fetchOrderBook(m.symbol, w.limit);
      // Цена в стакане — за единицу тикера, количество — в контрактах.
      // m.multiplier — канонический множитель (из названия тикера или из
      // сверки): цена за монету = цена / multiplier, монет в контракте =
      // contractSize × multiplier.
      const norm = { multiplier: m.multiplier, contractSize: m.contractSize };
      const asks = normalizeBook(ob.asks ?? [], norm);
      const bids = normalizeBook(ob.bids ?? [], norm);
      this.books.set(key, { asks, bids, updatedAt: Date.now(), limit: w.limit, error: null });
      this.fetchCount++;
      this.fetchMs += Date.now() - t0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const prev = this.books.get(key);
      if (prev) prev.error = message.slice(0, 120);
      else this.books.set(key, { asks: [], bids: [], updatedAt: 0, limit: w.limit, error: message.slice(0, 120) });
      // Лимит запросов — притормозить всю биржу, а не одну ногу.
      if (/429|418|rate ?limit|too many|too frequent/i.test(message)) {
        const pause = Date.now() + 10_000;
        for (const [k2, w2] of [...this.shallow, ...this.deep]) {
          if (w2.market.exchange === m.exchange) this.nextAt.set(k2, pause);
        }
        this.log.warn(`стаканы: ${m.exchange} просит паузу (${message.slice(0, 60)}), 10 с`);
      } else {
        this.log.debug(`стаканы: ${m.exchange} ${m.symbol}: ${message.slice(0, 80)}`);
      }
    }
  }
}
