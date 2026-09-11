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

/** Какие типы рынков грузить при loadMarkets — только линейные перпетуалы. */
const MARKET_SCOPE: Record<ExchangeId, Record<string, unknown>> = {
  binance: { fetchMarkets: ['linear'] },
  bybit: { fetchMarkets: ['linear'] },
  okx: { fetchMarkets: ['swap'] },
  mexc: { fetchMarkets: ['swap'] },
  bitget: { fetchMarkets: ['swap'] },
  bingx: { fetchMarkets: ['swap'] },
  gate: { fetchMarkets: { types: ['swap'] } },
  kucoin: {},
};

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

  /** Рынки каждой биржи по отдельности — из них пересобирается вселенная. */
  private readonly marketsByExchange = new Map<ExchangeId, VenueMarket[]>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /**
   * Каждая биржа подключается независимо. Ждать все восемь разом нельзя:
   * одна зависшая держала бы весь запуск, а на сервере такое случается
   * регулярно. Вселенная пересобирается по мере прихода бирж; те, что не
   * загрузились, пробуются снова раз в минуту.
   */
  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.running = true;

    await Promise.all(this.opts.exchanges.map((id) => this.connect(id)));

    this.retryTimer = setInterval(() => {
      for (const id of this.opts.exchanges) {
        if (!this.clients.has(id)) void this.connect(id);
      }
    }, 60_000);
  }

  private async connect(id: ExchangeId): Promise<void> {
    if (!this.running || this.clients.has(id)) return;
    const { log } = this.opts;
    const client = this.createClient(id);
    const t0 = Date.now();

    let markets: VenueMarket[];
    try {
      await client.loadMarkets();
      markets = venueMarkets(id, client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${id}: не загрузил рынки (${message.slice(0, 100)}) — попробую через минуту`);
      return;
    }
    if (!this.running) return;

    log.info(`${id}: рынков ${markets.length} за ${Date.now() - t0}мс`);
    this.clients.set(id, client);
    this.marketsByExchange.set(id, markets);
    this.rebuildUniverse();

    // Поток следит за всеми рынками своей биржи, а не только за теми, что
    // сейчас во вселенной: когда позже подключится ещё одна биржа, часть монет
    // станет «общей», и их котировки уже должны быть под рукой.
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

    // Фандинг-трекер один на всех; при появлении новой биржи пересоздаём —
    // это дешёвый REST-опрос раз в минуту.
    this.funding?.stop();
    this.funding = new FundingTracker(this.clients, this.marketsByExchange, log);
    this.funding.start();

    // Готовы, когда есть хотя бы две биржи — до того сравнивать не с чем.
    if (!this.ready && this.clients.size >= 2) {
      this.ready = true;
      log.info(`вселенная: ${this.universe.byBase.size} монет минимум на двух биржах`);
    }
  }

  private rebuildUniverse(): void {
    this.universe = buildUniverse([...this.marketsByExchange.values()].flat());
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ready = false;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
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
        // Грузим только линейные перпетуалы. Спот, обратные контракты и
        // опционы нам не нужны, а каждый из них — отдельный запрос, и именно
        // они отваливаются по таймауту на слабой сети. Формат опции у бирж
        // разный; лишнюю ccxt просто не замечает.
        ...MARKET_SCOPE[id],
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

    // Числа округляем до того, что вообще имеет смысл показывать: цена с
    // 17 знаками после запятой раздувает JSON вдвое и ничего не добавляет.
    const r6 = (v: number) => Number(v.toPrecision(8));
    const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
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
      longPrice: r6(longPrice),
      shortExchange: short.market.exchange,
      shortPrice: r6(shortPrice),
      spreadAbs: r6(spreadAbs),
      spreadPct: r4(spreadPct),
      netPct: r4(spreadPct - feesPct + fundingPct),
      fundingPct: r4(fundingPct),
      feesPct: r4(feesPct),
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
    // Порядок: свежие, потом устаревшие, потом подозрительные. Устаревшая
    // строка с большим спредом — почти всегда фантом от замершей котировки,
    // ей нечего делать выше живых цифр. Подозрительные — в самый конец: их
    // спред не имеет смысла как число.
    const rank = (r: SpreadRow) => (r.suspect ? 2 : r.stale ? 1 : 0);
    rows.sort((a, b) => rank(a) - rank(b) || b.spreadPct - a.spreadPct);

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
