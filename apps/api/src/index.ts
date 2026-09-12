/**
 * HTTP-слой приложения.
 *
 * Рыночные данные — живые, с восьми бирж через @cs/market. Состояние каждого
 * пользователя (настройки, позиции, ключи, вотчлист, сессии) — в хранилище:
 * Postgres при заданном DATABASE_URL, иначе память процесса.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import compress from '@fastify/compress';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import dotenv from 'dotenv';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

// .env лежит в корне монорепо, а рабочая директория при `npm run dev -w @cs/api`
// — это apps/api. Локальный .env (если есть) имеет приоритет над корневым.
const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, '../.env') });
dotenv.config({ path: join(here, '../../../.env') });

import {
  APP_VERSION,
  EXCHANGES,
  PLAN_WATCHLIST_LIMIT,
  type ApiKeyStatus,
  type ExchangeId,
  type PlanId,
} from '@cs/shared';

import { AuthError, DEV_USER, verifyInitData, type TelegramUser } from './auth.js';
import { startBot } from './bot.js';
import { decrypt, encrypt, encryptionReady, initEncryption, keyHint } from './crypto.js';
import { coinIcon } from './icons.js';
import { verifyExchangeKey } from './keys.js';
import { createMarketSource } from './market.js';
import { createRepo, type ExchangeKeyRecord } from './repo/index.js';
import { StateService, type UserState } from './state.js';

declare module 'fastify' {
  interface FastifyRequest {
    tgUser?: TelegramUser;
    state?: UserState;
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

// Шифрование ключей бирж. Без него приём ключей отключён: хранить их
// открытым текстом нельзя.
if (initEncryption(process.env.KEY_ENCRYPTION_KEY)) {
  app.log.info('шифрование ключей бирж: настроено');
} else {
  app.log.warn('KEY_ENCRYPTION_KEY не задан — подключение ключей бирж недоступно');
}

// Рыночный слой стартует сразу и грузит биржи параллельно с подъёмом HTTP:
// первые секунды скринер отдаёт мок, потом сам переключается на живое.
const market = createMarketSource(app.log);
const repo = await createRepo(app.log);
const state = new StateService(repo, market);

await app.register(cors, {
  origin: IS_PROD ? WEB_ORIGIN : true,
  credentials: true,
});

// Снимок скринера — 900 строк и ~300 КБ JSON раз в секунду. Через туннель
// на телефон это несколько секунд на ответ, и запросы наслаиваются друг на
// друга. Сжатый JSON в десять раз меньше.
await app.register(compress, { global: true, threshold: 2048 });

// ---------------------------------------------------------------- авторизация

/** Сессию отмечаем не чаще раза в минуту на пользователя — иначе запись на каждый опрос. */
const sessionTouched = new Map<string, number>();

app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.url.startsWith('/api/')) return;
  // Логотипы браузер тянет тегом <img>, а он не умеет слать заголовок с
  // подписью Telegram. Ничего чувствительного там нет, поэтому пускаем без неё.
  if (req.url.startsWith('/api/health') || req.url.startsWith('/api/icon/')) return;

  const initData = req.headers['x-telegram-init-data'];
  let user: TelegramUser | null = null;

  if (typeof initData === 'string' && initData.length > 0 && BOT_TOKEN) {
    try {
      user = verifyInitData(initData, BOT_TOKEN);
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

  if (!user && DEV_FAKE_USER) user = DEV_USER;
  if (!user) {
    const reason = BOT_TOKEN ? 'missing initData' : 'TELEGRAM_BOT_TOKEN не задан на сервере';
    return reply.code(401).send({ error: 'unauthorized', reason });
  }

  req.tgUser = user;
  req.state = await state.forUser(user.id, {
    username: user.username,
    firstName: user.firstName,
    language: user.languageCode,
  });

  // Отметка сессии не чаще раза в минуту — на каждое устройство отдельно,
  // иначе второе устройство, открытое следом, в список не попадёт.
  const platform = String(req.headers['x-tg-platform'] ?? 'unknown');
  const tgVersion = String(req.headers['x-tg-version'] ?? '');
  const touchKey = `${user.id}:${platform}:${tgVersion}`;
  const last = sessionTouched.get(touchKey) ?? 0;
  if (Date.now() - last > 60_000) {
    sessionTouched.set(touchKey, Date.now());
    repo.touchSession(user.id, platform, tgVersion).catch((err: unknown) => {
      req.log.warn({ err: String(err) }, 'сессия: не записалась');
    });
  }
});

// ---------------------------------------------------------------- служебное

app.get('/api/health', async () => ({
  ok: true,
  version: APP_VERSION,
  devFakeUser: DEV_FAKE_USER,
  botTokenConfigured: Boolean(BOT_TOKEN),
  storage: repo.kind,
  encryption: encryptionReady(),
  time: Date.now(),
}));

