/**
 * Рыночный движок: собирает котировки со всех бирж и считает спреды.
 *
 * Спред считается по стакану, а не по последней сделке: покупаем по ask на
 * дешёвой бирже, продаём по bid на дорогой. Это та цифра, по которой сделка
 * реально исполнится, — и она честно бывает отрицательной, когда арбитража
 * нет. Такие монеты из списка не исчезают: ТЗ требует показывать все.
 *
 * Котировка старше staleMs в расчёт не входит. Без этого оборванное
 * соединение оставляет замершую цену, и на её фоне живые цены других бирж
 * рисуют фантомный спред — самый опасный вид ложного сигнала.
 */
import ccxt, { type Exchange } from 'ccxt';
import type { CoinDetail, ExchangeId, ScreenerSnapshot, SpreadRow, VenueQuote } from '@cs/shared';

import { Feed, type FeedLogger, type FeedState, type Quote } from './feed.js';
import { FundingTracker } from './funding.js';
import { coinName } from './names.js';
import { buildUniverse, venueMarkets, type Universe, type VenueMarket } from './universe.js';

/** Идентификаторы ccxt отличаются от наших только у KuCoin: фьючерсы у неё отдельный класс. */
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

/** Выплата фандинга на всех восьми — раз в 8 часов. */
const FUNDING_PERIOD_MS = 8 * 60 * 60 * 1000;

/**
 * Спред между перпетуалами одного актива больше этого не бывает даже в
 * панику. Если больше — под одним тикером на двух биржах разные монеты,
 * либо один из рынков мёртв. Показывать такое как возможность нельзя.
 */
const MAX_PLAUSIBLE_SPREAD_PCT = 20;

/**
 * Биржи, которым WebSocket на сотни символов не по силам: KuCoin режет
 * подписку с длинным списком топиков. REST-опрос всех тикеров одним запросом
 * у них работает без нареканий.
 */
const REST_ONLY: ReadonlySet<ExchangeId> = new Set<ExchangeId>(['kucoin']);

export interface EngineOptions {
  exchanges: ExchangeId[];
  /** Котировка старше этого — не участвует в расчёте. */
  staleMs: number;
  /** Интервал REST-опроса там, где нет WebSocket. */
  pollMs: number;
  /** Горизонт удержания позиции — столько фандинга учитываем в чистом профите. */
  holdMinutes: number;
  /** Прокси до бирж, если они недоступны напрямую. */
  httpsProxy?: string;
  log: FeedLogger;
}

export interface EngineStatus {
  ready: boolean;
  startedAt: number | null;
  universeSize: number;
  feeds: FeedState[];
  fundingUnsupported: ExchangeId[];
}

interface VenueSnapshot {
  market: VenueMarket;
  quote: Quote;
  fresh: boolean;
}

export class MarketEngine {
  private clients = new Map<ExchangeId, Exchange>();
  private feeds = new Map<ExchangeId, Feed>();
  private funding: FundingTracker | null = null;
  private universe: Universe = { byBase: new Map(), bySymbol: new Map() };
  /** base → exchange → последняя котировка. */
  private quotes = new Map<string, Map<ExchangeId, Quote>>();
  private startedAt: number | null = null;
  private ready = false;

  constructor(private readonly opts: EngineOptions) {}

  // ---------------------------------------------------------------- жизненный цикл

  async start(): Promise<void> {
    const { log } = this.opts;
    this.startedAt = Date.now();

    // Рынки грузим параллельно: Gate отвечает по 15 секунд, ждать его
    // последовательно — терять полминуты на старте.
    const loaded = await Promise.all(
      this.opts.exchanges.map(async (id) => {
        const client = this.createClient(id);
        try {
          const t0 = Date.now();
          await client.loadMarkets();
          const markets = venueMarkets(id, client);
          log.info(`${id}: рынков ${markets.length} за ${Date.now() - t0}мс`);
          this.clients.set(id, client);
          return markets;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`${id}: не загрузил рынки (${message.slice(0, 100)}) — биржа пропущена`);
          return [] as VenueMarket[];
        }
      }),
    );

    this.universe = buildUniverse(loaded.flat());
    log.info(`вселенная: ${this.universe.byBase.size} монет минимум на двух биржах`);

    const perExchange = new Map<ExchangeId, VenueMarket[]>();
    for (const list of this.universe.byBase.values()) {
      for (const m of list) {
        const arr = perExchange.get(m.exchange) ?? [];
        arr.push(m);
        perExchange.set(m.exchange, arr);
      }
    }

