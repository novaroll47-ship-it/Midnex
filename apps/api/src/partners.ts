/**
 * Партнёрская программа для владельцев каналов (plan-partner-program).
 *
 * Партнёр даёт ссылку t.me/<бот>?start=p_<код> (или прямую на приложение с
 * startapp=p_<код>). Новый пользователь закрепляется за партнёром по первому
 * переходу; за каждую подтверждённую оплату закреплённого пользователя
 * партнёру начисляется процент от цены месяца — на удержании, потом к выплате.
 * Пользователю — +7 дней к первой оплаченной подписке.
 *
 * Условия копируются в начисление в момент оплаты: смена условий партнёра
 * прошлые начисления не трогает. Выплаты — вручную, админ отмечает командой.
 */
import type { FastifyBaseLogger } from 'fastify';
import { REFERRAL_BONUS_DAYS, monthPrice } from '@cs/shared';

import type {
  EarningRecord,
  PartnerRecord,
  PartnerStats,
  PartnerTerms,
  PaymentRecord,
  ReferralRecord,
  Repo,
} from './repo/index.js';

const DAY_MS = 86_400_000;

/** Стандартное предложение — пока админ не задал своё (app_config.partner_defaults). */
export const DEFAULT_TERMS: PartnerTerms = {
  rewardPercent: 28,
  rewardMonths: 1,
  attributionDays: 30,
  holdDays: 14,
};
export const DEFAULT_MIN_PAYOUT = 20;
/** После паузы оплаты уже закреплённых пользователей засчитываются ещё столько дней. */
export const PAUSE_GRACE_DAYS = 30;

const CONFIG_TERMS = 'partner_defaults';
const CONFIG_MIN_PAYOUT = 'partner_min_payout';

/** Код партнёра в ссылке: короткий, латиница/цифры/подчёркивание. */
export const CODE_RE = /^[a-z0-9_]{3,32}$/;
export const LINK_PREFIX = 'p_';

export type AttributeResult = 'ok' | 'no_partner' | 'paused' | 'self' | 'known' | 'already';