app.get('/api/me', async (req) => ({ user: req.tgUser, plan: req.state!.plan }));

// ---------------------------------------------------------------- скринер

app.get('/api/screener', async (req) => {
  const q = req.query as { minSpread?: string; venues?: string };
  const min = q.minSpread !== undefined ? Number(q.minSpread) : undefined;
  const { bot } = req.state!.settings;

  // venues=binance,bybit — считать спред между этими биржами, а не между
  // лучшими из всех восьми. Неизвестные идентификаторы просто отбрасываем.
  const valid = new Set(EXCHANGES.map((e) => e.id as string));
  const venues = (q.venues ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is ExchangeId => valid.has(v));

  const snapshot = market.snapshot(
    min !== undefined && Number.isFinite(min) ? min : bot.minSpreadPct,
    venues.length ? venues : undefined,
  );
  return { ...snapshot, refreshMs: bot.refreshMs, botRunning: bot.running };
});

app.get('/api/coin/:base', async (req, reply) => {
  const { base } = req.params as { base: string };
  const detail = market.coinDetail(base);
  if (!detail) return reply.code(404).send({ error: 'not found' });
  return detail;
});

/** Состояние подключений к биржам — для экрана отладки в настройках. */
app.get('/api/market/status', async () => {
  const mem = process.memoryUsage();
  return {
    mode: market.mode,
    live: market.live(),
    engine: market.status(),
    // Память процесса в мегабайтах: heap — что держит JS, rss — что занято у ОС.
    memoryMb: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576),
      heapTotal: Math.round(mem.heapTotal / 1048576),
      external: Math.round(mem.external / 1048576),
    },
    uptimeSec: Math.round(process.uptime()),
  };
});

app.get('/api/icon/coin/:base', async (req, reply) => {
  const { base } = req.params as { base: string };
  const icon = await coinIcon(base, req.log);
  if (!icon) return reply.code(404).send({ error: 'not found' });
  return reply
    .header('Content-Type', icon.contentType)
    // Логотипы монет не меняются — пусть браузер держит их у себя.
    .header('Cache-Control', 'public, max-age=604800, immutable')
    .send(icon.body);
});

// ---------------------------------------------------------------- вотчлист

app.get('/api/watchlist', async (req) => ({ bases: [...req.state!.watchlist] }));

app.put('/api/watchlist', async (req, reply) => {
  const body = req.body as { bases?: unknown };
  if (!Array.isArray(body?.bases)) return reply.code(400).send({ error: 'bases[] required' });
  const bases = body.bases
    .filter((b): b is string => typeof b === 'string')
    .map((b) => b.toUpperCase());

  // Лимит тарифа проверяет сервер, а не только интерфейс (ТЗ §9).
  const limit = PLAN_WATCHLIST_LIMIT[req.state!.plan] ?? null;
  if (limit !== null && bases.length > limit) {
    return reply.code(409).send({ error: 'watchlist limit', limit });
  }
  await state.setWatchlist(req.state!, bases);
  return { bases: [...req.state!.watchlist] };
});

// ---------------------------------------------------------------- настройки

async function keyStatuses(userId: number): Promise<ApiKeyStatus[]> {
  const keys = await repo.listKeys(userId);
  return EXCHANGES.map((e) => {
    const k = keys.find((x) => x.exchange === e.id);
    return {
      exchange: e.id,
      connected: Boolean(k && k.status === 'ok'),
      permissionsVerified: Boolean(k?.permissionsVerified),
      withdrawalDisabled: k?.withdrawalDisabled ?? null,
      label: k ? `${k.label || e.name} ${k.keyHint}` : undefined,
    };
  });
}

async function settingsPayload(s: UserState) {
  return {
    ...s.settings,
    plan: s.plan,
    apiKeys: await keyStatuses(s.userId),
    version: APP_VERSION,
    storage: repo.kind,
  };
}

app.get('/api/settings', async (req) => settingsPayload(req.state!));

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
  const s = req.state!;
  patch(s.settings.bot, req.body);
  // Список бирж приходит массивом — общая проверка типов его не покрывает.
  const body = req.body as { enabledExchanges?: unknown };
  if (Array.isArray(body?.enabledExchanges)) {
    const valid = new Set(EXCHANGES.map((e) => e.id as string));
    s.settings.bot.enabledExchanges = body.enabledExchanges.filter(
      (id): id is ExchangeId => typeof id === 'string' && valid.has(id),
    );
  }
  await state.saveSettings(s);
  return settingsPayload(s);
});

app.patch('/api/settings/risk', async (req) => {
  const s = req.state!;
  patch(s.settings.risk, req.body);
  await state.saveSettings(s);
  return settingsPayload(s);
});

app.patch('/api/settings/notifications', async (req) => {
  const s = req.state!;
  patch(s.settings.notifications, req.body);
  await state.saveSettings(s);
  return settingsPayload(s);
});

