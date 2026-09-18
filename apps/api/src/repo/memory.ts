/**
 * Хранилище в памяти процесса.
 *
 * Используется, когда DATABASE_URL не задан: локальная разработка без базы
 * и страховка на случай, если база недоступна при старте. Всё пропадает
 * с перезапуском — это осознанно, в проде оно не используется.
 */
import { randomUUID } from 'node:crypto';
import type { ExchangeId, PlanId } from '@cs/shared';

import type {
  AlertRuleRecord,
  PaymentRecord,
  SubscriptionRecord,
  VerifiedSymbolRecord,
  VerifiedPairRecord,
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
  private watchlists = new Map<number, string[]>();
  private keys = new Map<number, Map<ExchangeId, ExchangeKeyRecord>>();
  private sessions = new Map<number, Map<string, SessionRecord>>();
  private subscriptions = new Map<number, SubscriptionRecord>();
  private payments = new Map<string, PaymentRecord>();
  private verified = new Map<string, VerifiedSymbolRecord>();
  private pairs = new Map<string, VerifiedPairRecord>();
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

  async getWatchlist(userId: number): Promise<string[]> {
    return [...(this.watchlists.get(userId) ?? [])];
  }

  async setWatchlist(userId: number, bases: string[]): Promise<void> {
    this.watchlists.set(userId, [...new Set(bases)]);
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

  async listVerifiedPairs(): Promise<VerifiedPairRecord[]> {
    return [...this.pairs.values()];
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
