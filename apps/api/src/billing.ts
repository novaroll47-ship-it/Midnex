/**
 * Подписки и оплата.
 *
 * Два способа: звёзды Telegram (инвойс создаёт сервер, платёж подтверждает
 * сам Telegram через successful_payment) и USDT на кошелёк (пользователь
 * присылает хэш перевода, админ подтверждает командой в боте). Ручное
 * подтверждение — осознанно: на десятки платежей в месяц посредник за
 * процент не нужен, а хэш в блокчейне проверяется за минуту.
 *
 * Доступ к скринеру определяется здесь же: активная подписка, либо админ.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  BILLING_MONTHS,
  PRICING,
  purchasablePlans,
  type BillingMonths,
  type PaymentInfo,
  type PlanId,
  type SubscriptionInfo,
} from '@cs/shared';

import type { PaymentRecord, Repo, SubscriptionRecord } from './repo/index.js';

export interface CryptoWallet {
  network: string;
  address: string;
}

export interface BillingOptions {
  repo: Repo;
  log: FastifyBaseLogger;
  botToken?: string;
  /** Telegram ID владельца: без подписки и с админ-командами. */
  adminId: number | null;
  /** Курс: сколько звёзд за один доллар. */
  starsPerUsd: number;
  wallets: CryptoWallet[];
  trading: boolean;
}

const DAY_MS = 86_400_000;
const MONTH_DAYS = 30;

/** Сколько дней даёт покупка на N месяцев. */
export function daysFor(months: BillingMonths): number {
  return months * MONTH_DAYS;
}

/** Короткий код заявки — его удобно диктовать и вводить в команде бота. */
function paymentId(): string {
  return randomBytes(3).toString('hex');
}

export class Billing {
  constructor(private readonly o: BillingOptions) {}

  get wallets(): CryptoWallet[] {
    return this.o.wallets;
  }

  get adminId(): number | null {
    return this.o.adminId;
  }

  isAdmin(userId: number): boolean {
    return this.o.adminId !== null && userId === this.o.adminId;
  }

  starsFor(usd: number): number {
    return Math.max(1, Math.round(usd * this.o.starsPerUsd));
  }

  // ---------------------------------------------------------------- доступ

  toInfo(sub: SubscriptionRecord | null, userId: number): SubscriptionInfo {
    const now = Date.now();
    if (this.isAdmin(userId)) {
      return { plan: 'unlimited', active: true, expiresAt: null, daysLeft: 3650 };
    }
    if (!sub) return { plan: 'screener', active: false, expiresAt: null, daysLeft: 0 };
    const left = Math.max(0, Math.ceil((sub.expiresAt - now) / DAY_MS));
    return {
      plan: sub.plan,
      active: sub.expiresAt > now,
      expiresAt: sub.expiresAt,
      daysLeft: left,
    };
  }

  async info(userId: number): Promise<SubscriptionInfo> {
    return this.toInfo(await this.o.repo.getSubscription(userId), userId);
  }

  async hasAccess(userId: number): Promise<boolean> {
    return (await this.info(userId)).active;
  }

  // ---------------------------------------------------------------- заявки

  private validate(plan: string, months: number): { plan: PlanId; months: BillingMonths } | null {
    const ok = purchasablePlans(this.o.trading).includes(plan as PlanId);
    if (!ok || !BILLING_MONTHS.includes(months as BillingMonths)) return null;
    return { plan: plan as PlanId, months: months as BillingMonths };
  }

