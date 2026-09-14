/**
 * Интерфейс хранилища.
 *
 * Две реализации: память (без базы, для разработки и как страховка) и
 * Postgres (Supabase). Код выше этого слоя не знает, где лежат данные,
 * поэтому включение базы — это одна переменная окружения, а не правки.
 */
import type {
  BillingMonths,
  BotSettings,
  ExchangeId,
  NotificationSettings,
  PaymentMethod,
  PaymentStatus,
  PlanId,
  RiskSettings,
} from '@cs/shared';

export interface UserRecord {
  id: number;
  username: string | null;
  firstName: string;
  language: string;
  plan: PlanId;
  createdAt: number;
  lastSeenAt: number;
}

export interface UserSettings {
  bot: BotSettings;
  risk: RiskSettings;
  notifications: NotificationSettings;
}

export interface PositionRecord {
  id: string;
  userId: number;
  base: string;
  executionMode: 'paper' | 'testnet' | 'live';
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  longEntry: number;
  shortEntry: number;
  amount: number;
  leverage: number;
  targetSpreadPct: number | null;
  stopSpreadPct: number | null;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  exitSpreadPct: number | null;
  realizedPnlUsdt: number | null;
  closeReason: 'manual' | 'target' | 'risk' | 'timeout' | null;
}

export type KeyStatus = 'unverified' | 'ok' | 'invalid' | 'withdrawal_enabled';

/** Ключ биржи так, как он хранится: секреты только зашифрованные. */
export interface ExchangeKeyRecord {
  id: string;
  userId: number;
  exchange: ExchangeId;
  label: string;
  apiKeyEnc: string;
  secretEnc: string;
  passphraseEnc: string | null;
  keyHint: string;
  withdrawalDisabled: boolean | null;
  permissionsVerified: boolean;
  status: KeyStatus;
  lastError: string | null;
  createdAt: number;
  lastCheckedAt: number | null;
}

export interface SessionRecord {
  id: string;
  userId: number;
  platform: string;
  tgVersion: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Подписка: один тариф на пользователя, срок продлевается покупками. */
export interface SubscriptionRecord {
  userId: number;
  plan: PlanId;
  expiresAt: number;
  /** Откуда последнее продление: stars | crypto | manual. */
  source: string;
  updatedAt: number;
  /** Когда последний раз напоминали об окончании, чтобы не спамить. */
  remindedAt: number | null;
}

/** Заявка на оплату. Для звёзд закрывается автоматически, для крипты — админом. */
export interface PaymentRecord {
  id: string;
  userId: number;
  plan: PlanId;
  months: BillingMonths;
  method: PaymentMethod;
  amount: number;
  currency: 'XTR' | 'USDT';
  status: PaymentStatus;
  network: string | null;
  txHash: string | null;
  telegramChargeId: string | null;
  note: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface Repo {
  readonly kind: 'memory' | 'postgres';

  upsertUser(user: {
    id: number;
    username?: string;
    firstName: string;
    language?: string;
  }): Promise<UserRecord>;
  setPlan(userId: number, plan: PlanId): Promise<void>;

  getSettings(userId: number): Promise<UserSettings | null>;
  saveSettings(userId: number, settings: UserSettings): Promise<void>;

  listPositions(userId: number): Promise<PositionRecord[]>;
  savePosition(record: PositionRecord): Promise<void>;

  getWatchlist(userId: number): Promise<string[]>;
  setWatchlist(userId: number, bases: string[]): Promise<void>;

  listKeys(userId: number): Promise<ExchangeKeyRecord[]>;
  upsertKey(record: ExchangeKeyRecord): Promise<void>;
  deleteKey(userId: number, exchange: ExchangeId): Promise<void>;

  touchSession(userId: number, platform: string, tgVersion: string): Promise<void>;
  listSessions(userId: number): Promise<SessionRecord[]>;
  deleteOtherSessions(userId: number, platform: string, tgVersion: string): Promise<number>;

  getUser(userId: number): Promise<UserRecord | null>;
  findUserByUsername(username: string): Promise<UserRecord | null>;
  countUsers(): Promise<number>;

  getSubscription(userId: number): Promise<SubscriptionRecord | null>;
  /** Продлить от текущего конца (если он в будущем) или от сейчас; вернуть новую запись. */
  extendSubscription(
    userId: number,
    plan: PlanId,
    days: number,
    source: string,
  ): Promise<SubscriptionRecord>;
  revokeSubscription(userId: number): Promise<void>;
  markReminded(userId: number): Promise<void>;
  /** Подписки, истекающие в окне [from, to]. */
  listSubscriptionsExpiring(from: number, to: number): Promise<SubscriptionRecord[]>;
  countActiveSubscriptions(): Promise<number>;

  createPayment(record: PaymentRecord): Promise<void>;
  getPayment(id: string): Promise<PaymentRecord | null>;
  updatePayment(record: PaymentRecord): Promise<void>;
  listPendingPayments(userId?: number): Promise<PaymentRecord[]>;

  close(): Promise<void>;
}
