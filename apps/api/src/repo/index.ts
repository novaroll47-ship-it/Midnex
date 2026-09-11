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
  ExchangeKeyRecord,
  KeyStatus,
  PositionRecord,
  SessionRecord,
  UserRecord,
  UserSettings,
} from './types.js';

export async function createRepo(log: FastifyBaseLogger): Promise<Repo> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    log.warn('хранилище: DATABASE_URL не задан — данные живут в памяти и пропадут при перезапуске');
    return new MemoryRepo();
  }

  const pg = new PostgresRepo(url);
  try {
    await pg.ping();
    log.info('хранилище: Postgres подключён');
    return pg;
  } catch (err) {
    log.error(
      { err: String(err) },
      'хранилище: Postgres недоступен, работаю из памяти — ДАННЫЕ НЕ СОХРАНЯЮТСЯ',
    );
    await pg.close().catch(() => {});
    return new MemoryRepo();
  }
}
