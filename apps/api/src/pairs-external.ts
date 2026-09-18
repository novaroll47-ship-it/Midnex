/**
 * Внешний источник для сверки: CoinGecko знает, какой актив стоит за
 * тикером на каждой бирже (coin_id). Это второй сигнал после цены: одна и
 * та же цена у двух разных монет — совпадение редкое, но одинаковый тикер у
 * разных проектов — обычное дело, и здесь внешний id ставит точку.
 *
 * Бесплатный API без ключа: восемь запросов раз в сутки, ответ кешируется в
 * файле, чтобы перезапуск не ходил в сеть заново. Если сервис недоступен —
 * источник просто «не знает», сверка по цене от этого не зависит.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { ExchangeId } from '@cs/shared';

/** Идентификаторы деривативных площадок у CoinGecko; MEXC там нет. */
const CG_ID: Partial<Record<ExchangeId, string>> = {
  binance: 'binance_futures',
  bybit: 'bybit',
  okx: 'okex_swap',
  bitget: 'bitget_futures',
  bingx: 'bingx_futures',
  gate: 'gate_futures',
  kucoin: 'kumex',
};

const REFRESH_MS = 24 * 3_600_000;
const RETRY_MS = 30 * 60_000;
const BETWEEN_REQUESTS_MS = 4000;

interface Cache {
  fetchedAt: Partial<Record<ExchangeId, number>>;
  /** биржа → тикер (как называет биржа, без USDT) → coin id. */
  tickers: Partial<Record<ExchangeId, Record<string, string>>>;
}

export class ExternalTickers {
  private cache: Cache = { fetchedAt: {}, tickers: {} };
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly file: string,
    private readonly log: FastifyBaseLogger,
  ) {
    try {
      this.cache = JSON.parse(readFileSync(file, 'utf8')) as Cache;
    } catch {
      // Кеша ещё нет — заполним при первом обновлении.
    }
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), RETRY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Coin id по ноге; null — источник не знает (или биржи у него нет). */
  coinId(exchange: ExchangeId, symbol: string): string | null {
    const table = this.cache.tickers[exchange];
    if (!table) return null;
    const raw = symbol.split('/')[0] ?? symbol;
    return table[raw] ?? table[raw.toUpperCase()] ?? null;
  }

  /** Есть ли у источника данные по бирже вообще. */
  covers(exchange: ExchangeId): boolean {
    return Boolean(this.cache.tickers[exchange]);
  }

  private async refresh(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const [exchange, cgId] of Object.entries(CG_ID) as [ExchangeId, string][]) {
        const at = this.cache.fetchedAt[exchange] ?? 0;
        if (Date.now() - at < REFRESH_MS) continue;
        try {
          const table = await fetchTickers(cgId);
          this.cache.tickers[exchange] = table;
          this.cache.fetchedAt[exchange] = Date.now();
          this.save();
          this.log.info(`сверка: CoinGecko ${exchange} — тикеров ${Object.keys(table).length}`);
        } catch (err) {
          this.log.warn(`сверка: CoinGecko ${exchange} недоступен: ${String(err).slice(0, 120)}`);
        }
        await new Promise((r) => setTimeout(r, BETWEEN_REQUESTS_MS));
      }
    } finally {
      this.running = false;
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.cache));
    } catch (err) {
      this.log.warn(`сверка: кеш CoinGecko не записан: ${String(err).slice(0, 100)}`);
    }
  }
}

async function fetchTickers(cgId: string): Promise<Record<string, string>> {
  const url = `https://api.coingecko.com/api/v3/derivatives/exchanges/${cgId}?include_tickers=unexpired`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    tickers?: { base?: string; target?: string; coin_id?: string | null; contract_type?: string }[];
  };
  const out: Record<string, string> = {};
  for (const t of body.tickers ?? []) {
    if (!t.base || !t.coin_id) continue;
    if (t.target && t.target !== 'USDT') continue;
    if (t.contract_type && t.contract_type !== 'perpetual') continue;
    out[t.base.toUpperCase()] = t.coin_id;
  }
  return out;
}
