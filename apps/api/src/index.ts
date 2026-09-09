/**
 * HTTP-слой приложения.
 *
 * Рыночные данные пока мок (M2 заменит их живыми биржами), а вот настройки
 * и позиции — уже настоящее состояние: их можно менять, и изменения видны
 * во всём приложении. На M3 это состояние переезжает в Postgres.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import dotenv from 'dotenv';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

// .env лежит в корне монорепо, а рабочая директория при `npm run dev -w @cs/api`
// — это apps/api. Локальный .env (если есть) имеет приоритет над корневым.
const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, '../.env') });
dotenv.config({ path: join(here, '../../../.env') });

import { APP_VERSION, EXCHANGES, type ExchangeId } from '@cs/shared';

import { AuthError, DEV_USER, verifyInitData, type TelegramUser } from './auth.js';
import { startBot } from './bot.js';
import { coinIcon } from './icons.js';
import { apiKeyStatuses, coinDetail, screenerSnapshot } from './mock.js';
import {
  closePosition,
  findPosition,
  positionFunding,
  roundTripFeesUsdt,
  store,
  summary,
  toPosition,
} from './store.js';

declare module 'fastify' {
  interface FastifyRequest {
    tgUser?: TelegramUser;
  }
}

// PORT задают почти все хостинги (Fly, Render, Railway); API_PORT — наш локальный.
const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 8787);
// В проде фронт лежит на том же происхождении, что и API, поэтому правильный
// origin — публичный адрес приложения. Значение по умолчанию с localhost имеет
// смысл только для локальной разработки.
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? process.env.PUBLIC_URL ?? 'http://localhost:5173';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const DEV_FAKE_USER = process.env.DEV_FAKE_USER === '1';
const IS_PROD = process.env.NODE_ENV === 'production';

if (DEV_FAKE_USER && IS_PROD) {
  throw new Error('DEV_FAKE_USER=1 недопустим при NODE_ENV=production — это обход авторизации');
}

const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, {
  origin: IS_PROD ? WEB_ORIGIN : true,
  credentials: true,
});

/** Авторизация на всех /api/* кроме health. */
app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.url.startsWith('/api/')) return;
  // Логотипы браузер тянет тегом <img>, а он не умеет слать заголовок с
  // подписью Telegram. Ничего чувствительного там нет, поэтому пускаем без неё.
  if (req.url.startsWith('/api/health') || req.url.startsWith('/api/icon/')) return;

  const initData = req.headers['x-telegram-init-data'];

  if (typeof initData === 'string' && initData.length > 0 && BOT_TOKEN) {
    try {
      req.tgUser = verifyInitData(initData, BOT_TOKEN);
      return;
    } catch (err) {
      if (!DEV_FAKE_USER) {
        req.log.warn({ reason: String(err) }, 'авторизация: initData отклонена');
        return reply.code(401).send({ error: 'unauthorized' });
      }
    }
  } else if (!DEV_FAKE_USER) {
    // Различаем «клиент не прислал подпись» и «подпись не сошлась»: снаружи это
    // одинаковый 401, а причины и лечение у них совершенно разные.
    req.log.warn(
      {
        headerPresent: initData !== undefined,
        headerLength: typeof initData === 'string' ? initData.length : 0,
        botTokenConfigured: Boolean(BOT_TOKEN),
      },
      'авторизация: подписи Telegram в запросе нет',
    );
  }

  if (DEV_FAKE_USER) {
    req.tgUser = DEV_USER;
    return;
  }

  const reason = BOT_TOKEN ? 'missing initData' : 'TELEGRAM_BOT_TOKEN не задан на сервере';
  return reply.code(401).send({ error: 'unauthorized', reason });
});

// ---------------------------------------------------------------- служебное

app.get('/api/health', async () => ({
  ok: true,
  version: APP_VERSION,
  devFakeUser: DEV_FAKE_USER,
  botTokenConfigured: Boolean(BOT_TOKEN),
  time: Date.now(),
}));

app.get('/api/me', async (req) => ({ user: req.tgUser, plan: store.plan }));

// ---------------------------------------------------------------- скринер

app.get('/api/screener', async (req) => {
  const q = req.query as { minSpread?: string; venues?: string };
  const min = q.minSpread !== undefined ? Number(q.minSpread) : undefined;

  // venues=binance,bybit — считать спред между этими биржами, а не между
  // лучшими из всех восьми. Неизвестные идентификаторы просто отбрасываем.
  const valid = new Set(EXCHANGES.map((e) => e.id as string));
  const venues = (q.venues ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is ExchangeId => valid.has(v));

  return screenerSnapshot(
    Number.isFinite(min) ? min : undefined,
    venues.length ? venues : undefined,
  );
});

app.get('/api/coin/:base', async (req, reply) => {
  const { base } = req.params as { base: string };
  const detail = coinDetail(base);
  if (!detail) return reply.code(404).send({ error: 'not found' });
  return detail;
});

app.get('/api/icon/coin/:base', async (req, reply) => {
  const { base } = req.params as { base: string };
  const icon = await coinIcon(base, req.log);
  if (!icon) return reply.code(404).send({ error: 'not found' });
  return (
    reply
      .header('Content-Type', icon.contentType)
      // Логотипы монет не меняются — пусть браузер держит их у себя.
      .header('Cache-Control', 'public, max-age=604800, immutable')
      .send(icon.body)
  );
});

// ---------------------------------------------------------------- настройки