app.patch('/api/settings/plan', async (req) => {
  const s = req.state!;
  const body = req.body as { plan?: string };
  if (body?.plan === 'screener' || body?.plan === 'limited' || body?.plan === 'unlimited') {
    await state.setPlan(s, body.plan as PlanId);
  }
  return settingsPayload(s);
});

// ---------------------------------------------------------------- ключи бирж

/** Что о ключе можно отдать наружу: без секретов, только метаданные. */
function publicKey(k: ExchangeKeyRecord) {
  return {
    exchange: k.exchange,
    label: k.label,
    keyHint: k.keyHint,
    status: k.status,
    withdrawalDisabled: k.withdrawalDisabled,
    permissionsVerified: k.permissionsVerified,
    lastError: k.lastError,
    createdAt: k.createdAt,
    lastCheckedAt: k.lastCheckedAt,
  };
}

app.get('/api/keys', async (req) => ({
  encryption: encryptionReady(),
  keys: (await repo.listKeys(req.state!.userId)).map(publicKey),
}));

/**
 * Подключение ключа: проверяем на бирже, шифруем, сохраняем. Ключ с правом
 * вывода средств отклоняется — это требование ТЗ §5.2, и оно не обсуждается.
 */
app.post('/api/keys/:exchange', async (req, reply) => {
  if (!encryptionReady()) {
    return reply.code(503).send({ error: 'encryption not configured' });
  }
  const { exchange } = req.params as { exchange: string };
  const valid = EXCHANGES.find((e) => e.id === exchange);
  if (!valid) return reply.code(404).send({ error: 'unknown exchange' });
  const id = valid.id;

  const body = req.body as { apiKey?: string; secret?: string; passphrase?: string; label?: string };
  const apiKey = (body.apiKey ?? '').trim();
  const secret = (body.secret ?? '').trim();
  const passphrase = (body.passphrase ?? '').trim() || undefined;
  if (!apiKey || !secret) return reply.code(400).send({ error: 'apiKey and secret required' });

  const check = await verifyExchangeKey(id, { apiKey, secret, passphrase });
  const now = Date.now();

  if (check.ok && check.withdrawalDisabled === false) {
    // Не сохраняем вообще: ключ с выводом в системе появляться не должен.
    req.log.warn({ exchange: id, user: req.state!.userId }, 'ключ с правом вывода отклонён');
    return reply.code(422).send({
      error: 'withdrawal enabled',
      status: 'withdrawal_enabled' as const,
    });
  }
  if (!check.ok) {
    // Нерабочий ключ тоже не храним: пользователь видит причину и вводит заново,
    // а прежний рабочий ключ (если был) остаётся на месте.
    return reply.code(422).send({ error: check.error ?? 'key rejected', status: 'invalid' as const });
  }

  const record: ExchangeKeyRecord = {
    id: randomUUID(),
    userId: req.state!.userId,
    exchange: id,
    label: (body.label ?? '').trim().slice(0, 40),
    apiKeyEnc: encrypt(apiKey),
    secretEnc: encrypt(secret),
    passphraseEnc: passphrase ? encrypt(passphrase) : null,
    keyHint: keyHint(apiKey),
    withdrawalDisabled: check.withdrawalDisabled,
    permissionsVerified: check.permissionsVerified,
    status: 'ok',
    lastError: null,
    createdAt: now,
    lastCheckedAt: now,
  };
  await repo.upsertKey(record);

  return {
    key: publicKey(record),
    usdtBalance: check.usdtBalance,
    // Где права по API не читаются, интерфейс обязан показать чек-лист.
    manualChecklist: !check.permissionsVerified,
  };
});

app.post('/api/keys/:exchange/verify', async (req, reply) => {
  const { exchange } = req.params as { exchange: string };
  const keys = await repo.listKeys(req.state!.userId);
  const k = keys.find((x) => x.exchange === exchange);
  if (!k) return reply.code(404).send({ error: 'not connected' });

  const check = await verifyExchangeKey(k.exchange, {
    apiKey: decrypt(k.apiKeyEnc),
    secret: decrypt(k.secretEnc),
    passphrase: k.passphraseEnc ? decrypt(k.passphraseEnc) : undefined,
  });
  k.status = check.ok
    ? check.withdrawalDisabled === false
      ? 'withdrawal_enabled'
      : 'ok'
    : 'invalid';
  k.withdrawalDisabled = check.withdrawalDisabled;
  k.permissionsVerified = check.permissionsVerified;
  k.lastError = check.error;
  k.lastCheckedAt = Date.now();
  await repo.upsertKey(k);
  return { key: publicKey(k), usdtBalance: check.usdtBalance };
});

