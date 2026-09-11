/**
 * Источник рыночных данных для API.
 *
 * Пока движок поднимает соединения с биржами (5–10 секунд после старта),
 * скринер отдаёт мок — иначе на это время интерфейс показывал бы пустоту.
 * Как только пришли первые живые котировки, мок больше не используется.
 *
 * MARKET_MODE=mock оставляет мок навсегда — для разработки интерфейса без
 * сети и для случаев, когда биржи недоступны.
 */
import type { FastifyBaseLogger } from 'fastify';
import {
  EXCHANGES,
  QUOTE_STALE_MS,
  type CoinDetail,
  type ExchangeId,
  type ScreenerSnapshot,
} from '@cs/shared';
import { MarketEngine, type EngineStatus } from '@cs/market';

import * as mock from './mock.js';
import { store } from './store.js';

export type MarketMode = 'live' | 'mock';

export interface MarketSource {
  mode: MarketMode;
  /** Данные уже живые, а не мок. */
  live(): boolean;
  snapshot(minSpreadPct: number, venues?: ExchangeId[]): ScreenerSnapshot;
  coinDetail(base: string): CoinDetail | undefined;
  status(): EngineStatus | null;
  stop(): Promise<void>;
}

export function createMarketSource(log: FastifyBaseLogger): MarketSource {
  const mode: MarketMode = process.env.MARKET_MODE === 'mock' ? 'mock' : 'live';

  if (mode === 'mock') {
    log.warn('рынок: MARKET_MODE=mock, биржи не подключаются');
    return {
      mode,
      live: () => false,
      snapshot: (min, venues) => mock.screenerSnapshot(min, venues),
      coinDetail: (base) => mock.coinDetail(base),
      status: () => null,
      stop: async () => {},
    };
  }

  const engine = new MarketEngine({
    exchanges: EXCHANGES.map((e) => e.id),
    // Тикерные потоки бирж шлют обновление только когда цена сдвинулась, и
    // у неликвидных монет это бывает раз в несколько секунд. Три секунды из
    // настроек — порог для входа в сделку, а не для показа в списке.
    staleMs: Math.max(QUOTE_STALE_MS, 10_000),
    pollMs: 2000,
    holdMinutes: store.risk.holdTimeoutMinutes,
    httpsProxy: process.env.EXCHANGE_HTTPS_PROXY || undefined,
    log: {
      info: (m) => log.info(`рынок: ${m}`),
      warn: (m) => log.warn(`рынок: ${m}`),
    },
  });

  // start() резолвится, когда отработали все биржи, включая зависшие на
  // таймауте. Готовность берём из самого движка: ему хватает двух бирж.
  engine.start().catch((err: unknown) => {
    log.error({ err: String(err) }, 'рынок: движок не запустился, остаёмся на моке');
  });

  // Живыми данные считаем, когда хотя бы две биржи отдали котировки —
  // иначе спред считать не из чего и лучше показать мок, чем пустой список.
  let announced = false;
  const isLive = () => {
    const st = engine.status();
    const live = st.ready && st.feeds.filter((f) => f.quoted > 0).length >= 2;
    if (live && !announced) {
      announced = true;
      log.info(`рынок: живые данные, ${st.universeSize} монет — мок больше не используется`);
    }
    return live;
  };

  return {
    mode,
    live: isLive,
    snapshot: (min, venues) =>
      isLive() ? engine.snapshot(min, venues) : mock.screenerSnapshot(min, venues),
    coinDetail: (base) => (isLive() ? engine.coinDetail(base) : mock.coinDetail(base)),
    status: () => engine.status(),
    stop: () => engine.stop(),
  };
}
