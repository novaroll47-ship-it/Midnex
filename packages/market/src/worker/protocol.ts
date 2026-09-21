/**
 * Протокол между главным потоком и worker'ами бирж.
 *
 * ccxt живёт в worker'ах: разбор WebSocket-сообщений и REST-ответов тысяч
 * инструментов — главный потребитель CPU, и на главном потоке он блокировал
 * API и сборщик истории. Главный поток получает готовые котировки пачками и
 * дёргает REST-методы через RPC.
 */
import type { ExchangeId } from '@cs/shared';

import type { FeedState, GapReason } from '../feed.js';
import type { VenueMarket } from '../universe.js';

/** Поля рынка ccxt, которые нужны главному потоку (см. universe.venueMarkets). */
export interface MarketLite {
  symbol: string;
  base: string;
  quote: string;
  settle?: string;
  swap?: boolean;
  linear?: boolean;
  active?: boolean;
  taker?: number;
  contractSize?: number;
  precision?: { price?: number };
}

/** [символ, bid, ask, last, receivedAt] — компактно, чтобы пачки были дешёвыми. */
export type QuoteTuple = [string, number, number, number, number];

export type ToWorker =
  | { type: 'create'; exchange: ExchangeId; ccxtId: string; config: Record<string, unknown>; restOnly: boolean }
  | { type: 'rpc'; id: number; exchange: ExchangeId; method: string; args: unknown[] }
  | { type: 'startFeed'; exchange: ExchangeId; markets: VenueMarket[]; pollMs: number }
  | { type: 'stopFeed'; exchange: ExchangeId }
  | { type: 'close'; exchange: ExchangeId };

export type FromWorker =
  | { type: 'rpcResult'; id: number; ok: true; result: unknown }
  | { type: 'rpcResult'; id: number; ok: false; error: string }
  | { type: 'quotes'; exchange: ExchangeId; items: QuoteTuple[] }
  | { type: 'feedState'; exchange: ExchangeId; state: FeedState }
  | { type: 'gap'; exchange: ExchangeId; reason: GapReason | null }
  | { type: 'log'; level: 'info' | 'warn'; msg: string };

/** Что возвращает RPC loadMarkets. */
export interface MarketsPayload {
  markets: Record<string, MarketLite>;
  has: Record<string, boolean | 'emulated' | undefined>;
}
