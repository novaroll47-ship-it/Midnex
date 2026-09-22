/**
 * Главный поток: пул worker'ов и прокси-клиенты бирж.
 *
 * `ExchangeProxy` — то подмножество ccxt-клиента, которым пользуется код
 * выше (загрузка рынков, стакан, свечи, фандинг): каждый вызов — RPC в
 * worker, где живёт настоящий ccxt. Котировки приходят пачками через
 * `onQuotes`, состояние потока — через `onFeedState`, дыры — `onGap`.
 *
 * Пул: N потоков, биржи раскладываются по кругу; полный ccxt в потоке
 * стоит ~80 МБ, поэтому по потоку на биржу — расточительно.
 */
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { ExchangeId } from '@cs/shared';

import type { FeedLogger, FeedState, GapReason } from '../feed.js';
import type { VenueMarket } from '../universe.js';
import type { FromWorker, MarketLite, MarketsPayload, QuoteTuple, ToWorker } from './protocol.js';

/** Подмножество ccxt, доступное главному потоку. */
export interface ExchangeClient {
  readonly exchange: ExchangeId;
  has: Record<string, boolean | 'emulated' | undefined>;
  /** Рынки после loadMarkets (облегчённые). */
  markets: Record<string, MarketLite>;
  loadMarkets(reload?: boolean): Promise<void>;
  fetchOrderBook(
    symbol: string,
    limit?: number,
  ): Promise<{ asks: [number, number][]; bids: [number, number][]; timestamp?: number }>;
  fetchOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ): Promise<number[][]>;
  fetchFundingRates(
    symbols?: string[],
  ): Promise<Record<string, { fundingRate?: number; fundingTimestamp?: number }>>;
  fetchFundingRateHistory(
    symbol: string,
    since?: number,
    limit?: number,
  ): Promise<{ timestamp: number; fundingRate: number }[]>;
  close(): Promise<void>;
}

export interface ProxyHandlers {
  onQuotes: (items: QuoteTuple[]) => void;
  onFeedState: (state: FeedState) => void;
  onGap: (reason: GapReason | null) => void;
}

const RPC_TIMEOUT_MS = 120_000;
/** Потолок кучи worker'а: живых данных двух бирж ~100–150 МБ, остальное — мусор между сборками. */
const WORKER_HEAP_MB = Number(process.env.MARKET_WORKER_HEAP_MB) || 384;

export interface WorkerStats {
  index: number;
  exchanges: ExchangeId[];
  alive: boolean;
  heapUsedMb: number;
  heapTotalMb: number;
}

class WorkerSlot {
  readonly worker: Worker;
  readonly exchanges = new Set<ExchangeId>();
  alive = true;
  heapUsedMb = 0;
  heapTotalMb = 0;

