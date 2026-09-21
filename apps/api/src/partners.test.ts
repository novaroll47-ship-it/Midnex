/**
 * Партнёрская программа: закрепление, начисления, удержание, выплаты —
 * на хранилище в памяти, без Telegram.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';

import { Billing } from './billing.js';
import { Partners } from './partners.js';
import { MemoryRepo } from './repo/memory.js';
import type { PaymentRecord } from './repo/types.js';

const DAY = 86_400_000;
const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

const PARTNER_TG = 100;
const USER = 200;

async function setup(terms: Partial<{ rewardMonths: number }> = {}) {
  const repo = new MemoryRepo();
  const partners = new Partners({ repo, log });
  const p = await partners.create(PARTNER_TG, 'cryptochannel', { rewardMonths: 1, ...terms });
  assert.ok(!('error' in p));
  return { repo, partners, partner: p };
}

function payment(id: string, months: 1 | 3 | 6 | 12, userId = USER): PaymentRecord {
  return {
    id,
    userId,
    plan: 'screener',
    months,
    method: 'stars',
    amount: 1,
    currency: 'XTR',
    status: 'paid',
    network: null,
    txHash: null,
    telegramChargeId: null,
    note: null,
    createdAt: Date.now(),
    resolvedAt: Date.now(),
  };
}

describe('закрепление по ссылке', () => {
  it('новый пользователь закрепляется по первому переходу, повторно — нет', async () => {
    const { partners } = await setup();
    assert.equal(await partners.attribute(USER, 'cryptochannel', true), 'ok');
    assert.equal(await partners.attribute(USER, 'cryptochannel', true), 'already');
    assert.equal(await partners.attribute(USER, 'other', true), 'no_partner');
  });

  it('уже зарегистрированный, сам партнёр и пауза — не закрепляются', async () => {
    const { partners } = await setup();
    assert.equal(await partners.attribute(300, 'cryptochannel', false), 'known');
    assert.equal(await partners.attribute(PARTNER_TG, 'cryptochannel', true), 'self');
    await partners.setStatus('cryptochannel', 'paused');
    assert.equal(await partners.attribute(400, 'cryptochannel', true), 'paused');
  });

  it('код из параметра запуска', () => {
    assert.equal(Partners.codeFromStart('p_CryptoChannel'), 'cryptochannel');
    assert.equal(Partners.codeFromStart('cryptochannel'), null);
    assert.equal(Partners.codeFromStart('p_a'), null);
    assert.equal(Partners.codeFromStart(undefined), null);
  });
});

describe('начисления', () => {
  it('первая оплата: процент от цены месяца, удержание, бонус пользователю', async () => {
    const { partners, repo } = await setup();
    await partners.attribute(USER, 'cryptochannel', true);
    const p = payment('a1', 1);
    await repo.createPayment(p);
    const r = await partners.onPaid(p);
    assert.equal(r.bonusDays, 7);
    assert.ok(r.earning);
    assert.equal(r.earning.amount, 7); // 28% × $25
    assert.equal(r.earning.status, 'on_hold');
    assert.ok(Math.abs(r.earning.availableAt - (p.resolvedAt! + 14 * DAY)) < 1000);
    // Повторный вебхук — без второго начисления.
    const again = await partners.onPaid(p);
    assert.equal(again.earning, null);
    assert.equal(again.bonusDays, 0);
    assert.equal(await partners.bonusDaysFor(USER), 0);
  });

  it('месяцы засчитываются с остатком: 1 + 12 при договоре на 3', async () => {
    const { partners, repo } = await setup({ rewardMonths: 3 });
    await partners.attribute(USER, 'cryptochannel', true);
    const p1 = payment('b1', 1);
    await repo.createPayment(p1);
    assert.equal((await partners.onPaid(p1)).earning?.amount, 7);
    const p2 = payment('b2', 12);
    await repo.createPayment(p2);
    const r2 = await partners.onPaid(p2);
    assert.equal(r2.bonusDays, 0); // бонус только к первой
    assert.equal(r2.earning?.monthsRewarded, 2);
    assert.equal(r2.earning?.amount, 9.8); // 2 × $17.50 × 28%
    const p3 = payment('b3', 1);
    await repo.createPayment(p3);
    assert.equal((await partners.onPaid(p3)).earning, null);
  });

  it('смена условий не трогает прошлые начисления', async () => {
    const { partners, repo, partner } = await setup({ rewardMonths: 3 });
    await partners.attribute(USER, 'cryptochannel', true);
    const p1 = payment('c1', 1);
    await repo.createPayment(p1);
    await partners.onPaid(p1);
    await partners.setTerms('cryptochannel', { rewardPercent: 50 });
    const list = await repo.listEarnings(partner.id);
    assert.equal(list[0]?.rewardPercent, 28);
    assert.equal(list[0]?.amount, 7);
    const p2 = payment('c2', 1);
    await repo.createPayment(p2);
    assert.equal((await partners.onPaid(p2)).earning?.amount, 12.5);
  });

  it('окно закрепления закрылось без оплаты — ни начисления, ни бонуса', async () => {
    const { partners, repo } = await setup();
    await partners.attribute(USER, 'cryptochannel', true);
    const ref = (await repo.getReferral(USER))!;
    ref.attributedUntil = Date.now() - 1;
    await repo.updateReferral(ref);
    assert.equal(await partners.bonusDaysFor(USER), 0);
    const p = payment('d1', 1);
    await repo.createPayment(p);
    const r = await partners.onPaid(p);
    assert.equal(r.bonusDays, 0);
    assert.equal(r.earning, null);
  });

  it('пауза партнёра: старые пользователи засчитываются ещё 30 дней', async () => {
    const { partners, repo } = await setup({ rewardMonths: 12 });
    await partners.attribute(USER, 'cryptochannel', true);
    const paused = (await partners.setStatus('cryptochannel', 'paused'))!;
    const p1 = payment('e1', 1);
    await repo.createPayment(p1);
    assert.ok((await partners.onPaid(p1)).earning);
    paused.pausedAt = Date.now() - 31 * DAY;
    await repo.updatePartner(paused);
    const p2 = payment('e2', 1);
    await repo.createPayment(p2);
    assert.equal((await partners.onPaid(p2)).earning, null);
  });
});

describe('удержание и выплаты', () => {
  it('после удержания — доступно, выплата закрывает начисления', async () => {
    const { partners, repo, partner } = await setup();
    await partners.attribute(USER, 'cryptochannel', true);
    const p = payment('f1', 1);
    await repo.createPayment(p);
    await partners.onPaid(p);
    assert.equal(await partners.release(), 0);
    const e = (await repo.listEarnings(partner.id))[0]!;
    e.availableAt = Date.now() - 1;
    assert.equal(await partners.release(), 1);
    let s = await partners.stats(partner);
    assert.equal(s.available, 7);
    assert.equal(s.paidUsers, 1);
    assert.equal(s.clicks, 1);
    assert.equal((await partners.payable()).length, 0); // меньше минимума $20
    await partners.setMinPayout(5);
    assert.equal((await partners.payable()).length, 1);
    const paid = await partners.markPaid('cryptochannel', 'tx-1');
    assert.equal(paid?.payout.amount, 7);
    s = await partners.stats(partner);
    assert.equal(s.available, 0);
    assert.equal(s.paid, 7);
    assert.equal((await partners.monthly(partner))[0]?.amount, 7);
  });
});

describe('оплата через Billing', () => {
  it('звёзды: подписка продлевается на срок плюс бонусные дни', async () => {
    const { partners, repo } = await setup();
    await partners.attribute(USER, 'cryptochannel', true);
    const billing = new Billing({ repo, log, adminId: null, starsPerUsd: 50, trading: false, partners });
    const p = { ...payment('g1', 1), status: 'pending' as const, resolvedAt: null };
    await repo.createPayment(p);
    const sub = await billing.starsPaid('g1', 'charge');
    assert.ok(sub);
    const days = (sub.expiresAt - Date.now()) / DAY;
    assert.ok(days > 36.9 && days <= 37, `ожидали 37 дней, получили ${days}`);
    assert.equal((await partners.stats((await partners.byCode('cryptochannel'))!)).onHold, 7);
  });
});
