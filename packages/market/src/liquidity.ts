/**
 * Ликвидность: имитация исполнения по стакану и рекомендуемый объём.
 *
 * Чистый модуль без сети и побочных эффектов — его переиспользуют скринер
 * (что заработаешь на своём объёме) и бот (нарезка позиции перед входом).
 * Принимает снимки стаканов, возвращает числа; покрыт тестами
 * (liquidity.test.ts).
 *
 * Правила (plan-liquidity.md):
 * - Ноги выравниваются по количеству монет, не по долларам: Q считаем из
 *   объёма и цены дешёвой биржи, затем покупаем Q по аскам и продаём то же
 *   Q по бидам.
 * - Стакан закончился раньше объёма — не экстраполируем: считаем только
 *   до того, что видно, и говорим, какая нога ограничила.
 * - Рекомендуемый объём — максимум прибыли в долларах, но не глубже
 *   точки, где чистый спред опускается ниже защитного порога.
 */

/** Уровень стакана: [цена за монету, количество монет]. */
export type BookLevel = [price: number, qty: number];

export interface FillResult {
  /** Средневзвешенная цена исполнения; 0, если ничего не набрано. */
  avgPrice: number;
  /** Сколько монет реально набрано (≤ запрошенного). */
  filledQty: number;
  /** Сколько уровней задели. */
  levelsUsed: number;
  /** Хватило ли видимого стакана на весь объём. */
  fullyFilled: boolean;
  /** Сумма в котируемой валюте за набранное. */
  cost: number;
}

/**
 * Проход по уровням от лучшей цены вглубь. Уровни должны идти в порядке
 * ухудшения цены: аски по возрастанию, биды по убыванию — так их отдают
 * биржи и ccxt; функция порядок не проверяет и не сортирует.
 */
export function simulateFill(levels: readonly BookLevel[], quantity: number): FillResult {
  if (!(quantity > 0)) return { avgPrice: 0, filledQty: 0, levelsUsed: 0, fullyFilled: false, cost: 0 };
  let left = quantity;
  let cost = 0;
  let used = 0;
  for (const [price, qty] of levels) {
    if (!(price > 0) || !(qty > 0)) continue;
    const take = Math.min(qty, left);
    cost += take * price;
    left -= take;
    used++;
    if (left <= 0) break;
  }
  const filled = quantity - Math.max(0, left);
  return {
    avgPrice: filled > 0 ? cost / filled : 0,
    filledQty: filled,
    levelsUsed: used,
    fullyFilled: left <= 0,
    cost,
  };
}

/**
 * Стакан биржи в сыром виде → в монетах и ценах за монету. Цена в потоке
 * идёт за единицу тикера (1000PEPE), количество — в контрактах; контракт
 * равен `contractSize` единиц тикера. Монет в контракте: contractSize × multiplier.
 */
export function normalizeBook(
  raw: readonly (readonly [number, number])[],
  o: { multiplier: number; contractSize: number },
): BookLevel[] {
  const k = o.multiplier || 1;
  const coinsPerContract = (o.contractSize || 1) * k;
  const out: BookLevel[] = [];
  for (const [price, qty] of raw) {
    if (!(price > 0) || !(qty > 0)) continue;
    out.push([price / k, qty * coinsPerContract]);
  }
  return out;
}

export interface LegBook {
  /** Аски — по возрастанию цены. */
  asks: readonly BookLevel[];
  /** Биды — по убыванию цены. */
  bids: readonly BookLevel[];
  /** Комиссия тейкера, доля (0.0005 = 0.05 %). */
  taker: number;
}

export interface VolumeSpread {
  /** Запрошенный объём, USDT. */
  requestedUsdt: number;
  /** Объём, который реально можно исполнить по видимому стакану, USDT (по цене покупки). */
  volumeUsdt: number;
  /** Количество монет в каждой ноге. */
  qty: number;
  buyAvg: number;
  sellAvg: number;
  /** Грязный спред на объёме, %. */
  grossPct: number;
  /** Комиссии за вход и выход по обеим ногам, %. */
  feesPct: number;
  /** Чистый спред на объёме, % (грязный − комиссии + фандинг). */
  netPct: number;
  /** Ожидаемая прибыль на исполнимом объёме, USDT. */
  profitUsdt: number;
  /** Видимого стакана хватило на весь запрошенный объём. */
  fullyFilled: boolean;
  /** Какая нога ограничила объём (null — обе вместили). */
  limitingLeg: 'long' | 'short' | null;
}

/**
 * Спред и прибыль на объёме `volumeUsdt`: покупаем на `long` по аскам,
 * продаём на `short` по бидам столько же монет. Комиссии — round-trip
 * (вход и выход по обеим ногам), как в «чист.» скринера; `fundingPct` —
 * ожидаемый фандинг за горизонт удержания в процентах, плюс — в нашу пользу.
 */
