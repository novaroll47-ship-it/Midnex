/**
 * Хранилище в памяти процесса.
 *
 * Используется, когда DATABASE_URL не задан: локальная разработка без базы
 * и страховка на случай, если база недоступна при старте. Всё пропадает
 * с перезапуском — это осознанно, в проде оно не используется.
 */
import { randomUUID } from 'node:crypto';
import type { ExchangeId, PlanId, WatchEntry } from '@cs/shared';

import type {
  AlertRuleRecord,
  EarningRecord,
  EarningStatus,
  PartnerRecord,
  PartnerStats,
  PaymentRecord,
  PayoutRecord,
  ReferralRecord,
  SubscriptionRecord,
  VerifiedSymbolRecord,
  VerifiedPairRecord,
  InstrumentNominalRecord,
  ExchangeKeyRecord,
  PositionRecord,
  Repo,
  SessionRecord,
  UserRecord,
  UserSettings,
} from './types.js';

export class MemoryRepo implements Repo {
  readonly kind = 'memory' as const;

  private users = new Map<number, UserRecord>();
  private settings = new Map<number, UserSettings>();
  private positions = new Map<number, Map<string, PositionRecord>>();
  private watchlists = new Map<number, WatchEntry[]>();
  private keys = new Map<number, Map<ExchangeId, ExchangeKeyRecord>>();
  private sessions = new Map<number, Map<string, SessionRecord>>();
  private subscriptions = new Map<number, SubscriptionRecord>();
  private payments = new Map<string, PaymentRecord>();
  private verified = new Map<string, VerifiedSymbolRecord>();
  private pairs = new Map<string, VerifiedPairRecord>();
  private config = new Map<string, string>();
  private partners = new Map<number, PartnerRecord>();
  private referrals = new Map<number, ReferralRecord>();
  private earnings = new Map<number, EarningRecord>();
  private payouts = new Map<number, PayoutRecord>();
  private seq = 1;
  private nominals = new Map<string, InstrumentNominalRecord>();
  private alerts = new Map<string, AlertRuleRecord>();

  async upsertUser(u: {
    id: number;
    username?: string;
    firstName: string;
    language?: string;
  }): Promise<UserRecord> {
    const now = Date.now();
    const existing = this.users.get(u.id);
    const record: UserRecord = existing
      ? {
          ...existing,
          username: u.username ?? existing.username,
          firstName: u.firstName,
          lastSeenAt: now,
        }
      : {
          id: u.id,
          username: u.username ?? null,
          firstName: u.firstName,
          language: u.language ?? 'ru',
          plan: 'unlimited',
          createdAt: now,
          lastSeenAt: now,
          trialUsedAt: null,
        };
    this.users.set(u.id, record);
    return record;
  }

