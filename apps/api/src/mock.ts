/**
 * Мок-источник данных для M1. Отдаёт ровно те же типы, что потом отдаст
 * реальный рыночный слой (`packages/market`), поэтому при переходе на M2
 * фронт менять не придётся — меняется только этот модуль.
 *
 * Цены дрейфуют во времени, чтобы таблица в интерфейсе выглядела живой.
 * Величины спредов подобраны реалистично, а не как в макете: на мейджорах
 * сотые доли процента, на альтах — до нескольких процентов.
 */
import {
  DEFAULT_BOT,
  DEFAULT_TAKER_PCT,
  EXCHANGES,
  ROUND_TRIP_LEGS,
  type ApiKeyStatus,
  type ExchangeId,
  type ScreenerSnapshot,
  type SpreadRow,
} from '@cs/shared';

interface CoinSeed {
  base: string;
  name: string;
  price: number;
  /** Типичный разброс цены между биржами, доля от цены. */
  dispersion: number;
}

const COINS: CoinSeed[] = [
  { base: 'BTC', name: 'Bitcoin', price: 66245.3, dispersion: 0.0004 },
  { base: 'ETH', name: 'Ethereum', price: 3142.65, dispersion: 0.0006 },
  { base: 'SOL', name: 'Solana', price: 142.35, dispersion: 0.0012 },
  { base: 'XRP', name: 'Ripple', price: 0.5287, dispersion: 0.0016 },
  { base: 'DOGE', name: 'Dogecoin', price: 0.12834, dispersion: 0.0021 },
  { base: 'TON', name: 'Toncoin', price: 6.842, dispersion: 0.0034 },
  { base: 'AVAX', name: 'Avalanche', price: 27.41, dispersion: 0.0029 },
  { base: 'LINK', name: 'Chainlink', price: 14.203, dispersion: 0.0033 },
  { base: 'ARB', name: 'Arbitrum', price: 0.8134, dispersion: 0.0051 },
  { base: 'OP', name: 'Optimism', price: 1.6402, dispersion: 0.0047 },
  { base: 'SUI', name: 'Sui', price: 1.0921, dispersion: 0.0062 },
  { base: 'APT', name: 'Aptos', price: 7.618, dispersion: 0.0058 },
  { base: 'INJ', name: 'Injective', price: 21.07, dispersion: 0.0064 },
  { base: 'SEI', name: 'Sei', price: 0.4193, dispersion: 0.0088 },
  { base: 'TIA', name: 'Celestia', price: 5.371, dispersion: 0.0079 },
  { base: 'PEPE', name: 'Pepe', price: 0.00001184, dispersion: 0.0121 },
  { base: 'WIF', name: 'dogwifhat', price: 2.4137, dispersion: 0.0134 },
  { base: 'BONK', name: 'Bonk', price: 0.00002517, dispersion: 0.0148 },
  { base: 'ORDI', name: 'Ordinals', price: 39.82, dispersion: 0.0092 },
  { base: 'JUP', name: 'Jupiter', price: 0.8471, dispersion: 0.0111 },
  { base: 'PYTH', name: 'Pyth Network', price: 0.4038, dispersion: 0.0126 },
  { base: 'RNDR', name: 'Render', price: 8.264, dispersion: 0.0097 },
  { base: 'FET', name: 'Fetch.ai', price: 1.9143, dispersion: 0.0104 },
  { base: 'AAVE', name: 'Aave', price: 91.37, dispersion: 0.0043 },
  { base: 'LDO', name: 'Lido DAO', price: 1.8226, dispersion: 0.0087 },
];

const ALL_EXCHANGES: ExchangeId[] = EXCHANGES.map((e) => e.id);

/** Детерминированный псевдослучайный шум: цена «дышит» плавно, а не прыгает. */
function wave(seed: number, t: number, speed: number): number {
  return (
    Math.sin(t * speed + seed * 1.7) * 0.6 +
    Math.sin(t * speed * 2.3 + seed * 4.1) * 0.3 +
    Math.sin(t * speed * 5.1 + seed * 9.3) * 0.1
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h % 1000) / 1000;
}

const trendHistory: number[] = [];
let lastTrendSample = 0;
/** Точку в спарклайн добавляем не чаще раза в 3 с — иначе линия превращается в шум. */
const TREND_SAMPLE_MS = 3_000;

function buildRow(coin: CoinSeed, now: number): SpreadRow {
  const t = now / 1000;
  const seed = hash(coin.base);

  // Цена на каждой бирже = база + собственный дрейф биржи + общий дрейф рынка.
  const quotes = ALL_EXCHANGES.map((id, i) => {
    const drift = wave(seed * 100 + i * 3.3, t, 0.09) * coin.dispersion;
    const global = wave(seed, t, 0.02) * 0.002;
    return { exchange: id, price: coin.price * (1 + drift + global) };
  });

  // Лонг там, где дешевле; шорт там, где дороже.
  let cheap = quotes[0]!;
  let dear = quotes[0]!;
  for (const q of quotes) {
    if (q.price < cheap.price) cheap = q;
    if (q.price > dear.price) dear = q;
  }

  const spreadAbs = dear.price - cheap.price;
  const spreadPct = (spreadAbs / cheap.price) * 100;
  const feesPct = DEFAULT_TAKER_PCT * ROUND_TRIP_LEGS;
  const fundingPct = wave(seed + 11, t, 0.004) * 0.06;
  const netPct = spreadPct - feesPct + fundingPct;

  return {
    symbol: `${coin.base}/USDT:USDT`,
    base: coin.base,
    name: coin.name,
    longExchange: cheap.exchange,
    longPrice: cheap.price,
    shortExchange: dear.exchange,
    shortPrice: dear.price,
    spreadAbs,
    spreadPct,
    netPct,
    fundingPct,
    feesPct,
    quotedAt: now - Math.floor(Math.random() * 400),
    stale: false,
  };
}

export function screenerSnapshot(minSpreadPct = DEFAULT_BOT.minSpreadPct): ScreenerSnapshot {
  const now = Date.now();
  const rows = COINS.map((c) => buildRow(c, now)).sort((a, b) => b.spreadPct - a.spreadPct);

  const passing = rows.filter((r) => r.spreadPct >= minSpreadPct && !r.stale);
  const avgSpreadPct = passing.length
    ? passing.reduce((s, r) => s + r.spreadPct, 0) / passing.length
    : 0;

  if (now - lastTrendSample >= TREND_SAMPLE_MS) {
    lastTrendSample = now;
    trendHistory.push(passing.length);
    if (trendHistory.length > 30) trendHistory.shift();
  }

  return {
    rows,
    opportunities: passing.length,
    avgSpreadPct,
    trend: [...trendHistory],
    refreshMs: DEFAULT_BOT.refreshMs,
    updatedAt: now,
    botRunning: true,
  };
}

export function apiKeyStatuses(): ApiKeyStatus[] {
  // M1: пять «подключённых» ключей, как на макете настроек.
  const connected: ExchangeId[] = ['binance', 'bybit', 'okx', 'kucoin', 'gate'];
  return EXCHANGES.map((e) => ({
    exchange: e.id,
    connected: connected.includes(e.id),
    permissionsVerified: connected.includes(e.id) && e.canQueryKeyPermissions,
    withdrawalDisabled: connected.includes(e.id) ? (e.canQueryKeyPermissions ? true : null) : null,
  }));
}
