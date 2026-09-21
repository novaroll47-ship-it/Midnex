// npx tsx --test packages/market/src/liquidity.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeBook,
  recommendVolume,
  simulateFill,
  spreadOnVolume,
  type BookLevel,
  type LegBook,
} from './liquidity.js';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

describe('simulateFill', () => {
  it('пустой стакан — ничего не набрано', () => {
    const r = simulateFill([], 10);
    assert.equal(r.filledQty, 0);
    assert.equal(r.fullyFilled, false);
    assert.equal(r.avgPrice, 0);
  });

  it('один уровень вмещает всё — цена уровня', () => {
    const r = simulateFill([[100, 50]], 10);
    assert.deepEqual(r, { avgPrice: 100, filledQty: 10, levelsUsed: 1, fullyFilled: true, cost: 1000 });
  });

  it('несколько уровней — средневзвешенная', () => {
    const asks: BookLevel[] = [
      [100, 5],
      [101, 5],
      [103, 100],
    ];
    const r = simulateFill(asks, 12);
    // 5×100 + 5×101 + 2×103 = 1211
    close(r.cost, 1211);
    close(r.avgPrice, 1211 / 12);
    assert.equal(r.levelsUsed, 3);
    assert.equal(r.fullyFilled, true);
  });

  it('стакан короче объёма — набрано сколько есть, fullyFilled = false', () => {
    const r = simulateFill(
      [
        [100, 5],
        [101, 5],
      ],
      12,
    );
    assert.equal(r.filledQty, 10);
    assert.equal(r.fullyFilled, false);
    close(r.avgPrice, 100.5);
  });

  it('нулевой или отрицательный объём', () => {
    assert.equal(simulateFill([[100, 5]], 0).filledQty, 0);
    assert.equal(simulateFill([[100, 5]], -1).filledQty, 0);
  });

  it('мусорные уровни пропускаются', () => {
    const r = simulateFill(
      [
        [0, 5],
        [100, 0],
        [100, 5],
      ],
      5,
    );
    assert.equal(r.levelsUsed, 1);
    assert.equal(r.avgPrice, 100);
  });
});

describe('normalizeBook', () => {
  it('1000PEPE: цена за монету, количество в монетах', () => {
    const levels = normalizeBook(
      [
        [12.5, 3],
        [12.6, 1],
      ],
      { multiplier: 1000, contractSize: 1 },
    );
    assert.deepEqual(levels, [
      [0.0125, 3000],
      [0.0126, 1000],
    ]);
  });

  it('контракт 0.001 BTC', () => {
    const levels = normalizeBook([[60_000, 10]], { multiplier: 1, contractSize: 0.001 });
    assert.deepEqual(levels, [[60_000, 0.01]]);
  });
});

/** Стаканы: дешёвая биржа с асками от 100, дорогая с бидами от 102. */
function books(depth = 5, step = 0.5, qty = 10): { long: LegBook; short: LegBook } {
  const asks: BookLevel[] = [];
  const bids: BookLevel[] = [];
  for (let i = 0; i < depth; i++) {
    asks.push([100 + i * step, qty]);
    bids.push([102 - i * step, qty]);
  }
  return {
    long: { asks, bids: [], taker: 0.0005 },
    short: { asks: [], bids, taker: 0.0005 },
  };
}