  /** Инвойс в звёздах: возвращает ссылку, которую откроет мини-приложение. */
  async createStarsInvoice(
    userId: number,
    planRaw: string,
    monthsRaw: number,
  ): Promise<{ payment: PaymentRecord; link: string } | { error: string }> {
    const v = this.validate(planRaw, monthsRaw);
    if (!v) return { error: 'bad plan or term' };
    if (!this.o.botToken) return { error: 'bot not configured' };

    const usd = PRICING[v.plan][v.months];
    const stars = this.starsFor(usd);
    const payment: PaymentRecord = {
      id: paymentId(),
      userId,
      plan: v.plan,
      months: v.months,
      method: 'stars',
      amount: stars,
      currency: 'XTR',
      status: 'pending',
      network: null,
      txHash: null,
      telegramChargeId: null,
      note: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };

    const res = await fetch(`https://api.telegram.org/bot${this.o.botToken}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `MIDNEX · ${planTitle(v.plan)} · ${v.months} мес.`,
        description: `Доступ к скринеру спредов на ${v.months * MONTH_DAYS} дней`,
        payload: payment.id,
        currency: 'XTR',
        prices: [{ label: `${planTitle(v.plan)} ${v.months} мес.`, amount: stars }],
      }),
    });
    const body = (await res.json()) as { ok: boolean; result?: string; description?: string };
    if (!body.ok || !body.result) {
      this.o.log.error({ description: body.description }, 'оплата: не создал инвойс');
      return { error: body.description ?? 'invoice failed' };
    }
    await this.o.repo.createPayment(payment);
    return { payment, link: body.result };
  }

  /** Telegram спрашивает перед списанием — проверяем, что заявка живая. */
  async preCheckout(payloadId: string): Promise<{ ok: boolean; error?: string }> {
    const p = await this.o.repo.getPayment(payloadId);
    if (!p || p.method !== 'stars') return { ok: false, error: 'Заявка не найдена' };
    if (p.status !== 'pending') return { ok: false, error: 'Заявка уже закрыта' };
    return { ok: true };
  }

  /** Звёзды списаны — продлеваем подписку. */
  async starsPaid(payloadId: string, chargeId: string): Promise<SubscriptionRecord | null> {
    const p = await this.o.repo.getPayment(payloadId);
    if (!p || p.status !== 'pending') return null;
    p.status = 'paid';
    p.telegramChargeId = chargeId;
    p.resolvedAt = Date.now();
    await this.o.repo.updatePayment(p);
    const sub = await this.o.repo.extendSubscription(p.userId, p.plan, daysFor(p.months), 'stars');
    this.o.log.info({ user: p.userId, plan: p.plan, months: p.months }, 'оплата: звёзды приняты');
    return sub;
  }

  /** Заявка на оплату USDT: сумма, кошелёк и код для подтверждения. */
  async createCryptoRequest(
    userId: number,
    planRaw: string,
    monthsRaw: number,
    network: string,
  ): Promise<{ payment: PaymentRecord; wallet: CryptoWallet } | { error: string }> {
    const v = this.validate(planRaw, monthsRaw);
    if (!v) return { error: 'bad plan or term' };
    const wallet = this.o.wallets.find((w) => w.network === network);
    if (!wallet) return { error: 'unknown network' };

    // Одна открытая крипто-заявка на пользователя: иначе путаница у админа.
    for (const old of await this.o.repo.listPendingPayments(userId)) {
      if (old.method === 'crypto') {
        old.status = 'cancelled';
        old.resolvedAt = Date.now();
        await this.o.repo.updatePayment(old);
      }
    }

    const payment: PaymentRecord = {
      id: paymentId(),
      userId,
      plan: v.plan,
      months: v.months,
      method: 'crypto',
      amount: PRICING[v.plan][v.months],
      currency: 'USDT',
      status: 'pending',
      network: wallet.network,
      txHash: null,
      telegramChargeId: null,
      note: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    await this.o.repo.createPayment(payment);
    return { payment, wallet };
  }

  /** Пользователь прислал хэш перевода — заявка уходит админу. */
  async submitTxHash(userId: number, id: string, txHash: string): Promise<PaymentRecord | null> {
    const p = await this.o.repo.getPayment(id);
    if (!p || p.userId !== userId || p.method !== 'crypto' || p.status !== 'pending') return null;
    p.txHash = txHash.trim().slice(0, 128);
    await this.o.repo.updatePayment(p);
    return p;
  }

  async cancel(userId: number, id: string): Promise<boolean> {
    const p = await this.o.repo.getPayment(id);
    if (!p || p.userId !== userId || p.status !== 'pending') return false;
    p.status = 'cancelled';
    p.resolvedAt = Date.now();
    await this.o.repo.updatePayment(p);
    return true;
  }

  /** Админ подтвердил перевод. */
  async approve(id: string): Promise<{ payment: PaymentRecord; sub: SubscriptionRecord } | null> {
    const p = await this.o.repo.getPayment(id);
    if (!p || p.status !== 'pending') return null;
    p.status = 'paid';
    p.resolvedAt = Date.now();
    await this.o.repo.updatePayment(p);
    const sub = await this.o.repo.extendSubscription(p.userId, p.plan, daysFor(p.months), 'crypto');
    return { payment: p, sub };
  }

  async reject(id: string, note: string | null): Promise<PaymentRecord | null> {
    const p = await this.o.repo.getPayment(id);
    if (!p || p.status !== 'pending') return null;
    p.status = 'rejected';
    p.note = note;
    p.resolvedAt = Date.now();
    await this.o.repo.updatePayment(p);
    return p;
  }

  /** Ручное продление админом (тест, подарок, компенсация). */
  async grant(userId: number, days: number, plan: PlanId): Promise<SubscriptionRecord> {
    return this.o.repo.extendSubscription(userId, plan, days, 'manual');
  }

  async pendingFor(userId: number): Promise<PaymentInfo | null> {
    const list = await this.o.repo.listPendingPayments(userId);
    const p = list.find((x) => x.method === 'crypto');
    return p ? toPaymentInfo(p) : null;
  }
}

export function toPaymentInfo(p: PaymentRecord): PaymentInfo {
  return {
    id: p.id,
    plan: p.plan,
    months: p.months,
    method: p.method,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    network: p.network,
    txHash: p.txHash,
    createdAt: p.createdAt,
  };
}

export function planTitle(plan: PlanId): string {
  return plan === 'screener' ? 'Скринер' : plan === 'limited' ? 'Стандарт' : 'Про';
}