  constructor(
    file: URL | string,
    private readonly host: ExchangeWorkerHost,
    readonly index: number,
  ) {
    const isTs = String(file).endsWith('.ts');
    this.worker = new Worker(file, {
      // Исходники (.ts) — только в dev через tsx; в сборке — dist/exchange-worker.js.
      ...(isTs ? { execArgv: ['--import', 'tsx'] } : {}),
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    this.worker.on('message', (msg: FromWorker) => this.host.onMessage(this, msg));
    this.worker.on('error', (err) => this.host.onWorkerDown(this, `ошибка: ${err.message}`));
    this.worker.on('exit', (code) => this.host.onWorkerDown(this, `завершился с кодом ${code}`));
  }

  post(msg: ToWorker): void {
    if (this.alive) this.worker.postMessage(msg);
  }
}

export class ExchangeWorkerHost {
  private readonly slots: WorkerSlot[] = [];
  private readonly bySlotExchange = new Map<ExchangeId, WorkerSlot>();
  private readonly proxies = new Map<ExchangeId, ExchangeProxy>();
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      slot: WorkerSlot;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;
  private stopped = false;

  constructor(
    private readonly file: URL | string,
    private readonly size: number,
    private readonly log: FeedLogger,
    /** Worker умер — биржи на нём надо пересоздать. */
    private readonly onExchangeLost: (exchange: ExchangeId, why: string) => void,
  ) {}

  static workerFile(): URL {
    const built = new URL('./exchange-worker.js', import.meta.url);
    if (existsSync(built)) return built;
    // Не собрано (dev через tsx): исходник worker'а рядом.
    return new URL('./entry.ts', import.meta.url);
  }

  /** Клиент биржи в одном из потоков (по кругу). */
  createClient(
    exchange: ExchangeId,
    ccxtId: string,
    config: Record<string, unknown>,
    restOnly: boolean,
    handlers: ProxyHandlers,
  ): ExchangeProxy {
    const slot = this.pickSlot();
    slot.exchanges.add(exchange);
    this.bySlotExchange.set(exchange, slot);
    slot.post({ type: 'create', exchange, ccxtId, config, restOnly });
    const proxy = new ExchangeProxy(exchange, this, handlers);
    this.proxies.set(exchange, proxy);
    return proxy;
  }

  private pickSlot(): WorkerSlot {
    while (this.slots.length < this.size) {
      this.slots.push(new WorkerSlot(this.file, this, this.slots.length));
    }
    let best = this.slots[0]!;
    for (const s of this.slots) if (s.alive && s.exchanges.size < best.exchanges.size) best = s;
    if (!best.alive) {
      // Заменяем мёртвый поток новым.
      const fresh = new WorkerSlot(this.file, this, best.index);
      this.slots[best.index] = fresh;
      return fresh;
    }
    return best;
  }

  rpc(exchange: ExchangeId, method: string, args: unknown[]): Promise<unknown> {
    const slot = this.bySlotExchange.get(exchange);
    if (!slot || !slot.alive) return Promise.reject(new Error(`${exchange}: worker недоступен`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${exchange}.${method}: нет ответа ${RPC_TIMEOUT_MS / 1000} с`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, slot, timer });
      slot.post({ type: 'rpc', id, exchange, method, args });
    });
  }

  post(exchange: ExchangeId, msg: ToWorker): void {
    this.bySlotExchange.get(exchange)?.post(msg);
  }

  release(exchange: ExchangeId): void {
    const slot = this.bySlotExchange.get(exchange);
    slot?.exchanges.delete(exchange);
    this.bySlotExchange.delete(exchange);
    this.proxies.delete(exchange);
  }

  onMessage(slot: WorkerSlot, msg: FromWorker): void {
    switch (msg.type) {
      case 'rpcResult': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
        return;
      }
      case 'quotes':
        this.proxies.get(msg.exchange)?.handlers.onQuotes(msg.items);
        return;
      case 'feedState': {
        const proxy = this.proxies.get(msg.exchange);
        if (proxy) {
          proxy.feedState = msg.state;
          proxy.handlers.onFeedState(msg.state);
        }
        return;
      }
      case 'gap':
        this.proxies.get(msg.exchange)?.handlers.onGap(msg.reason);
        return;
      case 'log':
        if (msg.level === 'warn') this.log.warn(msg.msg);
        else this.log.info(msg.msg);
        return;
      case 'stats':
        slot.heapUsedMb = msg.heapUsedMb;
        slot.heapTotalMb = msg.heapTotalMb;
        return;
      default:
        void slot;
    }
  }

  /** Память и биржи по потокам — для /api/health и подбора MARKET_WORKERS. */
  stats(): WorkerStats[] {
    return this.slots.map((s) => ({
      index: s.index,
      exchanges: [...s.exchanges],
      alive: s.alive,
      heapUsedMb: s.heapUsedMb,
      heapTotalMb: s.heapTotalMb,
    }));
  }

  onWorkerDown(slot: WorkerSlot, why: string): void {
    if (!slot.alive) return;
    slot.alive = false;
    for (const [id, p] of this.pending) {
      if (p.slot === slot) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error(`worker ${why}`));
      }
    }
    if (this.stopped) return;
    this.log.warn(
      `worker #${slot.index} ${why} — биржи ${[...slot.exchanges].join(', ')} будут переподключены`,
    );
    for (const ex of [...slot.exchanges]) {
      this.release(ex);
      this.onExchangeLost(ex, why);
    }
  }

  async terminate(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.slots.map((s) => s.worker.terminate().catch(() => undefined)));
  }
}

export class ExchangeProxy implements ExchangeClient {
  has: Record<string, boolean | 'emulated' | undefined> = {};
  markets: Record<string, MarketLite> = {};
  feedState: FeedState | null = null;

  constructor(
    readonly exchange: ExchangeId,
    private readonly host: ExchangeWorkerHost,
    readonly handlers: ProxyHandlers,
  ) {}

  async loadMarkets(reload = false): Promise<void> {
    const r = (await this.host.rpc(this.exchange, 'loadMarkets', [reload])) as MarketsPayload;
    this.markets = r.markets;
    this.has = r.has;
  }

  fetchOrderBook(symbol: string, limit?: number) {
    return this.host.rpc(this.exchange, 'fetchOrderBook', [symbol, limit]) as ReturnType<
      ExchangeClient['fetchOrderBook']
    >;
  }

  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number) {
    return this.host.rpc(this.exchange, 'fetchOHLCV', [symbol, timeframe, since, limit]) as Promise<
      number[][]
    >;
  }

  fetchFundingRates(symbols?: string[]) {
    return this.host.rpc(this.exchange, 'fetchFundingRates', [symbols]) as ReturnType<
      ExchangeClient['fetchFundingRates']
    >;
  }

  fetchFundingRateHistory(symbol: string, since?: number, limit?: number) {
    return this.host.rpc(this.exchange, 'fetchFundingRateHistory', [
      symbol,
      since,
      limit,
    ]) as ReturnType<ExchangeClient['fetchFundingRateHistory']>;
  }

  startFeed(markets: VenueMarket[], pollMs: number): void {
    this.host.post(this.exchange, { type: 'startFeed', exchange: this.exchange, markets, pollMs });
  }

  stopFeed(): void {
    this.host.post(this.exchange, { type: 'stopFeed', exchange: this.exchange });
  }

  async close(): Promise<void> {
    this.host.post(this.exchange, { type: 'close', exchange: this.exchange });
    this.host.release(this.exchange);
  }
}