export interface PartnersOptions {
  repo: Repo;
  log: FastifyBaseLogger;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export class Partners {
  constructor(private readonly o: PartnersOptions) {}

  // ---------------------------------------------------------------- настройки

  async defaults(): Promise<PartnerTerms> {
    const raw = await this.o.repo.getConfig(CONFIG_TERMS);
    if (!raw) return { ...DEFAULT_TERMS };
    try {
      return { ...DEFAULT_TERMS, ...(JSON.parse(raw) as Partial<PartnerTerms>) };
    } catch {
      return { ...DEFAULT_TERMS };
    }
  }

  async setDefaults(terms: Partial<PartnerTerms>): Promise<PartnerTerms> {
    const next = { ...(await this.defaults()), ...terms };
    await this.o.repo.setConfig(CONFIG_TERMS, JSON.stringify(next));
    return next;
  }

  async minPayout(): Promise<number> {
    const raw = Number(await this.o.repo.getConfig(CONFIG_MIN_PAYOUT));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_PAYOUT;
  }

  async setMinPayout(usd: number): Promise<void> {
    await this.o.repo.setConfig(CONFIG_MIN_PAYOUT, String(usd));
  }

  // ---------------------------------------------------------------- закрепление

  /** Код из параметра запуска (`p_<код>`), либо null. */
  static codeFromStart(param: string | undefined): string | null {
    if (!param || !param.startsWith(LINK_PREFIX)) return null;
    const code = param.slice(LINK_PREFIX.length).toLowerCase();
    return CODE_RE.test(code) ? code : null;
  }

  /**
   * Переход по партнёрской ссылке. Закрепляем только нового пользователя
   * (`isNewUser` — записи в users ещё нет), по первому переходу, не за самого
   * себя и не за партнёра на паузе.
   */
  async attribute(userId: number, code: string, isNewUser: boolean): Promise<AttributeResult> {
    const partner = await this.o.repo.getPartnerByCode(code);
    if (!partner) return 'no_partner';
    if (partner.telegramId === userId) return 'self';
    if (partner.status !== 'active') return 'paused';
    if (await this.o.repo.getReferral(userId)) return 'already';
    if (!isNewUser) return 'known';
    const now = Date.now();
    const created = await this.o.repo.createReferral({
      userId,
      partnerId: partner.id,
      clickedAt: now,
      attributedUntil: now + partner.attributionDays * DAY_MS,
      convertedAt: null,
    });
    if (!created) return 'already';
    this.o.log.info({ user: userId, partner: partner.code }, 'партнёрка: пользователь закреплён');
    return 'ok';
  }

  /**
   * Действующее закрепление: оплатил хотя бы раз (постоянное) или окно
   * `attribution_days` ещё не закрылось.
   */
  async activeReferral(
    userId: number,
    now = Date.now(),
  ): Promise<{ partner: PartnerRecord; referral: ReferralRecord } | null> {
    const referral = await this.o.repo.getReferral(userId);
    if (!referral) return null;
    if (referral.convertedAt === null && referral.attributedUntil <= now) return null;
    const partner = await this.o.repo.getPartner(referral.partnerId);
    return partner ? { partner, referral } : null;
  }

  /** Сколько дней добавится к следующей оплате пользователя (подарок за переход по ссылке). */
  async bonusDaysFor(userId: number): Promise<number> {
    const ref = await this.activeReferral(userId);
    if (!ref || ref.referral.convertedAt !== null) return 0;
    if ((await this.o.repo.countPaidPayments(userId)) > 0) return 0;
    return REFERRAL_BONUS_DAYS;
  }

  // ---------------------------------------------------------------- начисления

  /**
   * Подтверждённая оплата (любой способ — вызывается из общей точки выдачи
   * доступа). Идемпотентно: начисление привязано к id платежа. Возвращает
   * бонусные дни для пользователя и созданное начисление.
   */
  async onPaid(p: PaymentRecord): Promise<{ bonusDays: number; earning: EarningRecord | null }> {
    const now = p.resolvedAt ?? Date.now();
    const ref = await this.activeReferral(p.userId, now);
    if (!ref) return { bonusDays: 0, earning: null };
    if (await this.o.repo.getEarningByPayment(p.id)) return { bonusDays: 0, earning: null };
    const { partner, referral } = ref;

    // Первая оплата: закрепление становится постоянным, пользователю — подарок.
    // Платёж к этому моменту уже помечен paid, поэтому «первая» = единственная.
    let bonusDays = 0;
    if (referral.convertedAt === null) {
      const paidBefore = await this.o.repo.countPaidPayments(p.userId);
      if (paidBefore <= 1) bonusDays = REFERRAL_BONUS_DAYS;
      referral.convertedAt = now;
      await this.o.repo.updateReferral(referral);
    }

    // Партнёр на паузе: старые пользователи засчитываются ещё PAUSE_GRACE_DAYS.
    if (
      partner.status === 'paused' &&
      partner.pausedAt !== null &&
      now - partner.pausedAt > PAUSE_GRACE_DAYS * DAY_MS
    ) {
      return { bonusDays, earning: null };
    }

    const already = await this.o.repo.sumMonthsRewarded(partner.id, p.userId);
    const remaining = partner.rewardMonths - already;
    if (remaining <= 0) return { bonusDays, earning: null };
    const monthsNow = Math.min(p.months, remaining);
    const price = round2(monthPrice(p.plan, p.months));
    const earning = await this.o.repo.createEarning({
      partnerId: partner.id,
      userId: p.userId,
      paymentId: p.id,
      monthsRewarded: monthsNow,
      monthPrice: price,
      rewardPercent: partner.rewardPercent,
      amount: round2((monthsNow * price * partner.rewardPercent) / 100),
      status: 'on_hold',
      createdAt: now,
      availableAt: now + partner.holdDays * DAY_MS,
      paidAt: null,
      payoutId: null,
    });
    this.o.log.info(
      { partner: partner.code, user: p.userId, payment: p.id, amount: earning.amount },
      'партнёрка: начисление',
    );
    return { bonusDays, earning };
  }

  /** Удержание вышло → доступно к выплате. Дёргается по таймеру. */
  async release(): Promise<number> {
    return this.o.repo.releaseEarnings(Date.now());
  }

  // ---------------------------------------------------------------- админ

  async create(
    telegramId: number,
    code: string,
    terms: Partial<PartnerTerms>,
  ): Promise<PartnerRecord | { error: string }> {
    const c = code.toLowerCase();
    if (!CODE_RE.test(c)) return { error: 'код: 3–32 символа, латиница, цифры, подчёркивание' };
    if (await this.o.repo.getPartnerByCode(c)) return { error: `код ${c} уже занят` };
    if (await this.o.repo.getPartnerByTelegramId(telegramId))
      return { error: 'этот аккаунт уже партнёр' };
    const t = { ...(await this.defaults()), ...terms };
    const bad = validateTerms(t);
    if (bad) return { error: bad };
    return this.o.repo.createPartner({ telegramId, code: c, status: 'active', ...t });
  }

  async setTerms(code: string, terms: Partial<PartnerTerms>): Promise<PartnerRecord | { error: string }> {
    const p = await this.o.repo.getPartnerByCode(code.toLowerCase());
    if (!p) return { error: `партнёр ${code} не найден` };
    const next = { ...p, ...terms };
    const bad = validateTerms(next);
    if (bad) return { error: bad };
    await this.o.repo.updatePartner(next);
    return next;
  }

  async setStatus(code: string, status: PartnerRecord['status']): Promise<PartnerRecord | null> {
    const p = await this.o.repo.getPartnerByCode(code.toLowerCase());
    if (!p) return null;
    p.status = status;
    p.pausedAt = status === 'paused' ? Date.now() : null;
    await this.o.repo.updatePartner(p);
    return p;
  }

  async byTelegramId(telegramId: number): Promise<PartnerRecord | null> {
    return this.o.repo.getPartnerByTelegramId(telegramId);
  }

  async byCode(code: string): Promise<PartnerRecord | null> {
    return this.o.repo.getPartnerByCode(code.toLowerCase());
  }

  async stats(partner: PartnerRecord): Promise<PartnerStats> {
    return this.o.repo.partnerStats(partner.id);
  }

  async list(): Promise<{ partner: PartnerRecord; stats: PartnerStats }[]> {
    const partners = await this.o.repo.listPartners();
    return Promise.all(partners.map(async (partner) => ({ partner, stats: await this.stats(partner) })));
  }

  /** Кому платить в этом месяце: доступная сумма не меньше минимальной. */
  async payable(): Promise<{ partner: PartnerRecord; stats: PartnerStats }[]> {
    const min = await this.minPayout();
    return (await this.list()).filter((x) => x.stats.available >= min);
  }

  async markPaid(code: string, reference: string | null) {
    const partner = await this.byCode(code);
    if (!partner) return null;
    const payout = await this.o.repo.createPayout(partner.id, reference);
    return payout ? { partner, payout } : null;
  }

  /** Начисления по месяцам (для сверки итогов партнёром). */
  async monthly(partner: PartnerRecord): Promise<{ month: string; amount: number; users: number }[]> {
    const list = await this.o.repo.listEarnings(partner.id);
    const by = new Map<string, { amount: number; users: Set<number> }>();
    for (const e of list) {
      const d = new Date(e.createdAt);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const row = by.get(key) ?? { amount: 0, users: new Set<number>() };
      row.amount += e.amount;
      row.users.add(e.userId);
      by.set(key, row);
    }
    return [...by.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([month, r]) => ({ month, amount: round2(r.amount), users: r.users.size }));
  }
}

function validateTerms(t: PartnerTerms): string | null {
  if (!(t.rewardPercent > 0 && t.rewardPercent <= 100)) return 'процент: от 0 до 100';
  if (!(Number.isInteger(t.rewardMonths) && t.rewardMonths >= 1 && t.rewardMonths <= 60))
    return 'месяцев: целое от 1 до 60';
  if (!(Number.isInteger(t.attributionDays) && t.attributionDays >= 1 && t.attributionDays <= 365))
    return 'дней закрепления: целое от 1 до 365';
  if (!(Number.isInteger(t.holdDays) && t.holdDays >= 0 && t.holdDays <= 180))
    return 'дней удержания: целое от 0 до 180';
  return null;
}

/** Человеческое описание условий — для партнёра и админа. */
export function termsText(t: PartnerTerms): string {
  const months =
    t.rewardMonths === 1
      ? 'первый оплаченный месяц'
      : `первые ${t.rewardMonths} оплаченных месяцев`;
  return `${t.rewardPercent}% от цены месяца, ${months} каждого пользователя`;
}

export function fmtUsd(v: number): string {
  return `$${round2(v).toFixed(2).replace(/\.00$/, '')}`;
}

/** Подозрительно: много переходов за месяц и ни одной оплаты. */
export function anomaly(s: PartnerStats): string | null {
  if (s.clicks30d >= 20 && s.paidUsers30d === 0) return 'много переходов, нет оплат';
  return null;
}
