/**
 * Хранилище в Postgres (Supabase).
 *
 * Схема — apps/api/migrations. Соединение через пулер Supabase в режиме
 * transaction, поэтому prepared statements отключены: пулер их не держит
 * между соединениями.
 */
import postgres, { type Sql } from 'postgres';
import type { ExchangeId, PlanId } from '@cs/shared';

import type {
  ExchangeKeyRecord,
  KeyStatus,
  PositionRecord,
  Repo,
  SessionRecord,
  UserRecord,
  UserSettings,
} from './types.js';

const ts = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const tsOrNull = (v: unknown): number | null => (v == null ? null : ts(v));

export class PostgresRepo implements Repo {
  readonly kind = 'postgres' as const;
  private readonly sql: Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      prepare: false,
      max: 5,
      idle_timeout: 30,
      connect_timeout: 15,
      // Supabase требует TLS; сертификат у них валидный.
      ssl: 'require',
    });
  }

  /** Проверка соединения при старте — чтобы упасть сразу, а не на первом запросе. */
  async ping(): Promise<void> {
    await this.sql`select 1`;
  }

  // ---------------------------------------------------------------- users

  async upsertUser(u: {
    id: number;
    username?: string;
    firstName: string;
    language?: string;
  }): Promise<UserRecord> {
    const rows = await this.sql`
      insert into users (id, username, first_name, language)
      values (${u.id}, ${u.username ?? null}, ${u.firstName}, ${u.language ?? 'ru'})
      on conflict (id) do update
        set username = coalesce(excluded.username, users.username),
            first_name = excluded.first_name,
            last_seen_at = now()
      returning id, username, first_name, language, plan, created_at, last_seen_at
    `;
    const r = rows[0]!;
    return {
      id: Number(r['id']),
      username: (r['username'] as string | null) ?? null,
      firstName: r['first_name'] as string,
      language: r['language'] as string,
      plan: r['plan'] as PlanId,
      createdAt: ts(r['created_at']),
      lastSeenAt: ts(r['last_seen_at']),
    };
  }

  async setPlan(userId: number, plan: PlanId): Promise<void> {
    await this.sql`update users set plan = ${plan} where id = ${userId}`;
  }

  // ---------------------------------------------------------------- settings

  async getSettings(userId: number): Promise<UserSettings | null> {
    const rows = await this.sql`
      select bot, risk, notifications from user_settings where user_id = ${userId}
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      bot: r['bot'] as UserSettings['bot'],
      risk: r['risk'] as UserSettings['risk'],
      notifications: r['notifications'] as UserSettings['notifications'],
    };
  }

  async saveSettings(userId: number, s: UserSettings): Promise<void> {
    await this.sql`
      insert into user_settings (user_id, bot, risk, notifications)
      values (${userId}, ${this.sql.json(s.bot as never)}, ${this.sql.json(s.risk as never)},
              ${this.sql.json(s.notifications as never)})
      on conflict (user_id) do update
        set bot = excluded.bot, risk = excluded.risk,
            notifications = excluded.notifications, updated_at = now()
    `;
  }

  // ---------------------------------------------------------------- positions

  async listPositions(userId: number): Promise<PositionRecord[]> {
    const rows = await this.sql`
      select * from positions where user_id = ${userId} order by opened_at desc
    `;
    return rows.map((r) => ({
      id: r['id'] as string,
      userId: Number(r['user_id']),
      base: r['base'] as string,
      executionMode: r['execution_mode'] as PositionRecord['executionMode'],
      longExchange: r['long_exchange'] as ExchangeId,
      shortExchange: r['short_exchange'] as ExchangeId,
      longEntry: Number(r['long_entry']),
      shortEntry: Number(r['short_entry']),
      amount: Number(r['amount']),
      leverage: Number(r['leverage']),
      targetSpreadPct: r['target_spread'] == null ? null : Number(r['target_spread']),
      stopSpreadPct: r['stop_spread'] == null ? null : Number(r['stop_spread']),
      status: r['status'] as PositionRecord['status'],
      openedAt: ts(r['opened_at']),
      closedAt: tsOrNull(r['closed_at']),
      exitSpreadPct: r['exit_spread'] == null ? null : Number(r['exit_spread']),
      realizedPnlUsdt: r['realized_pnl'] == null ? null : Number(r['realized_pnl']),
      closeReason: (r['close_reason'] as PositionRecord['closeReason']) ?? null,
    }));
  }

  async savePosition(p: PositionRecord): Promise<void> {
    await this.sql`
      insert into positions (
        id, user_id, base, execution_mode, long_exchange, short_exchange,
        long_entry, short_entry, amount, leverage, target_spread, stop_spread,
        status, opened_at, closed_at, exit_spread, realized_pnl, close_reason
      ) values (
        ${p.id}, ${p.userId}, ${p.base}, ${p.executionMode}, ${p.longExchange}, ${p.shortExchange},
        ${p.longEntry}, ${p.shortEntry}, ${p.amount}, ${p.leverage}, ${p.targetSpreadPct}, ${p.stopSpreadPct},
        ${p.status}, ${new Date(p.openedAt)}, ${p.closedAt == null ? null : new Date(p.closedAt)},
        ${p.exitSpreadPct}, ${p.realizedPnlUsdt}, ${p.closeReason}
      )
      on conflict (id) do update set
        target_spread = excluded.target_spread, stop_spread = excluded.stop_spread,
        status = excluded.status, closed_at = excluded.closed_at,
        exit_spread = excluded.exit_spread, realized_pnl = excluded.realized_pnl,
        close_reason = excluded.close_reason
    `;
  }

  // ---------------------------------------------------------------- watchlist

  async getWatchlist(userId: number): Promise<string[]> {
    const rows = await this.sql`select base from watchlist where user_id = ${userId} order by added_at`;
    return rows.map((r) => r['base'] as string);
  }

  async setWatchlist(userId: number, bases: string[]): Promise<void> {
    const unique = [...new Set(bases)];
    await this.sql.begin(async (tx) => {
      await tx`delete from watchlist where user_id = ${userId}`;
      if (unique.length) {
        await tx`insert into watchlist ${tx(unique.map((base) => ({ user_id: userId, base })))}`;
      }
    });
  }

  // ---------------------------------------------------------------- keys

  async listKeys(userId: number): Promise<ExchangeKeyRecord[]> {
    const rows = await this.sql`select * from exchange_keys where user_id = ${userId} order by created_at`;
    return rows.map((r) => ({
      id: r['id'] as string,
      userId: Number(r['user_id']),
      exchange: r['exchange'] as ExchangeId,
      label: r['label'] as string,
      apiKeyEnc: r['api_key_enc'] as string,
      secretEnc: r['secret_enc'] as string,
      passphraseEnc: (r['passphrase_enc'] as string | null) ?? null,
      keyHint: r['key_hint'] as string,
      withdrawalDisabled: (r['withdrawal_disabled'] as boolean | null) ?? null,
      permissionsVerified: Boolean(r['permissions_verified']),
      status: r['status'] as KeyStatus,
      lastError: (r['last_error'] as string | null) ?? null,
      createdAt: ts(r['created_at']),
      lastCheckedAt: tsOrNull(r['last_checked_at']),
    }));
  }

  async upsertKey(k: ExchangeKeyRecord): Promise<void> {
    await this.sql`
      insert into exchange_keys (
        id, user_id, exchange, label, api_key_enc, secret_enc, passphrase_enc, key_hint,
        withdrawal_disabled, permissions_verified, status, last_error, last_checked_at
      ) values (
        ${k.id}, ${k.userId}, ${k.exchange}, ${k.label}, ${k.apiKeyEnc}, ${k.secretEnc},
        ${k.passphraseEnc}, ${k.keyHint}, ${k.withdrawalDisabled}, ${k.permissionsVerified},
        ${k.status}, ${k.lastError}, ${k.lastCheckedAt == null ? null : new Date(k.lastCheckedAt)}
      )
      on conflict (user_id, exchange) do update set
        label = excluded.label, api_key_enc = excluded.api_key_enc,
        secret_enc = excluded.secret_enc, passphrase_enc = excluded.passphrase_enc,
        key_hint = excluded.key_hint, withdrawal_disabled = excluded.withdrawal_disabled,
        permissions_verified = excluded.permissions_verified, status = excluded.status,
        last_error = excluded.last_error, last_checked_at = excluded.last_checked_at
    `;
  }

  async deleteKey(userId: number, exchange: ExchangeId): Promise<void> {
    await this.sql`delete from exchange_keys where user_id = ${userId} and exchange = ${exchange}`;
  }

  // ---------------------------------------------------------------- sessions

  async touchSession(userId: number, platform: string, tgVersion: string): Promise<void> {
    await this.sql`
      insert into sessions (user_id, platform, tg_version)
      values (${userId}, ${platform}, ${tgVersion})
      on conflict (user_id, platform, tg_version) do update set last_seen_at = now()
    `;
  }

  async listSessions(userId: number): Promise<SessionRecord[]> {
    const rows = await this.sql`
      select * from sessions where user_id = ${userId} order by last_seen_at desc
    `;
    return rows.map((r) => ({
      id: r['id'] as string,
      userId: Number(r['user_id']),
      platform: r['platform'] as string,
      tgVersion: r['tg_version'] as string,
      firstSeenAt: ts(r['first_seen_at']),
      lastSeenAt: ts(r['last_seen_at']),
    }));
  }

  async deleteOtherSessions(userId: number, platform: string, tgVersion: string): Promise<number> {
    const rows = await this.sql`
      delete from sessions
      where user_id = ${userId} and not (platform = ${platform} and tg_version = ${tgVersion})
      returning id
    `;
    return rows.length;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
