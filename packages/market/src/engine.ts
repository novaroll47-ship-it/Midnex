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
import type {
  CoinDetail,
  ExchangeId,
  LiquidityDetail,
  ScreenerSnapshot,
  SpreadRow,
  VenueQuote,
} from '@cs/shared';

import { BOOK_STALE_MS, BookTracker } from './books.js';
import type { FeedLogger, FeedState, GapReason, Quote } from './feed.js';
import { DEFAULT_MIN_NET_PCT, recommendVolume, spreadOnVolume } from './liquidity.js';
import { FundingTracker } from './funding.js';
import { coinName } from './names.js';
import {
  buildUniverse,
  legKey,
  pairKey,
  venueMarkets,
  type Universe,
  type VenueMarket,
  type VerifiedPairSet,
} from './universe.js';
import { ExchangeWorkerHost, type ExchangeClient, type ExchangeProxy } from './worker/host.js';

/** Пока worker ещё не прислал состояние потока — «подключается». */
function emptyFeedState(exchange: ExchangeId): FeedState {
  return {
    exchange,
    mode: 'ws',
    status: 'starting',
    symbols: 0,
    quoted: 0,
    lastUpdateAt: null,
    latencyMs: null,
    reconnects: 0,
    lastError: null,
  };
}

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

/** Столько после сверки нога считается «новой» в ленте. */
const NEW_LISTING_MS = 7 * 86_400_000;

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
  /** Вызывается, когда меняется набор рынков (подключилась биржа, перезагрузка). */
  onMarketsChanged?: (exchange: ExchangeId, markets: VenueMarket[]) => void;
  /** Биржа замолчала (reason) или снова заговорила (null). */
  onGap?: (exchange: ExchangeId, reason: GapReason | null) => void;
  /** Защитный порог чистого спреда для рекомендуемого объёма, % (по умолчанию 0,3). */
  liquidityMinNetPct?: number;
  /** Сколько верхних строк ленты держать со стаканами (по умолчанию 60). */
  hotRows?: number;
  /** Сколько worker-потоков под ccxt (по умолчанию 4; биржи раскладываются по кругу). */
  workers?: number;
  /** Файл worker'а; по умолчанию — рядом со сборкой (dist/exchange-worker.js) или исходник. */
  workerFile?: URL | string;
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
  private clients = new Map<ExchangeId, ExchangeClient>();
  /** Прокси бирж с запущенным потоком котировок — для статуса и остановки. */
  private feeds = new Map<ExchangeId, ExchangeProxy>();
  /** Пул worker'ов с ccxt. */
  private readonly host: ExchangeWorkerHost;
  private funding: FundingTracker | null = null;
  private universe: Universe = { byBase: new Map(), bySymbol: new Map(), pairsByBase: new Map() };
  /** base → exchange → последняя котировка. */
  /** Котировки: монета → «биржа:символ» → котировка. По символу, а не по бирже:
   *  одна биржа листит и CAT, и 1000CAT — с ключом по бирже они затирали друг друга. */
  private quotes = new Map<string, Map<string, Quote>>();
  private startedAt: number | null = null;
  private ready = false;
  /** Стаканы по REST: горячий набор ног ленты и глубокие — по открытой монете. */
  private readonly books: BookTracker;

  constructor(private readonly opts: EngineOptions) {
    this.books = new BookTracker(this.clients, {
      debug: (m) => opts.log.debug?.(m),
      warn: (m) => opts.log.warn(m),
    });
    this.host = new ExchangeWorkerHost(
      opts.workerFile ?? ExchangeWorkerHost.workerFile(),
      Math.max(1, opts.workers ?? 4),
      opts.log,
      (exchange, why) => this.onExchangeLost(exchange, why),
    );
  }

  /** Worker с биржей упал: забываем клиента, таймер повторов подключит заново. */
  private onExchangeLost(exchange: ExchangeId, why: string): void {
    this.clients.delete(exchange);
    this.feeds.delete(exchange);
    this.opts.onGap?.(exchange, 'ws_closed');
    this.opts.log.warn(`${exchange}: потеряна (${why}), переподключу через минуту`);
  }

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
    this.books.start();

    await Promise.all(this.opts.exchanges.map((id) => this.connect(id)));

    this.retryTimer = setInterval(() => {
      for (const id of this.opts.exchanges) {
        if (!this.clients.has(id)) void this.connect(id);
      }
    }, 60_000);
  }

  /** Биржи, у которых загрузка рынков уже идёт — чтобы не запускать вторую. */
  private readonly connecting = new Set<ExchangeId>();

  /**
   * Перечитать список инструментов подключённой биржи (мониторинг листингов).
   * Поток не пересоздаётся: новые символы попадут в ленту после сверки, а
   * подписка на них — при следующем переподключении сокета. Возвращает
   * добавленные и исчезнувшие символы.
   */
  async refreshMarkets(
    id: ExchangeId,
  ): Promise<{ added: VenueMarket[]; removed: VenueMarket[] } | null> {
    const client = this.clients.get(id);
    if (!client || !this.running) return null;
    await Promise.race([
      client.loadMarkets(true),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`loadMarkets дольше ${MarketEngine.LOAD_MARKETS_DEADLINE_MS}мс`)),
          MarketEngine.LOAD_MARKETS_DEADLINE_MS,
        ),
      ),
    ]);
    const fresh = venueMarkets(id, client.markets);
    const before = this.marketsByExchange.get(id) ?? [];
    const beforeKeys = new Set(before.map((m) => m.symbol));
    const freshKeys = new Set(fresh.map((m) => m.symbol));
    const added = fresh.filter((m) => !beforeKeys.has(m.symbol));
    const removed = before.filter((m) => !freshKeys.has(m.symbol));
    if (added.length || removed.length) {
      this.marketsByExchange.set(id, fresh);
      this.rebuildUniverse();
      this.opts.onMarketsChanged?.(id, fresh);
    }
    return { added, removed };
  }

  /**
   * Жёсткий предел на загрузку рынков. Таймаут ccxt действует на один запрос,
   * а loadMarkets у некоторых бирж — это цепочка запросов; зависший
   * посередине держит попытку вечно и блокирует повтор.
   */
  private static readonly LOAD_MARKETS_DEADLINE_MS = 45_000;

  private async connect(id: ExchangeId): Promise<void> {
    if (!this.running || this.clients.has(id) || this.connecting.has(id)) return;
    this.connecting.add(id);
    try {
      await this.connectOnce(id);
    } finally {
      this.connecting.delete(id);
    }
  }

  private async connectOnce(id: ExchangeId): Promise<void> {
    const { log } = this.opts;
    const client = this.createClient(id);
    const t0 = Date.now();

    let markets: VenueMarket[];
    try {
      await Promise.race([
        client.loadMarkets(),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`loadMarkets дольше ${MarketEngine.LOAD_MARKETS_DEADLINE_MS}мс`)),
            MarketEngine.LOAD_MARKETS_DEADLINE_MS,
          ),
        ),
      ]);
      markets = venueMarkets(id, client.markets);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${id}: не загрузил рынки (${message.slice(0, 100)}) — попробую через минуту`);
      try {
        await client.close();
      } catch {
        // Клиент мог и не открыть соединений.
      }
      return;
    }
    if (!this.running) return;

    log.info(`${id}: рынков ${markets.length} за ${Date.now() - t0}мс`);
    this.clients.set(id, client);
    this.marketsByExchange.set(id, markets);
    this.rebuildUniverse();
    this.opts.onMarketsChanged?.(id, markets);

    // Поток следит за всеми рынками своей биржи, а не только за теми, что
    // сейчас во вселенной: когда позже подключится ещё одна биржа, часть монет
    // станет «общей», и их котировки уже должны быть под рукой. Сам поток
    // живёт в worker'е; сюда приходят пачки котировок (см. createClient).
    client.startFeed(markets, this.opts.pollMs);
    this.feeds.set(id, client);

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

  /** Сверенные пары по монетам: пока не заданы — вселенная строится без фильтра. */
  private verification: Map<string, VerifiedPairSet> | null = null;

  /** Подставить таблицу сверки и пересобрать вселенную. */
  setVerifiedPairs(byBase: Map<string, VerifiedPairSet>): void {
    this.verification = byBase;
    this.rebuildUniverse();
  }

  /** Клиент биржи (прокси в worker) — для фоновых REST-задач: свечи, история фандинга. */
  clientFor(exchange: ExchangeId): ExchangeClient | undefined {
    return this.clients.get(exchange);
  }

  /** Ноги монеты во вселенной (только сверенные, если сверка включена). */
  legsOf(base: string): { exchange: ExchangeId; symbol: string }[] {
    return (this.universe.byBase.get(base) ?? []).map((m) => ({
      exchange: m.exchange,
      symbol: m.symbol,
    }));
  }

  /** Ноги монеты с множителем к канонической цене — для реконструкции по свечам. */
  legsWithMultiplier(base: string): { exchange: ExchangeId; symbol: string; multiplier: number }[] {
    return (this.universe.byBase.get(base) ?? []).map((m) => ({
      exchange: m.exchange,
      symbol: m.symbol,
      multiplier: m.multiplier,
    }));
  }

  /** Все ноги вселенной — для фоновой загрузки истории. */
  allLegs(): { exchange: ExchangeId; symbol: string }[] {
    const out: { exchange: ExchangeId; symbol: string }[] = [];
    for (const list of this.universe.byBase.values()) {
      for (const m of list) out.push({ exchange: m.exchange, symbol: m.symbol });
    }
    return out;
  }

  /** Все рынки всех подключённых бирж — для создания кандидатов на сверку. */
  allMarkets(): VenueMarket[] {
    return [...this.marketsByExchange.values()].flat();
  }

  /**
   * Цена ноги за одну «настоящую» монету при заданном множителе — для
   * сравнения с другими биржами при сверке. null — котировки ещё нет.
   */
  legPrice(exchange: ExchangeId, symbol: string, multiplier: number): number | null {
    const market = this.marketsByExchange.get(exchange)?.find((m) => m.symbol === symbol);
    if (!market) return null;
    const q = this.quotes.get(market.base)?.get(`${exchange}:${symbol}`);
    if (!q) return null;
    // Поток уже поделил цену на множитель из тикера; возвращаем сырую и делим на нужный.
    return (q.last * market.multiplier) / multiplier;
  }

  /**
   * Сырые цены (last, за контракт как торгуется) всех ног всех бирж одним
   * проходом — для автосверки, которой нужны тысячи цен разом.
   */
  rawPrices(): Map<string, number> {
    const out = new Map<string, number>();
    const now = Date.now();
    for (const [exchange, markets] of this.marketsByExchange) {
      for (const m of markets) {
        const q = this.quotes.get(m.base)?.get(`${exchange}:${m.symbol}`);
        // Замершая котировка для сверки хуже отсутствующей: она рождает фантомные аномалии.
        if (q && now - q.receivedAt <= this.opts.staleMs) out.set(`${exchange}:${m.symbol}`, q.last * m.multiplier);
      }
    }
    return out;
  }

  /** Размер контракта из метаданных биржи — источник номинала для сверки. */
  contractSizes(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [exchange, markets] of this.marketsByExchange) {
      for (const m of markets) out.set(`${exchange}:${m.symbol}`, m.contractSize);
    }
    return out;
  }

  private rebuildUniverse(): void {
    const verify = this.verification ? (base: string) => this.verification!.get(base) : undefined;
    this.universe = buildUniverse([...this.marketsByExchange.values()].flat(), verify);
  }

  /** Держать глубокие стаканы по ногам монеты — пока её смотрят в деталях. */
  watchDeep(base: string): void {
    const legs = this.universe.byBase.get(base);
    if (legs) this.books.watchDeep(legs);
  }

  /** Стакан ноги (в монетах и ценах за монету) — для расчёта на объём. */
  bookOf(exchange: ExchangeId, symbol: string) {
    return this.books.get(exchange, symbol);
  }

  /**
   * Блок «Ликвидность» для деталей монеты: спред и прибыль на объёме
   * пользователя, рекомендация, сколько вмещает стакан, кривая по сетке.
   * Пара — заданная или лучшая среди выбранных бирж; направление —
   * то, где спред по стакану больше.
   */
  liquidityDetail(
    base: string,
    volumeUsdt: number,
    pair?: { exA: ExchangeId; exB: ExchangeId },
    filter?: ExchangeId[],
  ): LiquidityDetail | null {
    const canonical = this.bases().find((b) => b.toLowerCase() === base.toLowerCase());
    if (!canonical) return null;
    const legs = this.universe.byBase.get(canonical) ?? [];
    let a: VenueMarket | undefined;
    let b: VenueMarket | undefined;
    if (pair) {
      a = legs.find((m) => m.exchange === pair.exA);
      b = legs.find((m) => m.exchange === pair.exB);
    } else {
      const row = this.buildRow(canonical, filter);
      if (!row) return null;
      a = legs.find((m) => m.exchange === row.longExchange);
      b = legs.find((m) => m.exchange === row.shortExchange);
    }
    if (!a || !b) return null;
    const ba = this.books.get(a.exchange, a.symbol);
    const bb = this.books.get(b.exchange, b.symbol);
    if (!ba || !bb || ba.asks.length === 0 || bb.asks.length === 0) return null;

    // Направление пары — по стакану: считаем оба и берём то, где спред по
    // лучшим ценам больше (тикеры и стакан могут расходиться).
    const gross = (buy: typeof ba, sell: typeof bb) =>
      buy.asks[0] && sell.bids[0] ? ((sell.bids[0][0] - buy.asks[0][0]) / buy.asks[0][0]) * 100 : -Infinity;
    let long = a;
    let short = b;
    let lb = ba;
    let sb = bb;
    if (gross(bb, ba) > gross(ba, bb)) {
      long = b;
      short = a;
      lb = bb;
      sb = ba;
    }
    const fLong = this.fundingPct(long.exchange, long.symbol);
    const fShort = this.fundingPct(short.exchange, short.symbol);
    const periods = this.opts.holdMinutes / (FUNDING_PERIOD_MS / 60_000);
    const fundingPct = fLong !== null && fShort !== null ? (fShort - fLong) * periods : 0;
    const L = { asks: lb.asks, bids: lb.bids, taker: long.taker };
    const S = { asks: sb.asks, bids: sb.bids, taker: short.taker };
    const minNetPct = this.opts.liquidityMinNetPct ?? DEFAULT_MIN_NET_PCT;
    const rec = recommendVolume(L, S, { fundingPct, minNetPct });
    const yours = spreadOnVolume(L, S, Math.max(1, volumeUsdt), fundingPct);
    const all = spreadOnVolume(L, S, 1e12, fundingPct);
    const topGross = gross(lb, sb);
    const now = Date.now();
    const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const q = (v: ReturnType<typeof spreadOnVolume>) => ({
      requestedUsdt: r2(v.requestedUsdt),
      volumeUsdt: r2(v.volumeUsdt),
      qty: v.qty,
      buyAvg: v.buyAvg,
      sellAvg: v.sellAvg,
      grossPct: r4(v.grossPct),
      feesPct: r4(v.feesPct),
      netPct: r4(v.netPct),
      profitUsdt: r2(v.profitUsdt),
      fullyFilled: v.fullyFilled,
      limitingLeg: v.limitingLeg,
    });
    return {
      base: canonical,
      longExchange: long.exchange,
      shortExchange: short.exchange,
      deep: lb.limit >= 100 && sb.limit >= 100,
      bookAgeMs: Math.max(now - lb.updatedAt, now - sb.updatedAt),
      levels: { long: lb.asks.length, short: sb.bids.length },
      topGrossPct: r4(topGross),
      topNetPct: r4(topGross - yours.feesPct + fundingPct),
      yours: q(yours),
      recommended: { ...q(rec), liquidityCapped: rec.liquidityCapped, thresholdCapped: rec.thresholdCapped },
      availableUsdt: r2(all.volumeUsdt),
      availableLimitingLeg: all.limitingLeg,
      curve: rec.curve.map((c) => ({ volumeUsdt: c.volumeUsdt, profitUsdt: r2(c.profitUsdt), netPct: r4(c.netPct) })),
      minNetPct,
      updatedAt: now,
    };
  }

  /** Сколько стаканов опрашивается — для статуса. */
  booksStats() {
    return { ...this.books.stats(), rows: { ...this.liqReasons } };
  }

  /** Почему у строки нет рекомендации — счётчики за последний снимок (диагностика). */
  private liqReasons = { ok: 0, noBook: 0, stale: 0, empty: 0, zero: 0 };

  async stop(): Promise<void> {
    this.books.stop();
    this.running = false;
    this.ready = false;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    this.funding?.stop();
    for (const f of this.feeds.values()) f.stopFeed();
    this.feeds.clear();
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    this.clients.clear();
    await this.host.terminate();
  }

  private createClient(id: ExchangeId): ExchangeProxy {
    const config = {
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
    };
    // Поток котировок в worker'е шлёт пачки [символ, bid, ask, last, время];
    // рынок ищем по символу среди рынков этой биржи.
    return this.host.createClient(id, CCXT_ID[id], config, REST_ONLY.has(id), {
      onQuotes: (items) => {
        const list = this.marketsByExchange.get(id);
        if (!list) return;
        let bySymbol = this.symbolIndex.get(id);
        if (!bySymbol || bySymbol.size !== list.length) {
          bySymbol = new Map(list.map((m) => [m.symbol, m]));
          this.symbolIndex.set(id, bySymbol);
        }
        for (const [symbol, bid, ask, last, receivedAt] of items) {
          const market = bySymbol.get(symbol);
          if (market) this.onQuote(market, { bid, ask, last, receivedAt });
        }
      },
      onFeedState: () => undefined,
      onGap: (reason) => this.opts.onGap?.(id, reason),
    });
  }

  /** Биржа → символ → рынок; пересобирается, когда меняется список рынков. */
  private readonly symbolIndex = new Map<ExchangeId, Map<string, VenueMarket>>();

  private onQuote(market: VenueMarket, quote: Quote): void {
    let byVenue = this.quotes.get(market.base);
    if (!byVenue) {
      byVenue = new Map();
      this.quotes.set(market.base, byVenue);
    }
    byVenue.set(`${market.exchange}:${market.symbol}`, quote);
  }

  // ---------------------------------------------------------------- состояние

  status(): EngineStatus {
    return {
      ready: this.ready,
      startedAt: this.startedAt,
      universeSize: this.universe.byBase.size,
      feeds: [...this.feeds.values()].map((f) => ({ ...(f.feedState ?? emptyFeedState(f.exchange)) })),
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
      let quote = byVenue.get(`${market.exchange}:${market.symbol}`);
      if (!quote) continue;
      // Поток поделил цену на множитель из тикера; сверка могла задать свой.
      const k = (market.tickerMultiplier ?? market.multiplier) / market.multiplier;
      if (k !== 1) quote = { ...quote, bid: quote.bid * k, ask: quote.ask * k, last: quote.last * k };
      out.push({ market, quote, fresh: now - quote.receivedAt <= this.opts.staleMs });
    }
    return out;
  }

  /**
   * Лучшая пара среди разрешённых: лонг там, где дешевле, шорт — где дороже.
   * Без таблицы сверки разрешены все сочетания.
   */
  private bestPair(
    base: string,
    pool: VenueSnapshot[],
  ): { long: VenueSnapshot; short: VenueSnapshot; verifiedAt?: number } | null {
    const allowed = this.universe.pairsByBase.get(base);
    let best: { long: VenueSnapshot; short: VenueSnapshot; verifiedAt?: number } | null = null;
    let bestSpread = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      for (let j = 0; j < pool.length; j++) {
        if (i === j) continue;
        const long = pool[i]!;
        const short = pool[j]!;
        let verifiedAt: number | undefined;
        if (allowed) {
          const key = pairKey(long.market.exchange, short.market.exchange);
          if (!allowed.has(key)) continue;
          verifiedAt = allowed.get(key);
        }
        const spread = short.quote.bid - long.quote.ask;
        if (spread > bestSpread) {
          bestSpread = spread;
          best = { long, short, verifiedAt };
        }
      }
    }
    return best;
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

    const pair = this.bestPair(base, pool);
    if (!pair) return null;
    const { long, short } = pair;

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
    const liquidity = suspect ? undefined : this.rowLiquidity(long, short, fundingPct);
    return {
      symbol,
      base,
      name: coinName(base),
      ...(liquidity ? { liquidity } : {}),
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
      isNew: pair.verifiedAt !== undefined && Date.now() - pair.verifiedAt < NEW_LISTING_MS,
    };
  }

  /**
   * Рекомендуемый объём по стаканам обеих ног. Нет свежих стаканов — нет
   * рекомендации (в ленте строка просто без неё), никаких оценок «на глаз».
   */
  private rowLiquidity(long: VenueSnapshot, short: VenueSnapshot, fundingPct: number) {
    const a = this.books.get(long.market.exchange, long.market.symbol);
    const b = this.books.get(short.market.exchange, short.market.symbol);
    const R = this.liqReasons;
    if (!a || !b) {
      R.noBook++;
      return undefined;
    }
    const now = Date.now();
    const age = Math.max(now - a.updatedAt, now - b.updatedAt);
    if (age > BOOK_STALE_MS) {
      R.stale++;
      return undefined;
    }
    if (a.asks.length === 0 || b.bids.length === 0) {
      R.empty++;
      return undefined;
    }
    const rec = recommendVolume(
      { asks: a.asks, bids: a.bids, taker: long.market.taker },
      { asks: b.asks, bids: b.bids, taker: short.market.taker },
      { fundingPct, minNetPct: this.opts.liquidityMinNetPct ?? DEFAULT_MIN_NET_PCT },
    );
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
    if (!(rec.volumeUsdt > 0)) {
      // По стакану спреда нет даже на первой точке сетки: показываем, что
      // стакан говорит на 100 USDT, — это честнее, чем молчать.
      R.zero++;
      const probe = rec.curve[0];
      return {
        recommendedUsdt: 0,
        profitUsdt: 0,
        netPct: r4(probe?.netPct ?? 0),
        grossPct: r4((probe?.netPct ?? 0) + rec.feesPct),
        liquidityCapped: false,
        thresholdCapped: true,
        limitingLeg: rec.limitingLeg,
        shallow: a.limit < 100 || b.limit < 100,
        bookAgeMs: age,
      };
    }
    R.ok++;
    return {
      recommendedUsdt: Math.round(rec.volumeUsdt),
      profitUsdt: r2(rec.profitUsdt),
      netPct: r4(rec.netPct),
      grossPct: r4(rec.grossPct),
      liquidityCapped: rec.liquidityCapped,
      thresholdCapped: rec.thresholdCapped,
      limitingLeg: rec.limitingLeg,
      shallow: a.limit < 100 || b.limit < 100,
      bookAgeMs: age,
    };
  }

  /**
   * Горячий набор — ноги верхних строк ленты; обновляем не чаще раза в
   * секунду. Вход — топ-N строк, выход — за пределами 2N: у границы топа
   * строки меняются местами каждую секунду, и без гистерезиса стаканы
   * пришлось бы качать заново.
   */
  private hotUpdatedAt = 0;
  private readonly hotLegs = new Set<string>();
  private updateHot(rows: SpreadRow[], now: number): void {
    if (now - this.hotUpdatedAt < 1000) return;
    this.hotUpdatedAt = now;
    const enter = this.opts.hotRows ?? 40;
    const stay = enter * 2;
    const legs: VenueMarket[] = [];
    const next = new Set<string>();
    let rank = 0;
    for (const r of rows) {
      if (r.stale || r.suspect) continue;
      rank++;
      if (rank > stay) break;
      const list = this.universe.byBase.get(r.base) ?? [];
      for (const ex of [r.longExchange, r.shortExchange]) {
        const m = list.find((x) => x.exchange === ex);
        if (!m) continue;
        const key = legKey(m.exchange, m.symbol);
        if (rank <= enter || this.hotLegs.has(key)) {
          next.add(key);
          legs.push(m);
        }
      }
    }
    this.hotLegs.clear();
    for (const k of next) this.hotLegs.add(k);
    this.books.setHot(legs);
  }

  private cache: { key: string; at: number; value: ScreenerSnapshot } | null = null;

  /**
   * Сколько держится спред: с момента, когда он поднялся выше порога
   * заметности, и сколько таких подъёмов было за сегодня. Гистерезис в
   * 0,1 % — чтобы дрожание у порога не плодило «циклы».
   */
  private static readonly HELD_PCT = 0.5;
  private static readonly HELD_RELEASE_PCT = 0.4;
  private readonly held = new Map<string, { since: number; cycles: number; day: number }>();

  private trackHeld(rows: SpreadRow[], now: number): void {
    const day = Math.floor((now + new Date(now).getTimezoneOffset() * -60_000) / 86_400_000);
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.base);
      const cur = this.held.get(r.base);
      const above = !r.stale && !r.suspect && r.spreadPct >= MarketEngine.HELD_PCT;
      const still = cur && cur.since > 0 && !r.stale && !r.suspect && r.spreadPct >= MarketEngine.HELD_RELEASE_PCT;
      if (cur && cur.day !== day) {
        cur.cycles = 0;
        cur.day = day;
      }
      if (above && !(cur && cur.since > 0)) {
        this.held.set(r.base, { since: now, cycles: (cur?.cycles ?? 0) + 1, day });
      } else if (cur && cur.since > 0 && !still) {
        cur.since = 0;
      }
      const state = this.held.get(r.base);
      r.heldSinceAt = state && state.since > 0 ? state.since : null;
      r.cyclesToday = state?.cycles ?? 0;
    }
    for (const base of this.held.keys()) if (!seen.has(base)) this.held.delete(base);
  }
  /** Чтобы каждая коллизия тикеров попала в лог один раз, а не раз в секунду. */
  private readonly reportedSuspects = new Set<string>();

  snapshot(minSpreadPct: number, filter?: ExchangeId[]): ScreenerSnapshot {
    // Пять клиентов, опрашивающих раз в секунду, не должны пять раз считать
    // одно и то же: снимок живёт 250 мс.
    const key = `${minSpreadPct}|${(filter ?? []).join(',')}`;
    const now = Date.now();
    if (this.cache && this.cache.key === key && now - this.cache.at < 250) return this.cache.value;

    const rows: SpreadRow[] = [];
    if (!filter) this.liqReasons = { ok: 0, noBook: 0, stale: 0, empty: 0, zero: 0 };
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
    // Длительность считаем по полной картине; с фильтром бирж — просто подставляем.
    if (!filter) {
      this.trackHeld(rows, now);
      this.updateHot(rows, now);
    }
    else {
      for (const r of rows) {
        const h = this.held.get(r.base);
        r.heldSinceAt = h && h.since > 0 ? h.since : null;
        r.cyclesToday = h?.cycles ?? 0;
      }
    }

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

  /**
   * Спред по каждой сверенной паре бирж (в лучшую сторону) — для истории
   * по парам. Биржи в паре — по алфавиту, как в таблице сверки.
   */
  pairSpreads(): { base: string; exA: ExchangeId; exB: ExchangeId; spreadPct: number }[] {
    const out: { base: string; exA: ExchangeId; exB: ExchangeId; spreadPct: number }[] = [];
    for (const base of this.universe.byBase.keys()) {
      const venues = this.venuesFor(base).filter((v) => v.fresh);
      if (venues.length < 2) continue;
      const allowed = this.universe.pairsByBase.get(base);
      for (let i = 0; i < venues.length; i++) {
        for (let j = i + 1; j < venues.length; j++) {
          const a = venues[i]!;
          const b = venues[j]!;
          const key = pairKey(a.market.exchange, b.market.exchange);
          if (allowed && !allowed.has(key)) continue;
          const ab = ((b.quote.bid - a.quote.ask) / a.quote.ask) * 100;
          const ba = ((a.quote.bid - b.quote.ask) / b.quote.ask) * 100;
          const spreadPct = Math.max(ab, ba);
          if (!Number.isFinite(spreadPct) || Math.abs(spreadPct) > MAX_PLAUSIBLE_SPREAD_PCT) continue;
          const [exA, exB] = key.split('|') as [ExchangeId, ExchangeId];
          out.push({ base, exA, exB, spreadPct: Math.round(spreadPct * 10_000) / 10_000 });
        }
      }
    }
    return out;
  }

  /** Сверенные пары монеты — для выбора на графике. */
  pairsOf(base: string): { exA: ExchangeId; exB: ExchangeId }[] {
    const allowed = this.universe.pairsByBase.get(base);
    const legs = (this.universe.byBase.get(base) ?? []).map((m) => m.exchange);
    const out: { exA: ExchangeId; exB: ExchangeId }[] = [];
    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        const key = pairKey(legs[i]!, legs[j]!);
        if (allowed && !allowed.has(key)) continue;
        const [exA, exB] = key.split('|') as [ExchangeId, ExchangeId];
        out.push({ exA, exB });
      }
    }
    return out;
  }

  coinDetail(base: string, filter?: ExchangeId[]): CoinDetail | undefined {
    const canonical = this.bases().find((b) => b.toLowerCase() === base.toLowerCase());
    if (!canonical) return undefined;
    // Лучшая пара — среди выбранных бирж, а список цен — по всем: видеть
    // остальные полезно, даже если торговать на них не собираешься.
    const row = this.buildRow(canonical, filter) ?? this.buildRow(canonical);
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