describe('spreadOnVolume', () => {
  it('маленький объём — спред по лучшим ценам минус комиссии', () => {
    const { long, short } = books();
    const r = spreadOnVolume(long, short, 500);
    assert.equal(r.fullyFilled, true);
    assert.equal(r.limitingLeg, null);
    close(r.qty, 5);
    close(r.grossPct, 2);
    close(r.feesPct, 0.2);
    close(r.netPct, 1.8);
    close(r.profitUsdt, 500 * 0.018);
  });

  it('ноги выровнены по монетам: Q одинаковое, доллары — нет', () => {
    const { long, short } = books();
    const r = spreadOnVolume(long, short, 1000);
    close(r.qty, 10);
    close(r.buyAvg, 100);
    close(r.sellAvg, 102);
    // Продажа принесёт 1020 USDT при покупке за 1000 — это и есть 2 %.
    close(r.volumeUsdt, 1000);
  });

  it('объём глубже — спред сжимается', () => {
    const { long, short } = books();
    const small = spreadOnVolume(long, short, 500);
    const big = spreadOnVolume(long, short, 3000);
    assert.ok(big.grossPct < small.grossPct);
    assert.ok(big.profitUsdt > small.profitUsdt, 'на 3000 прибыль в долларах всё ещё выше');
  });

  it('стакан закончился — считаем только до доступного и называем ногу', () => {
    const { long, short } = books(5, 0.5, 10); // по 50 монет в каждой ноге
    short.bids = short.bids.slice(0, 2); // на дорогой бирже только 20 монет
    const r = spreadOnVolume(long, short, 10_000); // просим 100 монет
    assert.equal(r.fullyFilled, false);
    assert.equal(r.limitingLeg, 'short');
    close(r.qty, 20);
    assert.ok(r.volumeUsdt < 2100 && r.volumeUsdt > 1900);
    assert.equal(r.requestedUsdt, 10_000);
  });

  it('фандинг прибавляется к чистому', () => {
    const { long, short } = books();
    const r = spreadOnVolume(long, short, 500, 0.1);
    close(r.netPct, 1.9);
  });

  it('пустые стаканы — нули без исключений', () => {
    const r = spreadOnVolume({ asks: [], bids: [], taker: 0 }, { asks: [], bids: [], taker: 0 }, 1000);
    assert.equal(r.qty, 0);
    assert.equal(r.profitUsdt, 0);
  });
});

describe('recommendVolume', () => {
  it('тонкий стакан рекомендует меньше, чем глубокий', () => {
    // Тонкий: 12 монет на сторону, спред почти не сжимается — прибыль растёт,
    // пока есть стакан, и рекомендация упирается в ликвидность (~1200 USDT).
    const thin = books(3, 0.05, 4);
    const deep = books(20, 0.05, 100);
    const a = recommendVolume(thin.long, thin.short);
    const b = recommendVolume(deep.long, deep.short);
    assert.ok(a.volumeUsdt < b.volumeUsdt, `${a.volumeUsdt} < ${b.volumeUsdt}`);
    assert.equal(a.liquidityCapped, true);
    assert.ok(a.volumeUsdt > 1150 && a.volumeUsdt < 1250, String(a.volumeUsdt));
  });

  it('максимум прибыли — не первая и не последняя точка сетки', () => {
    // Спред 2 %, каждый уровень по 20 монет с шагом 0.25 — прибыль растёт,
    // потом уровни съедают спред.
    const { long, short } = books(40, 0.25, 20);
    const r = recommendVolume(long, short, { minNetPct: 0 });
    assert.ok(r.volumeUsdt > 1000 && r.volumeUsdt < 50_000, String(r.volumeUsdt));
    // На рекомендованном объёме прибыль не меньше, чем в любой точке сетки.
    for (const p of r.curve) assert.ok(r.profitUsdt >= p.profitUsdt - 1e-6, `${r.profitUsdt} < ${p.profitUsdt}`);
  });

  it('защитный порог останавливает раньше максимума', () => {
    const { long, short } = books(40, 0.25, 20);
    const free = recommendVolume(long, short, { minNetPct: 0 });
    assert.ok(free.netPct < 1.5, `в максимуме чистый спред ${free.netPct} — ниже порога 1.5`);
    const safe = recommendVolume(long, short, { minNetPct: 1.5 });
    assert.equal(safe.thresholdCapped, true);
    assert.ok(safe.volumeUsdt < free.volumeUsdt);
    assert.ok(safe.netPct >= 1.5 - 1e-6, String(safe.netPct));
  });

  it('порог не влияет, если максимум и так выше него', () => {
    const { long, short } = books(40, 0.25, 20);
    const free = recommendVolume(long, short, { minNetPct: 0 });
    const safe = recommendVolume(long, short, { minNetPct: 0.3 });
    if (free.netPct >= 0.3) {
      assert.equal(safe.thresholdCapped, false);
      close(safe.volumeUsdt, free.volumeUsdt, 2);
    }
  });

  it('кривая по сетке возвращается для графика', () => {
    const { long, short } = books();
    const r = recommendVolume(long, short);
    assert.equal(r.curve.length, 9);
    assert.equal(r.curve[0]!.volumeUsdt, 100);
  });
});
