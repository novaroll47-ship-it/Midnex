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

import type { CryptoPay } from './cryptopay.js';
import type { FastifyBaseLogger } from 'fastify';
import {
  BILLING_MONTHS,
  PRICING,
  TRIAL_DAYS,
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
  /** Crypto Pay API (@CryptoBot); null — способ выключен. */
  cryptoPay?: CryptoPay | null;
  /** Куда вести после оплаты (кнопка в счёте). */
  publicUrl?: string;
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
      return { plan: 'unlimited', active: true, expiresAt: null, daysLeft: 3650, source: 'admin' };
    }
    if (!sub)
      return { plan: 'screener', active: false, expiresAt: null, daysLeft: 0, source: null };
    const left = Math.max(0, Math.ceil((sub.expiresAt - now) / DAY_MS));
    return {
      plan: sub.plan,
      active: sub.expiresAt > now,
      expiresAt: sub.expiresAt,
      daysLeft: left,
      source: sub.source,
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

    // Одна живая заявка в звёздах: прежние счета в чате Telegram отклонит на
    // pre_checkout («заявка уже закрыта»), и двойного списания не будет.
    for (const old of await this.o.repo.listPendingPayments(userId)) {
      if (old.method === 'stars') {
        old.status = 'cancelled';
        old.resolvedAt = Date.now();
        await this.o.repo.updatePayment(old);
      }
    }

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
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { ok: boolean; result?: string; description?: string };
    if (!body.ok || !body.result) {
      this.o.log.error({ description: body.description }, 'оплата: не создал инвойс');
      return { error: body.description ?? 'invoice failed' };
    }
    await this.o.repo.createPayment(payment);

    return { payment, link: body.result };
  }

  /**
   * Тот же счёт сообщением в чат — запасной путь, когда окно оплаты внутри
   * мини-приложения не открылось. Отдельным вызовом, чтобы не засорять чат
   * счетами при каждой попытке.
   */
  async sendInvoiceToChat(userId: number, paymentId: string): Promise<boolean> {
    const p = await this.o.repo.getPayment(paymentId);
    if (!p || p.userId !== userId || p.method !== 'stars' || p.status !== 'pending') return false;
    if (!this.o.botToken) return false;
    try {
      const sent = await fetch(`https://api.telegram.org/bot${this.o.botToken}/sendInvoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: userId,
          title: `MIDNEX · ${planTitle(p.plan)} · ${p.months} мес.`,
          description: `Доступ к скринеру спредов на ${p.months * MONTH_DAYS} дней`,
          payload: p.id,
          currency: 'XTR',
          prices: [{ label: `${planTitle(p.plan)} ${p.months} мес.`, amount: p.amount }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return ((await sent.json()) as { ok: boolean }).ok;
    } catch (err) {
      this.o.log.warn({ err: String(err) }, 'оплата: счёт в чат не ушёл');
      return false;
    }
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
    p.telegramChargeId = chargeId;
    return this.activate(p, 'stars');
  }

  get cryptoBotAvailable(): boolean {
    return Boolean(this.o.cryptoPay);
  }

  /**
   * Счёт в USDT через @CryptoBot. Заявка живёт до подтверждения вебхуком;
   * id счёта хранится в txHash (внешний идентификатор платежа).
   */
  async createCryptoBotInvoice(
    userId: number,
    planRaw: string,
    monthsRaw: number,
  ): Promise<{ payment: PaymentRecord; payUrl: string; botUrl: string } | { error: string }> {
    const v = this.validate(planRaw, monthsRaw);
    if (!v) return { error: 'bad plan or term' };
    const pay = this.o.cryptoPay;
    if (!pay) return { error: 'cryptobot not configured' };

    // Одна живая заявка CryptoBot: старые отменяем у себя (их счета просто истекут).
    for (const old of await this.o.repo.listPendingPayments(userId)) {
      if (old.method === 'cryptobot') {
        old.status = 'cancelled';
        old.resolvedAt = Date.now();
        await this.o.repo.updatePayment(old);
      }
    }

    const usd = PRICING[v.plan][v.months];
    const payment: PaymentRecord = {
      id: paymentId(),
      userId,
      plan: v.plan,
      months: v.months,
      method: 'cryptobot',
      amount: usd,
      currency: 'USDT',
      status: 'pending',
      network: pay.isTestnet ? 'cryptobot-testnet' : 'cryptobot',
      txHash: null,
      telegramChargeId: null,
      note: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    try {
      const inv = await pay.createInvoice({
        amountUsdt: usd,
        description: `MIDNEX · ${planTitle(v.plan)} · ${v.months} мес. (${v.months * MONTH_DAYS} дней)`,
        payload: JSON.stringify({ p: payment.id, u: userId, plan: v.plan, m: v.months }),
        expiresInSec: 3600,
        paidBtnUrl: this.o.publicUrl,
      });
      payment.txHash = String(inv.invoiceId);
      await this.o.repo.createPayment(payment);
      return { payment, payUrl: inv.payUrl, botUrl: inv.botUrl };
    } catch (err) {
      this.o.log.error({ err: String(err) }, 'оплата: CryptoBot не создал счёт');
      return { error: 'invoice failed' };
    }
  }

  /**
   * Счёт CryptoBot оплачен (вебхук или опрос). Идемпотентно: повторное
   * уведомление об уже закрытой заявке ничего не продлевает. Сумма и актив
   * сверяются с заявкой — данным снаружи не доверяем.
   */
  async cryptoBotPaid(
    invoiceId: number,
    amount: string,
    asset: string,
  ): Promise<SubscriptionRecord | null> {
    const p = (await this.o.repo.listPendingPayments()).find(
      (x) => x.method === 'cryptobot' && x.txHash === String(invoiceId),
    );
    if (!p) return null; // уже обработан или чужой счёт
    if (asset !== 'USDT' || Number(amount) + 1e-6 < p.amount) {
      this.o.log.warn(
        { invoiceId, amount, asset, expected: p.amount },
        'оплата: CryptoBot — сумма не сошлась',
      );
      return null;
    }
    return this.activate(p, 'cryptobot');
  }

  /** Общая точка выдачи доступа для всех способов оплаты. */
  private async activate(p: PaymentRecord, source: string): Promise<SubscriptionRecord> {
    p.status = 'paid';
    p.resolvedAt = Date.now();
    await this.o.repo.updatePayment(p);
    const sub = await this.o.repo.extendSubscription(p.userId, p.plan, daysFor(p.months), source);
    this.o.log.info(
      { user: p.userId, plan: p.plan, months: p.months, source },
      'оплата: доступ выдан',
    );
    return sub;
  }

  /** Запасной путь: опросить CryptoBot по незакрытым заявкам (пропущенный вебхук). */
  async pollCryptoBot(): Promise<number> {
    const pay = this.o.cryptoPay;
    if (!pay) return 0;
    const pending = (await this.o.repo.listPendingPayments()).filter(
      (x) => x.method === 'cryptobot' && x.txHash,
    );
    if (pending.length === 0) return 0;
    let paid = 0;
    const invoices = await pay.getInvoices(pending.map((x) => Number(x.txHash)));
    for (const inv of invoices) {
      if (inv.status === 'paid') {
        if (await this.cryptoBotPaid(inv.invoiceId, inv.amount, inv.asset)) paid++;
      } else if (inv.status === 'expired') {
        const p = pending.find((x) => x.txHash === String(inv.invoiceId));
        if (p) {
          p.status = 'cancelled';
          p.note = 'счёт истёк';
          p.resolvedAt = Date.now();
          await this.o.repo.updatePayment(p);
        }
      }
    }
    return paid;
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
    const sub = await this.activate(p, 'crypto');
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

  /**
   * Пробная неделя при первом появлении пользователя. Привязана к Telegram ID:
   * второй раз не выдаётся, даже если подписка давно истекла.
   */
  async grantTrialIfEligible(
    userId: number,
    trialUsedAt: number | null,
  ): Promise<SubscriptionRecord | null> {
    if (trialUsedAt !== null || this.isAdmin(userId)) return null;
    const existing = await this.o.repo.getSubscription(userId);
    if (existing) return null;
    await this.o.repo.markTrialUsed(userId);
    const sub = await this.o.repo.extendSubscription(userId, 'screener', TRIAL_DAYS, 'trial');
    this.o.log.info({ user: userId }, 'подписка: выдана пробная неделя');
    return sub;
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