  async setPlan(userId: number, plan: PlanId): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.plan = plan;
  }

  async getSettings(userId: number): Promise<UserSettings | null> {
    return this.settings.get(userId) ?? null;
  }

  async saveSettings(userId: number, s: UserSettings): Promise<void> {
    this.settings.set(userId, structuredClone(s));
  }

  async listPositions(userId: number): Promise<PositionRecord[]> {
    return [...(this.positions.get(userId)?.values() ?? [])].map((p) => ({ ...p }));
  }

  async savePosition(record: PositionRecord): Promise<void> {
    let map = this.positions.get(record.userId);
    if (!map) {
      map = new Map();
      this.positions.set(record.userId, map);
    }
    map.set(record.id, { ...record, id: record.id || randomUUID() });
  }

  async getWatchlist(userId: number): Promise<WatchEntry[]> {
    return (this.watchlists.get(userId) ?? []).map((e) => ({ ...e, bots: [...e.bots] }));
  }

  async setWatchlist(userId: number, entries: WatchEntry[]): Promise<void> {
    const seen = new Set<string>();
    this.watchlists.set(
      userId,
      entries.filter((e) => !seen.has(e.base) && seen.add(e.base)).map((e) => ({ ...e, bots: [...e.bots] })),
    );
  }

  async listKeys(userId: number): Promise<ExchangeKeyRecord[]> {
    return [...(this.keys.get(userId)?.values() ?? [])].map((k) => ({ ...k }));
  }

  async upsertKey(record: ExchangeKeyRecord): Promise<void> {
    let map = this.keys.get(record.userId);
    if (!map) {
      map = new Map();
      this.keys.set(record.userId, map);
    }
    map.set(record.exchange, { ...record });
  }

  async deleteKey(userId: number, exchange: ExchangeId): Promise<void> {
    this.keys.get(userId)?.delete(exchange);
  }

  async touchSession(userId: number, platform: string, tgVersion: string): Promise<void> {
    let map = this.sessions.get(userId);
    if (!map) {
      map = new Map();
      this.sessions.set(userId, map);
    }
    const key = `${platform}|${tgVersion}`;
    const now = Date.now();
    const existing = map.get(key);
    map.set(
      key,
      existing
        ? { ...existing, lastSeenAt: now }
        : { id: randomUUID(), userId, platform, tgVersion, firstSeenAt: now, lastSeenAt: now },
    );
  }

  async listSessions(userId: number): Promise<SessionRecord[]> {
    return [...(this.sessions.get(userId)?.values() ?? [])].sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt,
    );
  }

  async deleteOtherSessions(userId: number, platform: string, tgVersion: string): Promise<number> {
    const map = this.sessions.get(userId);
    if (!map) return 0;
    const keep = `${platform}|${tgVersion}`;
    let removed = 0;
    for (const key of [...map.keys()]) {
      if (key !== keep) {
        map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async getUser(userId: number): Promise<UserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const wanted = username.replace(/^@/, '').toLowerCase();
    for (const u of this.users.values()) {
      if (u.username?.toLowerCase() === wanted) return u;
    }
    return null;
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async markTrialUsed(userId: number): Promise<void> {
    const u = this.users.get(userId);
    if (u) this.users.set(userId, { ...u, trialUsedAt: Date.now() });
  }

  async getSubscription(userId: number): Promise<SubscriptionRecord | null> {
    return this.subscriptions.get(userId) ?? null;
  }

  async extendSubscription(
    userId: number,
    plan: PlanId,
    days: number,
    source: string,
  ): Promise<SubscriptionRecord> {
    const now = Date.now();
    const current = this.subscriptions.get(userId);
    const base = current && current.expiresAt > now ? current.expiresAt : now;
    const rec: SubscriptionRecord = {
      userId,
      plan,
      expiresAt: base + days * 86_400_000,
      source,
      updatedAt: now,
      remindedAt: null,
    };
    this.subscriptions.set(userId, rec);
    return rec;
  }

  async revokeSubscription(userId: number): Promise<void> {
    const current = this.subscriptions.get(userId);
    if (current) this.subscriptions.set(userId, { ...current, expiresAt: Date.now() });
  }

  async markReminded(userId: number): Promise<void> {
    const current = this.subscriptions.get(userId);
    if (current) this.subscriptions.set(userId, { ...current, remindedAt: Date.now() });
  }

  async listSubscriptionsExpiring(from: number, to: number): Promise<SubscriptionRecord[]> {
    return [...this.subscriptions.values()].filter((s) => s.expiresAt >= from && s.expiresAt <= to);
  }

  async countActiveSubscriptions(): Promise<number> {
    const now = Date.now();
    return [...this.subscriptions.values()].filter((s) => s.expiresAt > now).length;
  }

  async createPayment(record: PaymentRecord): Promise<void> {
    this.payments.set(record.id, record);
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    return this.payments.get(id) ?? null;
  }

  async updatePayment(record: PaymentRecord): Promise<void> {
    this.payments.set(record.id, record);
  }

  async listPendingPayments(userId?: number): Promise<PaymentRecord[]> {
    return [...this.payments.values()]
      .filter((p) => p.status === 'pending' && (userId === undefined || p.userId === userId))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async listVerifiedSymbols(): Promise<VerifiedSymbolRecord[]> {
    return [...this.verified.values()];
  }

  async getConfig(key: string): Promise<string | null> {
    return this.config.get(key) ?? null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    this.config.set(key, value);
  }

  async countPaidPayments(userId: number): Promise<number> {
    return [...this.payments.values()].filter((p) => p.userId === userId && p.status === 'paid')
      .length;
  }

  // ---------------------------------------------------------------- партнёры

  async createPartner(p: Omit<PartnerRecord, 'id' | 'createdAt' | 'pausedAt'>): Promise<PartnerRecord> {
    const rec: PartnerRecord = { ...p, id: this.seq++, pausedAt: null, createdAt: Date.now() };
    this.partners.set(rec.id, rec);
    return rec;
  }

  async updatePartner(p: PartnerRecord): Promise<void> {
    this.partners.set(p.id, { ...p });
  }

  async getPartner(id: number): Promise<PartnerRecord | null> {
    return this.partners.get(id) ?? null;
  }

  async getPartnerByCode(code: string): Promise<PartnerRecord | null> {
    return [...this.partners.values()].find((p) => p.code === code) ?? null;
  }

  async getPartnerByTelegramId(telegramId: number): Promise<PartnerRecord | null> {
    return [...this.partners.values()].find((p) => p.telegramId === telegramId) ?? null;
  }

  async listPartners(): Promise<PartnerRecord[]> {
    return [...this.partners.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async getReferral(userId: number): Promise<ReferralRecord | null> {
    return this.referrals.get(userId) ?? null;
  }

  async createReferral(r: ReferralRecord): Promise<boolean> {
    if (this.referrals.has(r.userId)) return false;
    this.referrals.set(r.userId, { ...r });
    return true;
  }

  async updateReferral(r: ReferralRecord): Promise<void> {
    this.referrals.set(r.userId, { ...r });
  }

  async createEarning(e: Omit<EarningRecord, 'id'>): Promise<EarningRecord> {
    const rec: EarningRecord = { ...e, id: this.seq++ };
    this.earnings.set(rec.id, rec);
    return rec;
  }

  async getEarningByPayment(paymentId: string): Promise<EarningRecord | null> {
    return [...this.earnings.values()].find((e) => e.paymentId === paymentId) ?? null;
  }

  async listEarnings(partnerId: number, status?: EarningStatus): Promise<EarningRecord[]> {
    return [...this.earnings.values()]
      .filter((e) => e.partnerId === partnerId && (status === undefined || e.status === status))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async sumMonthsRewarded(partnerId: number, userId: number): Promise<number> {
    let n = 0;
    for (const e of this.earnings.values())
      if (e.partnerId === partnerId && e.userId === userId) n += e.monthsRewarded;
    return n;
  }

  async releaseEarnings(now: number): Promise<number> {
    let n = 0;
    for (const e of this.earnings.values()) {
      if (e.status === 'on_hold' && e.availableAt <= now) {
        e.status = 'available';
        n++;
      }
    }
    return n;
  }

  async createPayout(partnerId: number, reference: string | null): Promise<PayoutRecord | null> {
    const list = [...this.earnings.values()].filter(
      (e) => e.partnerId === partnerId && e.status === 'available',
    );
    if (list.length === 0) return null;
    const payout: PayoutRecord = {
      id: this.seq++,
      partnerId,
      amount: Math.round(list.reduce((s, e) => s + e.amount, 0) * 100) / 100,
      paidAt: Date.now(),
      reference,
    };
    for (const e of list) {
      e.status = 'paid';
      e.paidAt = payout.paidAt;
      e.payoutId = payout.id;
    }
    this.payouts.set(payout.id, payout);
    return payout;
  }

  async listPayouts(partnerId: number): Promise<PayoutRecord[]> {
    return [...this.payouts.values()]
      .filter((p) => p.partnerId === partnerId)
      .sort((a, b) => a.paidAt - b.paidAt);
  }

  async partnerStats(partnerId: number): Promise<PartnerStats> {
    const since = Date.now() - 30 * 86_400_000;
    const refs = [...this.referrals.values()].filter((r) => r.partnerId === partnerId);
    const sum = (status: EarningStatus) =>
      Math.round(
        [...this.earnings.values()]
          .filter((e) => e.partnerId === partnerId && e.status === status)
          .reduce((s, e) => s + e.amount, 0) * 100,
      ) / 100;
    return {
      clicks: refs.length,
      trials: refs.filter((r) => this.users.get(r.userId)?.trialUsedAt != null).length,
      paidUsers: refs.filter((r) => r.convertedAt !== null).length,
      onHold: sum('on_hold'),
      available: sum('available'),
      paid: sum('paid'),
      clicks30d: refs.filter((r) => r.clickedAt >= since).length,
      paidUsers30d: refs.filter((r) => r.convertedAt !== null && r.convertedAt >= since).length,
    };
  }

  async listVerifiedPairs(): Promise<VerifiedPairRecord[]> {
    return [...this.pairs.values()];
  }

  async listInstrumentNominals(): Promise<InstrumentNominalRecord[]> {
    return [...this.nominals.values()];
  }

  async upsertInstrumentNominal(rec: InstrumentNominalRecord): Promise<void> {
    this.nominals.set(`${rec.exchange}:${rec.symbol}`, rec);
  }

  async upsertVerifiedPairs(rows: VerifiedPairRecord[]): Promise<void> {
    for (const r of rows) this.pairs.set(`${r.exchangeA}:${r.symbolA}|${r.exchangeB}:${r.symbolB}`, r);
  }

  async listAlertRules(userId?: number): Promise<AlertRuleRecord[]> {
    return [...this.alerts.values()].filter((r) => userId === undefined || r.userId === userId);
  }

  async createAlertRule(rule: AlertRuleRecord): Promise<void> {
    this.alerts.set(rule.id, rule);
  }

  async deleteAlertRule(userId: number, id: string): Promise<boolean> {
    const r = this.alerts.get(id);
    if (!r || r.userId !== userId) return false;
    this.alerts.delete(id);
    return true;
  }

  async updateAlertRule(
    userId: number,
    id: string,
    thresholdPct: number,
  ): Promise<AlertRuleRecord | null> {
    const r = this.alerts.get(id);
    if (!r || r.userId !== userId) return null;
    const next = { ...r, thresholdPct, isArmed: true };
    this.alerts.set(id, next);
    return next;
  }

  async updateAlertState(
    id: string,
    isArmed: boolean,
    lastFiredAt: number | null,
    lastBase: string | null,
  ): Promise<void> {
    const r = this.alerts.get(id);
    if (r) this.alerts.set(id, { ...r, isArmed, lastFiredAt, lastBase });
  }

  async close(): Promise<void> {}
}
