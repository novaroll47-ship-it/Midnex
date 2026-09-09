/**
 * Прокси логотипов монет.
 *
 * Логотипы лежат на стороннем CDN, но браузер ходит за ними к нам, а не туда.
 * Причины две. Первая: если у пользователя режут чужой CDN — а мы этот
 * сценарий уже ловили с туннелем, — иконки всё равно загрузятся, потому что
 * скачивает их сервер. Вторая: один раз скачали, дальше отдаём из памяти,
 * и список из сотен монет не устраивает CDN шквал запросов.
 */
import type { FastifyBaseLogger } from 'fastify';

const SOURCE = (base: string) => `https://assets.coincap.io/assets/icons/${base}@2x.png`;

interface CachedIcon {
  body: Buffer;
  contentType: string;
}

const cache = new Map<string, CachedIcon>();
/** Тикеры, которых на CDN нет: чтобы не ходить за ними снова и снова. */
const missing = new Set<string>();
/** Незавершённые загрузки: десять строк списка не должны дать десять запросов. */
const inFlight = new Map<string, Promise<CachedIcon | null>>();

const MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 6000;

async function download(base: string, log: FastifyBaseLogger): Promise<CachedIcon | null> {
  try {
    const res = await fetch(SOURCE(base), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      missing.add(base);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) {
      log.warn({ base, bytes: buf.byteLength }, 'иконка: слишком большая, пропускаю');
      missing.add(base);
      return null;
    }

    const icon: CachedIcon = {
      body: buf,
      contentType: res.headers.get('content-type') ?? 'image/png',
    };
    cache.set(base, icon);
    return icon;
  } catch (err) {
    // Сеть отвалилась — не запоминаем как «нет иконки», попробуем позже.
    log.warn({ base, err: String(err) }, 'иконка: не скачалась');
    return null;
  }
}

export async function coinIcon(
  rawBase: string,
  log: FastifyBaseLogger,
): Promise<CachedIcon | null> {
  const base = rawBase.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!base || base.length > 16) return null;

  const cached = cache.get(base);
  if (cached) return cached;
  if (missing.has(base)) return null;

  const pending = inFlight.get(base);
  if (pending) return pending;

  const task = download(base, log).finally(() => inFlight.delete(base));
  inFlight.set(base, task);
  return task;
}

export function iconCacheStats() {
  return { cached: cache.size, missing: missing.size, inFlight: inFlight.size };
}
