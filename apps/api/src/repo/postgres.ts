/**
 * Хранилище в Postgres (Supabase).
 *
 * Схема — apps/api/migrations. Соединение через пулер Supabase в режиме
 * transaction, поэтому prepared statements отключены: пулер их не держит
 * между соединениями.
 */
import postgres, { type Sql } from 'postgres';
import type { BillingMonths, ExchangeId, PaymentMethod, PaymentStatus, PlanId } from '@cs/shared';

import type {
  AlertRuleRecord,
  ExchangeKeyRecord,
  KeyStatus,
  PaymentRecord,
  PositionRecord,
  SubscriptionRecord,
  Repo,
  SessionRecord,
  UserRecord,
  UserSettings,
  VerifiedSymbolRecord,
  VerifiedPairRecord,
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
      returning id, username, first_name, language, plan, created_at, last_seen_at, trial_used_at
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
      trialUsedAt: tsOrNull(r['trial_used_at']),
    };
  }

  async setPlan(userId: number, plan: PlanId): Promise<void> {
    await this.sql`update users set plan = ${plan} where id = ${userId}`;
  }

  // ---------------------------------------------------------------- settings

  async getSettings(userId: number): Promise<UserSettings | null> {
    const rows = await this.sql`
      select bot, risk, notifications, onboarding from user_settings where user_id = ${userId}
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      bot: r['bot'] as UserSettings['bot'],
      risk: r['risk'] as UserSettings['risk'],
      notifications: r['notifications'] as UserSettings['notifications'],
      onboarding: (r['onboarding'] as UserSettings['onboarding'] | null) ?? { completed: [] },
    };
  }

  async saveSettings(userId: number, s: UserSettings): Promise<void> {
    await this.sql`
      insert into user_settings (user_id, bot, risk, notifications, onboarding)
      values (${userId}, ${this.sql.json(s.bot as never)}, ${this.sql.json(s.risk as never)},
              ${this.sql.json(s.notifications as never)}, ${this.sql.json(s.onboarding as never)})
      on conflict (user_id) do update
        set bot = excluded.bot, risk = excluded.risk,
            notifications = excluded.notifications, onboarding = excluded.onboarding, updated_at = now()
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
    const rows = await this
      .sql`select base from watchlist where user_id = ${userId} order by added_at`;
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
    const rows = await this
      .sql`select * from exchange_keys where user_id = ${userId} order by created_at`;
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

  // ---------------------------------------------------------------- users (поиск)

  private userFromRow(r: Record<string, unknown>): UserRecord {
    return {
      id: Number(r['id']),
      username: (r['username'] as string | null) ?? null,
      firstName: r['first_name'] as string,
      language: r['language'] as string,
      plan: r['plan'] as PlanId,
      createdAt: ts(r['created_at']),
      lastSeenAt: ts(r['last_seen_at']),
      trialUsedAt: tsOrNull(r['trial_used_at']),
    };
  }

  async getUser(userId: number): Promise<UserRecord | null> {
    const rows = await this.sql`select * from users where id = ${userId}`;
    return rows[0] ? this.userFromRow(rows[0]) : null;
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const wanted = username.replace(/^@/, '');
    const rows = await this
      .sql`select * from users where lower(username) = lower(${wanted}) limit 1`;
    return rows[0] ? this.userFromRow(rows[0]) : null;
  }

  async markTrialUsed(userId: number): Promise<void> {
    await this
      .sql`update users set trial_used_at = now() where id = ${userId} and trial_used_at is null`;
  }

  async countUsers(): Promise<number> {
    const rows = await this.sql`select count(*)::int as n from users`;
    return Number(rows[0]?.['n'] ?? 0);
  }

  // ---------------------------------------------------------------- subscriptions

  private subFromRow(r: Record<string, unknown>): SubscriptionRecord {
    return {
      userId: Number(r['user_id']),
      plan: r['plan'] as PlanId,
      expiresAt: ts(r['expires_at']),
      source: r['source'] as string,
      updatedAt: ts(r['updated_at']),
      remindedAt: tsOrNull(r['reminded_at']),
    };
  }

  async getSubscription(userId: number): Promise<SubscriptionRecord | null> {
    const rows = await this.sql`select * from subscriptions where user_id = ${userId}`;
    return rows[0] ? this.subFromRow(rows[0]) : null;
  }

  async extendSubscription(
    userId: number,
    plan: PlanId,
    days: number,
    source: string,
  ): Promise<SubscriptionRecord> {
    // Продление от текущего конца, если подписка ещё жива, иначе от сейчас.
    const rows = await this.sql`
      insert into subscriptions (user_id, plan, expires_at, source)
      values (${userId}, ${plan}, now() + make_interval(days => ${days}), ${source})
      on conflict (user_id) do update set
        plan = excluded.plan,
        expires_at = greatest(subscriptions.expires_at, now()) + make_interval(days => ${days}),
        source = excluded.source,
        updated_at = now(),
        reminded_at = null
      returning *
    `;
    return this.subFromRow(rows[0]!);
  }

  async revokeSubscription(userId: number): Promise<void> {
    await this
      .sql`update subscriptions set expires_at = now(), updated_at = now() where user_id = ${userId}`;
  }

  async markReminded(userId: number): Promise<void> {
    await this.sql`update subscriptions set reminded_at = now() where user_id = ${userId}`;
  }

  async listSubscriptionsExpiring(from: number, to: number): Promise<SubscriptionRecord[]> {
    const rows = await this.sql`
      select * from subscriptions
      where expires_at >= ${new Date(from)} and expires_at <= ${new Date(to)}
    `;
    return rows.map((r) => this.subFromRow(r));
  }

  async countActiveSubscriptions(): Promise<number> {
    const rows = await this
      .sql`select count(*)::int as n from subscriptions where expires_at > now()`;
    return Number(rows[0]?.['n'] ?? 0);
  }

  // ---------------------------------------------------------------- payments

  private paymentFromRow(r: Record<string, unknown>): PaymentRecord {
    return {
      id: r['id'] as string,
      userId: Number(r['user_id']),
      plan: r['plan'] as PlanId,
      months: Number(r['months']) as BillingMonths,
      method: r['method'] as PaymentMethod,
      amount: Number(r['amount']),
      currency: r['currency'] as 'XTR' | 'USDT',
      status: r['status'] as PaymentStatus,
      network: (r['network'] as string | null) ?? null,
      txHash: (r['tx_hash'] as string | null) ?? null,
      telegramChargeId: (r['telegram_charge_id'] as string | null) ?? null,
      note: (r['note'] as string | null) ?? null,
      createdAt: ts(r['created_at']),
      resolvedAt: tsOrNull(r['resolved_at']),
    };
  }

  async createPayment(p: PaymentRecord): Promise<void> {
    await this.sql`
      insert into payments (id, user_id, plan, months, method, amount, currency, status, network, tx_hash, telegram_charge_id, note)
      values (${p.id}, ${p.userId}, ${p.plan}, ${p.months}, ${p.method}, ${p.amount}, ${p.currency}, ${p.status},
              ${p.network}, ${p.txHash}, ${p.telegramChargeId}, ${p.note})
    `;
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const rows = await this.sql`select * from payments where id = ${id}`;
    return rows[0] ? this.paymentFromRow(rows[0]) : null;
  }

  async updatePayment(p: PaymentRecord): Promise<void> {
    await this.sql`
      update payments set status = ${p.status}, tx_hash = ${p.txHash}, network = ${p.network},
        telegram_charge_id = ${p.telegramChargeId}, note = ${p.note},
        resolved_at = ${p.resolvedAt == null ? null : new Date(p.resolvedAt)}
      where id = ${p.id}
    `;
  }

  async listPendingPayments(userId?: number): Promise<PaymentRecord[]> {
    const rows =
      userId === undefined
        ? await this.sql`select * from payments where status = 'pending' order by created_at`
        : await this
            .sql`select * from payments where status = 'pending' and user_id = ${userId} order by created_at`;
    return rows.map((r) => this.paymentFromRow(r));
  }

  // ---------------------------------------------------------------- сверка ног

  async listVerifiedSymbols(): Promise<VerifiedSymbolRecord[]> {
    const rows = await this.sql`select * from verified_symbols`;
    return rows.map((r) => ({
      base: r['base'] as string,
      exchange: r['exchange'] as ExchangeId,
      symbol: r['symbol'] as string,
      multiplier: Number(r['multiplier']),
      status: r['status'] as VerifiedSymbolRecord['status'],
      note: (r['note'] as string | null) ?? null,
      updatedAt: ts(r['updated_at']),
      updatedBy: (r['updated_by'] as string | null) ?? null,
      verifiedAt: tsOrNull(r['verified_at']),
    }));
  }

  async listVerifiedPairs(): Promise<VerifiedPairRecord[]> {
    const rows = await this.sql`select * from verified_pairs`;
    return rows.map((r) => ({
      base: r['base'] as string,
      exchangeA: r['exchange_a'] as ExchangeId,
      symbolA: r['symbol_a'] as string,
      exchangeB: r['exchange_b'] as ExchangeId,
      symbolB: r['symbol_b'] as string,
      multiplier: Number(r['multiplier']),
      status: r['status'] as VerifiedPairRecord['status'],
      verificationSource: (r['verification_source'] as VerifiedPairRecord['verificationSource']) ?? null,
      ratio: r['ratio'] == null ? null : Number(r['ratio']),
      externalA: (r['external_a'] as string | null) ?? null,
      externalB: (r['external_b'] as string | null) ?? null,
      note: (r['note'] as string | null) ?? null,
      updatedAt: ts(r['updated_at']),
      updatedBy: (r['updated_by'] as string | null) ?? null,
      verifiedAt: tsOrNull(r['verified_at']),
    }));
  }

  async upsertVerifiedPairs(rows: VerifiedPairRecord[]): Promise<void> {
    // Пачками по 200: у первой загрузки десятки тысяч пар.
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((r) => ({
        base: r.base,
        exchange_a: r.exchangeA,
        symbol_a: r.symbolA,
        exchange_b: r.exchangeB,
        symbol_b: r.symbolB,
        multiplier: r.multiplier,
        status: r.status,
        verification_source: r.verificationSource,
        ratio: r.ratio,
        external_a: r.externalA,
        external_b: r.externalB,
        note: r.note,
        updated_at: new Date(r.updatedAt),
        updated_by: r.updatedBy,
        verified_at: r.verifiedAt == null ? null : new Date(r.verifiedAt),
      }));
      await this.sql`
        insert into verified_pairs ${this.sql(chunk)}
        on conflict (exchange_a, symbol_a, exchange_b, symbol_b) do update set
          base = excluded.base, multiplier = excluded.multiplier, status = excluded.status,
          verification_source = excluded.verification_source, ratio = excluded.ratio,
          external_a = excluded.external_a, external_b = excluded.external_b,
          note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
          verified_at = excluded.verified_at
      `;
    }
  }

  // ---------------------------------------------------------------- алерты

  private alertFromRow(r: Record<string, unknown>): AlertRuleRecord {
    return {
      id: r['id'] as string,
      userId: Number(r['user_id']),
      type: r['type'] as AlertRuleRecord['type'],
      base: (r['base'] as string | null) ?? null,
      thresholdPct: Number(r['threshold_pct']),
      isArmed: Boolean(r['is_armed']),
      lastFiredAt: tsOrNull(r['last_fired_at']),
      lastBase: (r['last_base'] as string | null) ?? null,
      createdAt: ts(r['created_at']),
    };
  }

  async listAlertRules(userId?: number): Promise<AlertRuleRecord[]> {
    const rows =
      userId === undefined
        ? await this.sql`select * from user_alert_rules order by created_at`
        : await this
            .sql`select * from user_alert_rules where user_id = ${userId} order by created_at`;
    return rows.map((r) => this.alertFromRow(r));
  }

  async createAlertRule(rule: AlertRuleRecord): Promise<void> {
    await this.sql`
      insert into user_alert_rules (id, user_id, type, base, threshold_pct, is_armed, created_at)
      values (${rule.id}, ${rule.userId}, ${rule.type}, ${rule.base}, ${rule.thresholdPct}, ${rule.isArmed}, ${new Date(rule.createdAt)})
    `;
  }

  async deleteAlertRule(userId: number, id: string): Promise<boolean> {
    const rows = await this
      .sql`delete from user_alert_rules where id = ${id} and user_id = ${userId} returning id`;
    return rows.length > 0;
  }

  async updateAlertRule(
    userId: number,
    id: string,
    thresholdPct: number,
  ): Promise<AlertRuleRecord | null> {
    const rows = await this.sql`
      update user_alert_rules set threshold_pct = ${thresholdPct}, is_armed = true
      where id = ${id} and user_id = ${userId} returning *
    `;
    return rows[0] ? this.alertFromRow(rows[0]) : null;
  }

  async updateAlertState(
    id: string,
    isArmed: boolean,
    lastFiredAt: number | null,
    lastBase: string | null,
  ): Promise<void> {
    await this.sql`
      update user_alert_rules set is_armed = ${isArmed},
        last_fired_at = ${lastFiredAt == null ? null : new Date(lastFiredAt)}, last_base = ${lastBase}
      where id = ${id}
    `;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