export function spreadOnVolume(
  long: LegBook,
  short: LegBook,
  volumeUsdt: number,
  fundingPct = 0,
): VolumeSpread {
  const feesPct = 2 * (long.taker + short.taker) * 100;
  const empty: VolumeSpread = {
    requestedUsdt: volumeUsdt,
    volumeUsdt: 0,
    qty: 0,
    buyAvg: 0,
    sellAvg: 0,
    grossPct: 0,
    feesPct,
    netPct: 0,
    profitUsdt: 0,
    fullyFilled: false,
    limitingLeg: null,
  };
  const bestAsk = long.asks[0]?.[0];
  if (!(volumeUsdt > 0) || !bestAsk || !(bestAsk > 0) || short.bids.length === 0) return empty;

  // Q — из объёма и лучшей цены дешёвой биржи; дальше обе ноги по одному Q.
  let qty = volumeUsdt / bestAsk;
  let buy = simulateFill(long.asks, qty);
  let sell = simulateFill(short.bids, qty);
  let limitingLeg: 'long' | 'short' | null = null;
  const fullyFilled = buy.fullyFilled && sell.fullyFilled;
  if (!fullyFilled) {
    // Ограничивает более тонкая нога; пересчитываем обе на то, что вместилось.
    limitingLeg = buy.filledQty <= sell.filledQty ? 'long' : 'short';
    qty = Math.min(buy.filledQty, sell.filledQty);
    if (qty <= 0) return { ...empty, limitingLeg };
    buy = simulateFill(long.asks, qty);
    sell = simulateFill(short.bids, qty);
  }
  const grossPct = ((sell.avgPrice - buy.avgPrice) / buy.avgPrice) * 100;
  const netPct = grossPct - feesPct + fundingPct;
  const actualUsdt = buy.cost;
  return {
    requestedUsdt: volumeUsdt,
    volumeUsdt: actualUsdt,
    qty,
    buyAvg: buy.avgPrice,
    sellAvg: sell.avgPrice,
    grossPct,
    feesPct,
    netPct,
    profitUsdt: (actualUsdt * netPct) / 100,
    fullyFilled,
    limitingLeg,
  };
}

/** Сетка объёмов для поиска максимума прибыли, USDT. */
export const VOLUME_GRID = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000];

/** Защитный порог чистого спреда по умолчанию, %. */
export const DEFAULT_MIN_NET_PCT = 0.3;

export interface Recommendation extends VolumeSpread {
  /** Рекомендация упёрлась в видимую ликвидность, а не в максимум прибыли. */
  liquidityCapped: boolean;
  /** Рекомендацию остановил защитный порог чистого спреда. */
  thresholdCapped: boolean;
  /** Кривая прибыли по сетке — для графика «объём → прибыль». */
  curve: { volumeUsdt: number; profitUsdt: number; netPct: number }[];
}

/**
 * Рекомендуемый объём: V с максимальной прибылью в долларах, уточнённый
 * между соседними точками сетки, но не глубже точки, где чистый спред
 * падает ниже `minNetPct`. Если стакан заканчивается раньше — объём, который
 * стакан реально вмещает.
 */
export function recommendVolume(
  long: LegBook,
  short: LegBook,
  o: { fundingPct?: number; minNetPct?: number; grid?: readonly number[] } = {},
): Recommendation {
  const fundingPct = o.fundingPct ?? 0;
  const minNetPct = o.minNetPct ?? DEFAULT_MIN_NET_PCT;
  const grid = o.grid ?? VOLUME_GRID;
  const at = (v: number) => spreadOnVolume(long, short, v, fundingPct);

  const curve = grid.map((v) => {
    const r = at(v);
    return { volumeUsdt: v, profitUsdt: r.profitUsdt, netPct: r.netPct };
  });

  // Максимум по сетке.
  let bestIdx = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i]!.profitUsdt > curve[bestIdx]!.profitUsdt) bestIdx = i;

  // Уточнение между соседями максимума: прибыль на объёме унимодальна
  // (растёт, пока спред держится, потом падает), троичный поиск подходит.
  let lo = grid[Math.max(0, bestIdx - 1)]!;
  let hi = grid[Math.min(grid.length - 1, bestIdx + 1)]!;
  for (let i = 0; i < 24 && hi - lo > 1; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (at(m1).profitUsdt < at(m2).profitUsdt) lo = m1;
    else hi = m2;
  }
  let volume = (lo + hi) / 2;
  let best = at(volume);
  if (curve[bestIdx]!.profitUsdt > best.profitUsdt) {
    volume = grid[bestIdx]!;
    best = at(volume);
  }

  // Ликвидность: если в точке максимума стакан уже не вмещает объём —
  // рекомендация равна тому, что вмещается.
  let liquidityCapped = false;
  if (!best.fullyFilled) {
    liquidityCapped = true;
    volume = best.volumeUsdt;
    best = at(volume);
  }

  // Защитный порог: чистый спред не убывает с уменьшением объёма, поэтому
  // ищем наибольший объём, где он ещё ≥ порога, делением пополам.
  let thresholdCapped = false;
  if (best.netPct < minNetPct) {
    thresholdCapped = true;
    let a = 0;
    let b = volume;
    for (let i = 0; i < 30 && b - a > 1; i++) {
      const m = (a + b) / 2;
      if (at(m).netPct >= minNetPct) a = m;
      else b = m;
    }
    volume = a;
    best = at(volume);
  }

  return { ...best, liquidityCapped, thresholdCapped, curve };
}
