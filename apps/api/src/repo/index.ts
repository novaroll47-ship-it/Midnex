/**
 * Выбор хранилища по окружению.
 *
 * DATABASE_URL задан — Postgres; при старте проверяем соединение и при
 * ошибке падаем на память с громким предупреждением: тихая потеря данных
 * хуже честного «база недоступна».
 */
import type { FastifyBaseLogger } from 'fastify';

import { MemoryRepo } from './memory.js';
import { PostgresRepo } from './postgres.js';
import type { Repo } from './types.js';

export type { Repo } from './types.js';
export type {
  AlertRuleRecord,
  ExchangeKeyRecord,
  KeyStatus,
  PaymentRecord,
  PositionRecord,
  SessionRecord,
  SubscriptionRecord,
  UserRecord,
  UserSettings,
  VerifiedSymbolRecord,
  VerifiedPairRecord,
  PairStatus,
  PairCategory,
  InstrumentNominalRecord,
  VerificationSource,
  PartnerRecord,
  PartnerStats,
  PartnerTerms,
  PartnerStatus,
  ReferralRecord,
  EarningRecord,
  EarningStatus,
  PayoutRecord,
} from './types.js';

export async function createRepo(log: FastifyBaseLogger): Promise<Repo> {
  const url = process.env.DATABASE_URL?.trim();
  // DATABASE_URL=memory — явно без базы (dev-экземпляр не должен трогать прод-данные).
  if (!url || url === 'memory') {
    log.warn('хранилище: DATABASE_URL не задан — данные живут в памяти и пропадут при перезапуске');
    return new MemoryRepo();
  }

  const pg = new PostgresRepo(url);
  // База может быть недоступна секунды после перезагрузки сервера — пробуем
  // несколько раз, прежде чем сдаться.
  const attempts = 5;
  for (let i = 1; i <= attempts; i++) {
    try {
      await pg.ping();
      log.info('хранилище: Postgres подключён');
      return pg;
    } catch (err) {
      log.error({ err: String(err), attempt: i }, 'хранилище: Postgres недоступен');
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
  await pg.close().catch(() => {});
  // В проде тихо уйти в память нельзя: оплаты и настройки исчезли бы при
  // перезапуске. Падаем — Docker/systemd перезапустят, когда база вернётся.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Postgres недоступен, DATABASE_URL задан — в проде без базы не работаем');
  }
  log.error('хранилище: работаю из памяти — ДАННЫЕ НЕ СОХРАНЯЮТСЯ');
  return new MemoryRepo();
}
