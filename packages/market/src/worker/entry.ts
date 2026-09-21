/**
 * Worker биржи: здесь живут ccxt-клиенты и потоки котировок (Feed).
 *
 * Один worker может обслуживать несколько бирж (см. host.ts). Котировки
 * копятся и уходят в главный поток пачкой раз в FLUSH_MS; состояние потока —
 * раз в секунду; REST-вызовы приходят как RPC и отвечают результатом ccxt
 * (для стаканов — только цены и объёмы, чтобы не гонять сырой ответ).
 */
import ccxt, { type Exchange } from 'ccxt';
import { parentPort } from 'node:worker_threads';

import { Feed, type Quote } from '../feed.js';
import type { VenueMarket } from '../universe.js';
import type { FromWorker, MarketLite, MarketsPayload, QuoteTuple, ToWorker } from './protocol.js';

const port = parentPort;
if (!port) throw new Error('exchange worker: запущен не как worker');

const FLUSH_MS = 250;

interface Slot {
  client: Exchange;
  feed: Feed | null;
  pending: Map<string, QuoteTuple>;
  flushTimer: ReturnType<typeof setInterval> | null;
  stateTimer: ReturnType<typeof setInterval> | null;
}

const slots = new Map<string, Slot>();

const send = (msg: FromWorker) => port.postMessage(msg);
const log = {
  info: (msg: string) => send({ type: 'log', level: 'info', msg }),
  warn: (msg: string) => send({ type: 'log', level: 'warn', msg }),
};

function marketsPayload(client: Exchange): MarketsPayload {
  const markets: Record<string, MarketLite> = {};
  for (const [symbol, m] of Object.entries(client.markets ?? {})) {
    if (!m) continue;
    markets[symbol] = {
      symbol: m.symbol,
      base: m.base,
      quote: m.quote,
      settle: m.settle ?? undefined,
      swap: m.swap ?? undefined,
      linear: m.linear ?? undefined,
      active: m.active ?? undefined,
      taker: typeof m.taker === 'number' ? m.taker : undefined,
      contractSize: typeof m.contractSize === 'number' ? m.contractSize : undefined,
      precision: { price: typeof m.precision?.price === 'number' ? m.precision.price : undefined },
    };
  }
  return { markets, has: { ...(client.has as Record<string, boolean | 'emulated' | undefined>) } };
}

async function rpc(slot: Slot, method: string, args: unknown[]): Promise<unknown> {
  const c = slot.client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  switch (method) {
    case 'loadMarkets':
      await slot.client.loadMarkets(Boolean(args[0]));
      return marketsPayload(slot.client);
    case 'fetchOrderBook': {
      const ob = (await slot.client.fetchOrderBook(args[0] as string, args[1] as number | undefined)) as {
        asks: [number, number][];
        bids: [number, number][];
        timestamp?: number;
      };
      return { asks: ob.asks, bids: ob.bids, timestamp: ob.timestamp };
    }
    case 'fetchOHLCV':
    case 'fetchFundingRates':
    case 'fetchFundingRateHistory':
    case 'fetchTickers':
    case 'fetchBidsAsks': {
      const fn = c[method];
      if (typeof fn !== 'function') throw new Error(`${method} не поддерживается`);
      // structured clone не переносит функции/классы — ccxt отдаёт простые объекты.
      return JSON.parse(JSON.stringify(await fn.apply(slot.client, args)));
    }
    default:
      throw new Error(`неизвестный метод ${method}`);
  }
}

function startFeed(exchange: string, slot: Slot, markets: VenueMarket[], pollMs: number): void {
  if (slot.feed) return;
  const bySymbol = new Map(markets.map((m) => [m.symbol, m]));
  const feed = new Feed({
    exchange: exchange as VenueMarket['exchange'],
    client: slot.client,
    markets,
    pollMs,
    log,
    onQuote: (market: VenueMarket, q: Quote) => {
      if (!bySymbol.has(market.symbol)) return;
      slot.pending.set(market.symbol, [market.symbol, q.bid, q.ask, q.last, q.receivedAt]);
    },
    onGap: (ex, reason) => send({ type: 'gap', exchange: ex, reason }),
  });
  slot.feed = feed;
  feed.start();
  slot.flushTimer = setInterval(() => {
    if (slot.pending.size === 0) return;
    const items = [...slot.pending.values()];
    slot.pending.clear();
    send({ type: 'quotes', exchange: exchange as VenueMarket['exchange'], items });
  }, FLUSH_MS);
  slot.stateTimer = setInterval(() => {
    send({ type: 'feedState', exchange: exchange as VenueMarket['exchange'], state: { ...feed.state } });
  }, 1000);
}

async function stopFeed(slot: Slot): Promise<void> {
  if (slot.flushTimer) clearInterval(slot.flushTimer);
  if (slot.stateTimer) clearInterval(slot.stateTimer);
  slot.flushTimer = null;
  slot.stateTimer = null;
  const feed = slot.feed;
  slot.feed = null;
  if (feed) await feed.stop();
}

port.on('message', (msg: ToWorker) => {
  void (async () => {
    try {
      switch (msg.type) {
        case 'create': {
          const Ctor = (ccxt.pro as unknown as Record<string, new (cfg: object) => Exchange>)[msg.ccxtId];
          if (!Ctor) throw new Error(`ccxt: нет биржи ${msg.ccxtId}`);
          const client = new Ctor(msg.config);
          if (msg.restOnly) client.has['watchTickers'] = false;
          slots.set(msg.exchange, { client, feed: null, pending: new Map(), flushTimer: null, stateTimer: null });
          break;
        }
        case 'rpc': {
          const slot = slots.get(msg.exchange);
          try {
            if (!slot) throw new Error(`биржа ${msg.exchange} не создана`);
            const result = await rpc(slot, msg.method, msg.args);
            send({ type: 'rpcResult', id: msg.id, ok: true, result });
          } catch (err) {
            send({ type: 'rpcResult', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          break;
        }
        case 'startFeed': {
          const slot = slots.get(msg.exchange);
          if (slot) startFeed(msg.exchange, slot, msg.markets, msg.pollMs);
          break;
        }
        case 'stopFeed': {
          const slot = slots.get(msg.exchange);
          if (slot) await stopFeed(slot);
          break;
        }
        case 'close': {
          const slot = slots.get(msg.exchange);
          if (!slot) break;
          slots.delete(msg.exchange);
          await stopFeed(slot);
          try {
            await slot.client.close();
          } catch {
            // Соединений могло и не быть.
          }
          break;
        }
      }
    } catch (err) {
      log.warn(`worker: ${msg.type}: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
});