app.delete('/api/keys/:exchange', async (req, reply) => {
  const { exchange } = req.params as { exchange: string };
  if (!EXCHANGES.some((e) => e.id === exchange)) {
    return reply.code(404).send({ error: 'unknown exchange' });
  }
  await repo.deleteKey(req.state!.userId, exchange as ExchangeId);
  return { ok: true };
});

// ---------------------------------------------------------------- позиции

app.get('/api/positions', async (req) => {
  const s = req.state!;
  const q = req.query as { tab?: string };
  const tab = q.tab ?? 'open';
  const at = Date.now();
  const mode = s.settings.bot.executionMode;

  const all = [...s.positions.values()];
  const open = all.filter((p) => p.status === 'open').map((p) => state.toPosition(p, mode, at));
  const closed = all
    .filter((p) => p.status === 'closed')
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .map((p) => state.toPosition(p, mode, at));

  // «История» пока показывает то же, что «Закрытые»; на M4 туда добавятся
  // неудачные входы и отменённые сигналы — они не являются позициями.
  return { tab, positions: tab === 'open' ? open : closed, summary: state.summary(open) };
});

app.get('/api/positions/:id', async (req, reply) => {
  const s = req.state!;
  const { id } = req.params as { id: string };
  const rec = s.positions.get(id);
  if (!rec) return reply.code(404).send({ error: 'not found' });
  return {
    position: state.toPosition(rec, s.settings.bot.executionMode),
    targetSpreadPct: rec.targetSpreadPct,
    stopSpreadPct: rec.stopSpreadPct,
    feesUsdt: state.roundTripFeesUsdt(rec),
    funding: state.positionFunding(rec),
    closeReason: rec.closeReason,
    holdTimeoutMinutes: s.settings.risk.holdTimeoutMinutes,
  };
});

app.patch('/api/positions/:id', async (req, reply) => {
  const s = req.state!;
  const { id } = req.params as { id: string };
  const rec = s.positions.get(id);
  if (!rec) return reply.code(404).send({ error: 'not found' });
  if (rec.status === 'closed') return reply.code(409).send({ error: 'position is closed' });

  const body = req.body as { targetSpreadPct?: number | null; stopSpreadPct?: number | null };
  const num = (v: number | null | undefined) =>
    v === undefined ? undefined : v === null ? null : Number(v);
  await state.adjustPosition(s, rec, {
    targetSpreadPct: num(body.targetSpreadPct),
    stopSpreadPct: num(body.stopSpreadPct),
  });
  return {
    position: state.toPosition(rec, s.settings.bot.executionMode),
    targetSpreadPct: rec.targetSpreadPct,
    stopSpreadPct: rec.stopSpreadPct,
  };
});

app.post('/api/positions/:id/close', async (req, reply) => {
  const s = req.state!;
  const { id } = req.params as { id: string };
  const rec = s.positions.get(id);
  if (!rec || rec.status === 'closed') {
    return reply.code(409).send({ error: 'already closed or not found' });
  }
  const closed = await state.closePosition(s, rec, 'manual');
  req.log.info({ id, user: s.userId }, 'позиция закрыта вручную');
  return { position: closed };
});

// ---------------------------------------------------------------- сессии

app.get('/api/sessions', async (req) => {
  const platform = String(req.headers['x-tg-platform'] ?? 'unknown');
  const tgVersion = String(req.headers['x-tg-version'] ?? '');
  const sessions = await repo.listSessions(req.state!.userId);
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      platform: s.platform,
      telegramVersion: s.tgVersion,
      current: s.platform === platform && s.tgVersion === tgVersion,
      firstSeenAt: s.firstSeenAt,
      lastSeenAt: s.lastSeenAt,
    })),
    user: req.tgUser,
  };
});

/**
 * «Выйти из аккаунта» в мини-приложении: личность даёт Telegram, и отозвать
 * её мы не можем. Что можем — забыть все остальные устройства.
 */
app.post('/api/sessions/logout-others', async (req) => {
  const platform = String(req.headers['x-tg-platform'] ?? 'unknown');
  const tgVersion = String(req.headers['x-tg-version'] ?? '');
  const removed = await repo.deleteOtherSessions(req.state!.userId, platform, tgVersion);
  return { removed };
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

app.addHook('onClose', async () => {
  await market.stop();
  await repo.close();
});

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(
  `API на http://localhost:${PORT} | хранилище: ${repo.kind} | dev-байпас авторизации: ${DEV_FAKE_USER ? 'ВКЛ' : 'выкл'}`,
);

// Бот живёт в этом же процессе: пока нагрузка — одно long-polling соединение,
// отдельный сервис только добавил бы точку отказа.
if (BOT_TOKEN) {
  startBot({ token: BOT_TOKEN, publicUrl: process.env.PUBLIC_URL, log: app.log });
} else {
  app.log.warn('TELEGRAM_BOT_TOKEN не задан — бот не запущен');
}