    for (const [id, client] of this.clients) {
      const markets = perExchange.get(id) ?? [];
      const feed = new Feed({
        exchange: id,
        client,
        markets,
        pollMs: this.opts.pollMs,
        log,
        onQuote: (market, quote) => this.onQuote(market, quote),
      });
      this.feeds.set(id, feed);
      feed.start();
    }

    this.funding = new FundingTracker(this.clients, perExchange, log);
    this.funding.start();
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.funding?.stop();
    await Promise.all([...this.feeds.values()].map((f) => f.stop()));
    this.feeds.clear();
    this.clients.clear();
  }

  private createClient(id: ExchangeId): Exchange {
    const Ctor = (ccxt.pro as unknown as Record<string, new (cfg: object) => Exchange>)[
      CCXT_ID[id]
    ]!;
    const client = new Ctor({
      enableRateLimit: true,
      // Gate отдаёт список рынков по 15 секунд — штатных десяти не хватает.
      timeout: 30_000,
      options: {
        defaultType: 'swap',
        // Нам нужны только перпетуалы; опционы и спот Gate грузит отдельными
        // запросами, и именно опционы у неё отваливаются по таймауту.
        ...(id === 'gate' ? { fetchMarkets: { types: ['swap'] } } : {}),
      },
      ...(this.opts.httpsProxy ? { httpsProxy: this.opts.httpsProxy } : {}),
    });
    if (REST_ONLY.has(id)) {
      // Feed выбирает режим по наличию watchTickers — прячем его.
      client.has['watchTickers'] = false;
    }
    return client;
  }

  private onQuote(market: VenueMarket, quote: Quote): void {
    let byVenue = this.quotes.get(market.base);
    if (!byVenue) {
      byVenue = new Map();
      this.quotes.set(market.base, byVenue);
    }
    byVenue.set(market.exchange, quote);
  }

  // ---------------------------------------------------------------- состояние

  status(): EngineStatus {
    return {
      ready: this.ready,
      startedAt: this.startedAt,
      universeSize: this.universe.byBase.size,
      feeds: [...this.feeds.values()].map((f) => ({ ...f.state })),
      fundingUnsupported: [...(this.funding?.unsupported ?? [])],
    };
  }

  bases(): string[] {
    return [...this.universe.byBase.keys()].sort();
  }

  // ---------------------------------------------------------------- расчёт

  private venuesFor(base: string, filter?: ExchangeId[]): VenueSnapshot[] {
    const markets = this.universe.byBase.get(base) ?? [];
    const byVenue = this.quotes.get(base);
    if (!byVenue) return [];
    const now = Date.now();
    const out: VenueSnapshot[] = [];
    for (const market of markets) {
      if (filter && !filter.includes(market.exchange)) continue;
      const quote = byVenue.get(market.exchange);
      if (!quote) continue;
      out.push({ market, quote, fresh: now - quote.receivedAt <= this.opts.staleMs });
    }
    return out;
  }

  private fundingPct(exchange: ExchangeId, symbol: string): number | null {
    const info = this.funding?.get(exchange, symbol);
    return info ? info.rate * 100 : null;
  }

  /** Строка скринера по монете; null — если сравнивать не с чем. */
  private buildRow(base: string, filter?: ExchangeId[]): SpreadRow | null {
    const all = this.venuesFor(base, filter);
    if (all.length < 2) return null;

    // Считаем по свежим; если свежих меньше двух — по всем, но строка
    // помечается устаревшей и на вход не годится.
    const fresh = all.filter((v) => v.fresh);
    const pool = fresh.length >= 2 ? fresh : all;
    const stale = fresh.length < 2;

    let long = pool[0]!;
    let short = pool[0]!;
    for (const v of pool) {
      if (v.quote.ask < long.quote.ask) long = v;
      if (v.quote.bid > short.quote.bid) short = v;
    }
    if (long.market.exchange === short.market.exchange) {
      // Одна и та же биржа лучшая по обеим ногам — берём вторую лучшую для шорта.
      let second: VenueSnapshot | null = null;
      for (const v of pool) {
        if (v.market.exchange === long.market.exchange) continue;
        if (!second || v.quote.bid > second.quote.bid) second = v;
      }
      if (!second) return null;
      short = second;
    }

    const longPrice = long.quote.ask;
    const shortPrice = short.quote.bid;
    const spreadAbs = shortPrice - longPrice;
    const spreadPct = (spreadAbs / longPrice) * 100;

    // Четыре тейкера: вход и выход по каждой из двух ног.
    const feesPct = 2 * (long.market.taker + short.market.taker) * 100;

    const periods = this.opts.holdMinutes / (FUNDING_PERIOD_MS / 60_000);
    const fLong = this.fundingPct(long.market.exchange, long.market.symbol);
    const fShort = this.fundingPct(short.market.exchange, short.market.symbol);
    const fundingKnown = fLong !== null && fShort !== null;
    // Лонг платит ставку, шорт получает — значит выгода равна разнице.
    const fundingPct = fundingKnown ? (fShort - fLong) * periods : 0;

    const suspect = Math.abs(spreadPct) > MAX_PLAUSIBLE_SPREAD_PCT;
    if (suspect && !this.reportedSuspects.has(base)) {
      this.reportedSuspects.add(base);
      this.opts.log.warn(
        `${base}: спред ${spreadPct.toFixed(0)}% между ${long.market.exchange} и ` +
          `${short.market.exchange} — похоже, разные активы под одним тикером`,
      );
    }

    const symbol = `${base}/USDT:USDT`;
    return {
      symbol,
      base,
      name: coinName(base),
      longExchange: long.market.exchange,
      longPrice,
      shortExchange: short.market.exchange,
      shortPrice,
      spreadAbs,
      spreadPct,
      netPct: spreadPct - feesPct + fundingPct,
      fundingPct,
      feesPct,
      quotedAt: Math.min(long.quote.receivedAt, short.quote.receivedAt),
      stale,
      fundingKnown,
      suspect,
    };
  }

  private cache: { key: string; at: number; value: ScreenerSnapshot } | null = null;
  /** Чтобы каждая коллизия тикеров попала в лог один раз, а не раз в секунду. */
  private readonly reportedSuspects = new Set<string>();

  snapshot(minSpreadPct: number, filter?: ExchangeId[]): ScreenerSnapshot {
    // Пять клиентов, опрашивающих раз в секунду, не должны пять раз считать
    // одно и то же: снимок живёт 250 мс.
    const key = `${minSpreadPct}|${(filter ?? []).join(',')}`;
    const now = Date.now();
    if (this.cache && this.cache.key === key && now - this.cache.at < 250) return this.cache.value;

    const rows: SpreadRow[] = [];
    for (const base of this.universe.byBase.keys()) {
      const row = this.buildRow(base, filter);
      if (row) rows.push(row);
    }
    // Подозрительные — в самый конец: их спред не имеет смысла как число.
    rows.sort((a, b) => {
      if (a.suspect !== b.suspect) return a.suspect ? 1 : -1;
      return b.spreadPct - a.spreadPct;
    });

    const passing = rows.filter((r) => !r.stale && !r.suspect && r.spreadPct >= minSpreadPct);
    const value: ScreenerSnapshot = {
      rows,
      opportunities: passing.length,
      avgSpreadPct: passing.length
        ? passing.reduce((s, r) => s + r.spreadPct, 0) / passing.length
        : 0,
      trend: [],
      refreshMs: 1000,
      updatedAt: now,
      botRunning: true,
    };
    this.cache = { key, at: now, value };
    return value;
  }

  coinDetail(base: string): CoinDetail | undefined {
    const canonical = this.bases().find((b) => b.toLowerCase() === base.toLowerCase());
    if (!canonical) return undefined;
    const row = this.buildRow(canonical);
    if (!row) return undefined;

    const now = Date.now();
    const quotes: VenueQuote[] = this.venuesFor(canonical)
      .map((v) => {
        const info = this.funding?.get(v.market.exchange, v.market.symbol);
        return {
          exchange: v.market.exchange,
          price: v.quote.last,
          bid: v.quote.bid,
          ask: v.quote.ask,
          fundingPct: info ? info.rate * 100 : 0,
          nextFundingAt: info?.nextAt ?? 0,
          updatedAt: v.quote.receivedAt,
          stale: !v.fresh,
        };
      })
      .sort((a, b) => a.price - b.price);

    return {
      symbol: row.symbol,
      base: canonical,
      name: coinName(canonical),
      quotes,
      best: {
        longExchange: row.longExchange,
        shortExchange: row.shortExchange,
        spreadAbs: row.spreadAbs,
        spreadPct: row.spreadPct,
        netPct: row.netPct,
        feesPct: row.feesPct,
        fundingPct: row.fundingPct,
      },
      updatedAt: now,
    };
  }
}