function settingsPayload() {
  return {
    bot: store.bot,
    risk: store.risk,
    notifications: store.notifications,
    plan: store.plan,
    apiKeys: apiKeyStatuses(),
    version: APP_VERSION,
  };
}

app.get('/api/settings', async () => settingsPayload());

/**
 * Частичное обновление секции настроек. Принимаем только известные ключи —
 * иначе в состояние можно записать что угодно из клиента.
 */
function patch<T extends object>(target: T, body: unknown): T {
  if (!body || typeof body !== 'object') return target;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!(key in target)) continue;
    const current = (target as Record<string, unknown>)[key];
    if (typeof current === typeof value || current === null) {
      (target as Record<string, unknown>)[key] = value;
    }
  }
  return target;
}

app.patch('/api/settings/bot', async (req) => {
  patch(store.bot, req.body);
  // Список бирж приходит массивом — общая проверка типов его не покрывает.
  const body = req.body as { enabledExchanges?: unknown };
  if (Array.isArray(body?.enabledExchanges)) {
    const valid = new Set(EXCHANGES.map((e) => e.id as string));
    store.bot.enabledExchanges = body.enabledExchanges.filter(
      (id): id is ExchangeId => typeof id === 'string' && valid.has(id),
    );
  }
  return settingsPayload();
});

app.patch('/api/settings/risk', async (req) => {
  patch(store.risk, req.body);
  return settingsPayload();
});

app.patch('/api/settings/notifications', async (req) => {
  patch(store.notifications, req.body);
  return settingsPayload();
});

app.patch('/api/settings/plan', async (req) => {
  const body = req.body as { plan?: string };
  if (body?.plan === 'screener' || body?.plan === 'limited' || body?.plan === 'unlimited') {
    store.plan = body.plan;
  }
  return settingsPayload();
});

// ---------------------------------------------------------------- позиции

app.get('/api/positions', async (req) => {
  const q = req.query as { tab?: string };
  const tab = q.tab ?? 'open';
  const at = Date.now();

  const open = store.positions.filter((p) => p.status === 'open').map((p) => toPosition(p, at));
  const closed = store.positions
    .filter((p) => p.status === 'closed')
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .map((p) => toPosition(p, at));

  // «История» пока показывает то же, что «Закрытые»; на M4 туда добавятся
  // неудачные входы и отменённые сигналы — они не являются позициями.
  const positions = tab === 'open' ? open : closed;
  return { tab, positions, summary: summary(open) };
});

app.get('/api/positions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const rec = findPosition(id);
  if (!rec) return reply.code(404).send({ error: 'not found' });

  return {
    position: toPosition(rec),
    targetSpreadPct: rec.targetSpreadPct,
    stopSpreadPct: rec.stopSpreadPct,
    feesUsdt: roundTripFeesUsdt(rec),
    funding: positionFunding(rec),
    closeReason: rec.closeReason ?? null,
    holdTimeoutMinutes: store.risk.holdTimeoutMinutes,
  };
});

app.patch('/api/positions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const rec = findPosition(id);
  if (!rec) return reply.code(404).send({ error: 'not found' });
  if (rec.status === 'closed') return reply.code(409).send({ error: 'position is closed' });

  const body = req.body as { targetSpreadPct?: number | null; stopSpreadPct?: number | null };
  if (body.targetSpreadPct !== undefined) {
    rec.targetSpreadPct = body.targetSpreadPct === null ? null : Number(body.targetSpreadPct);
  }
  if (body.stopSpreadPct !== undefined) {
    rec.stopSpreadPct = body.stopSpreadPct === null ? null : Number(body.stopSpreadPct);
  }
  return {
    position: toPosition(rec),
    targetSpreadPct: rec.targetSpreadPct,
    stopSpreadPct: rec.stopSpreadPct,
  };
});

app.post('/api/positions/:id/close', async (req, reply) => {
  const { id } = req.params as { id: string };
  const closed = closePosition(id, 'manual');
  if (!closed) return reply.code(409).send({ error: 'already closed or not found' });
  req.log.info({ id }, 'position closed manually');
  return { position: closed };
});

// ---------------------------------------------------------------- сессии

app.get('/api/sessions', async (req) => {
  const user = req.tgUser;
  return {
    sessions: [
      {
        id: 'current',
        platform: (req.headers['x-tg-platform'] as string) ?? 'unknown',
        telegramVersion: (req.headers['x-tg-version'] as string) ?? '—',
        current: true,
        lastSeenAt: Date.now(),
      },
    ],
    user,
  };
});

// ---------------------------------------------------------------- статика

// В проде тот же процесс раздаёт собранный фронт — одно происхождение,
// никаких CORS и никакого отдельного статик-хостинга.
const webDist = join(here, '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AuthError) return reply.code(401).send({ error: 'unauthorized' });
  app.log.error(err);
  return reply.code(500).send({ error: 'internal' });
});

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(
  `API на http://localhost:${PORT} | dev-байпас авторизации: ${DEV_FAKE_USER ? 'ВКЛ' : 'выкл'}`,
);

// Бот живёт в этом же процессе: пока нагрузка — одно long-polling соединение,
// отдельный сервис только добавил бы точку отказа.
if (BOT_TOKEN) {
  startBot({ token: BOT_TOKEN, publicUrl: process.env.PUBLIC_URL, log: app.log });
} else {
  app.log.warn('TELEGRAM_BOT_TOKEN не задан — бот не запущен');
}
