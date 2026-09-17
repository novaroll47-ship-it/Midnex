/**
 * Вселенная символов: какие монеты торгуются перпетуалом хотя бы на двух
 * из восьми бирж — только их есть смысл сравнивать.
 *
 * Главная ловушка — множители в названиях контрактов: на одной бирже
 * `PEPE/USDT:USDT`, на другой `1000PEPE/USDT:USDT`, а на третьей и вовсе
 * `1000000MOG`. Цена такого контракта — за тысячу монет, и без деления на
 * множитель спред между биржами выйдет в сто тысяч процентов. Поэтому
 * каждый рынок помнит свой множитель, а все цены приводятся к одной монете.
 */
import type { Exchange, MarketInterface } from 'ccxt';
import type { ExchangeId } from '@cs/shared';

export interface VenueMarket {
  exchange: ExchangeId;
  /** Унифицированный символ ccxt, например '1000PEPE/USDT:USDT'. */
  symbol: string;
  /** Монета без множителя: PEPE. */
  base: string;
  /** Во сколько монет один «базовый» тикер: 1000 для 1000PEPE. */
  multiplier: number;
  /** Комиссия тейкера, доля (0.0005 = 0.05%). */
  taker: number;
  /** Размер контракта в монетах — понадобится при исполнении. */
  contractSize: number;
  /** Шаг цены, если биржа его сообщает. */
  pricePrecision: number | undefined;
  /** Когда нога сверена (из таблицы сверки). */
  verifiedAt?: number;
}

/** Множители, которые биржи приклеивают к тикеру. */
const MULTIPLIER = /^(1000000000|100000000|10000000|1000000|100000|10000|1000)(?=[A-Z])/;

export function splitMultiplier(rawBase: string): { base: string; multiplier: number } {
  const m = MULTIPLIER.exec(rawBase);
  if (!m) return { base: rawBase, multiplier: 1 };
  return { base: rawBase.slice(m[1]!.length), multiplier: Number(m[1]) };
}

/**
 * Ручные исключения: тикеры, которые на разных биржах называются по-разному,
 * хотя это одна монета. Пополняется по мере обнаружения. Ключ — как называет
 * биржа, значение — каноническое имя.
 */
const ALIASES: Record<string, string> = {
  RNDR: 'RENDER',
  MATIC: 'POL',
  BEAMX: 'BEAM',
};

function canonicalBase(rawBase: string): { base: string; multiplier: number } {
  const { base, multiplier } = splitMultiplier(rawBase);
  return { base: ALIASES[base] ?? base, multiplier };
}

function isLinearUsdtPerp(m: MarketInterface | undefined): m is MarketInterface {
  return Boolean(
    m && m.swap && m.linear && m.quote === 'USDT' && m.active !== false && m.settle === 'USDT',
  );
}

/** Рынки одной биржи, приведённые к канонической монете. */
export function venueMarkets(exchange: ExchangeId, ex: Exchange): VenueMarket[] {
  const out: VenueMarket[] = [];
  for (const m of Object.values(ex.markets ?? {}) as (MarketInterface | undefined)[]) {
    if (!isLinearUsdtPerp(m)) continue;
    const { base, multiplier } = canonicalBase(m.base);
    out.push({
      exchange,
      symbol: m.symbol,
      base,
      multiplier,
      taker: typeof m.taker === 'number' ? m.taker : 0.0006,
      contractSize: typeof m.contractSize === 'number' ? m.contractSize : 1,
      pricePrecision: typeof m.precision?.price === 'number' ? m.precision.price : undefined,
    });
  }
  return out;
}

export interface Universe {
  /** Монета → рынки на биржах, где она есть (минимум две). */
  byBase: Map<string, VenueMarket[]>;
  /** Обратный индекс: биржа + символ ccxt → рынок. */
  bySymbol: Map<string, VenueMarket>;
}

/** Статус ноги (рынка на бирже) по таблице сверки. */
export type LegStatus = 'candidate' | 'verified' | 'rejected' | 'delisted';

export interface LegVerification {
  status: LegStatus;
  /** Множитель, подтверждённый вручную; перекрывает вычисленный из тикера. */
  multiplier: number;
  /** Когда нога была сверена — для пометки «новая пара». */
  verifiedAt?: number;
}

/** Ключ ноги в таблице сверки. */
export function legKey(exchange: ExchangeId, symbol: string): string {
  return `${exchange}:${symbol}`;
}

/**
 * Пересечение: оставляем монеты, представленные хотя бы на двух биржах.
 *
 * Если передана таблица сверки, во вселенную попадают только сверенные
 * ноги — одинаковый тикер на двух биржах не доказывает, что это одна и та
 * же монета, и такую пару без ручной проверки не показываем вовсе.
 */
export function buildUniverse(
  all: VenueMarket[],
  verify?: (m: VenueMarket) => LegVerification | undefined,
): Universe {
  const grouped = new Map<string, VenueMarket[]>();
  for (const raw of all) {
    let m = raw;
    if (verify) {
      const v = verify(raw);
      if (!v || v.status !== 'verified') continue;
      m = { ...raw, multiplier: v.multiplier, verifiedAt: v.verifiedAt };
    }
    // Одна биржа иногда листит и PEPE, и 1000PEPE — берём тот, у которого
    // множитель меньше: он ближе к «настоящей» монете.
    const list = grouped.get(m.base) ?? [];
    const same = list.findIndex((x) => x.exchange === m.exchange);
    if (same >= 0) {
      if (m.multiplier < list[same]!.multiplier) list[same] = m;
    } else {
      list.push(m);
    }
    grouped.set(m.base, list);
  }

  const byBase = new Map<string, VenueMarket[]>();
  const bySymbol = new Map<string, VenueMarket>();
  for (const [base, list] of grouped) {
    if (list.length < 2) continue;
    byBase.set(base, list);
    for (const m of list) bySymbol.set(`${m.exchange}:${m.symbol}`, m);
  }
  return { byBase, bySymbol };
}
