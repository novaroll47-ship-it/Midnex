/**
 * Тарифы и цены.
 *
 * Цены в долларах — так они и объявлены аудитории. Оплата звёздами Telegram
 * пересчитывается по курсу STARS_PER_USD на сервере, оплата USDT — один к
 * одному. Скидка за срок растёт от ~12% за квартал до 30% за год: это
 * стимул платить вперёд и предоплаченный кэшфлоу на разработку следующих ботов.
 *
 * На этапе «только скринер» купить можно один тариф — Скринер; Стандарт и
 * Про показаны с ценами и бейджем «Скоро», чтобы было видно, что дальше.
 */
import type { PlanId } from './types.js';

export type BillingMonths = 1 | 3 | 6 | 12;
export const BILLING_MONTHS: BillingMonths[] = [1, 3, 6, 12];

/** Цена за весь срок, USD. */
export const PRICING: Record<PlanId, Record<BillingMonths, number>> = {
  screener: { 1: 25, 3: 65, 6: 120, 12: 210 },
  limited: { 1: 49, 3: 129, 6: 235, 12: 410 },
  unlimited: { 1: 69, 3: 185, 6: 330, 12: 580 },
};

/** Тарифы в порядке возрастания. */
export const PLAN_ORDER: PlanId[] = ['screener', 'limited', 'unlimited'];

/** Какие тарифы можно купить сейчас; остальные — «Скоро». */
export function purchasablePlans(trading: boolean): PlanId[] {
  return trading ? PLAN_ORDER : ['screener'];
}

/** Скидка относительно помесячной оплаты, в процентах (0 для одного месяца). */
export function discountPct(plan: PlanId, months: BillingMonths): number {
  const monthly = PRICING[plan][1] * months;
  return Math.round((1 - PRICING[plan][months] / monthly) * 100);
}

/** stars — Telegram Stars; crypto — перевод USDT с ручным подтверждением; cryptobot — счёт @CryptoBot. */
export type PaymentMethod = 'stars' | 'crypto' | 'cryptobot';
export type PaymentStatus = 'pending' | 'paid' | 'rejected' | 'cancelled';

/** Подписка пользователя, как её видит интерфейс. */
export interface SubscriptionInfo {
  plan: PlanId;
  /** Активна прямо сейчас. */
  active: boolean;
  /** Когда истекает, мс; null — подписки не было. */
  expiresAt: number | null;
  /** Дней осталось (0, если истекла). */
  daysLeft: number;
  /** Откуда доступ: trial | stars | crypto | manual | admin; null — подписки нет. */
  source: string | null;
}

/** Заявка на оплату, как её видит интерфейс. */
export interface PaymentInfo {
  id: string;
  plan: PlanId;
  months: BillingMonths;
  method: PaymentMethod;
  amount: number;
  currency: 'XTR' | 'USDT';
  status: PaymentStatus;
  network: string | null;
  txHash: string | null;
  createdAt: number;
}

/** Бесплатная неделя новым пользователям — один раз на аккаунт. */
export const TRIAL_DAYS = 7;
