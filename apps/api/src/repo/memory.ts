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

  async upsertUser(u: {
    id: number;
    username?: string;
    firstName: string;
    language?: string;
  }): Promise<UserRecord> {
    const now = Date.now();
    const existing = this.users.get(u.id);
    const record: UserRecord = existing
      ? { ...existing, username: u.username ?? existing.username, firstName: u.firstName, lastSeenAt: now }
      : {
          id: u.id,
          username: u.username ?? null,
          firstName: u.firstName,
          language: u.language ?? 'ru',
          plan: 'unlimited',
          createdAt: now,
          lastSeenAt: now,
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

  async close(): Promise<void> {}
}
