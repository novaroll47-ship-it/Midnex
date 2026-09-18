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
  purchasablePlans,
  EXCHANGES,
  PLAN_WATCHLIST_LIMIT,
  type ApiKeyStatus,
  type ExchangeId,
  type PlanId,
} from '@cs/shared';

import { AuthError, DEV_USER, verifyInitData, type TelegramUser } from './auth.js';
import { AlertEngine } from './alerts.js';
import { Billing, toPaymentInfo } from './billing.js';
import { NotificationService } from './notifications.js';
import { startBot, type BotHandle } from './bot.js';
import { decrypt, encrypt, encryptionReady, initEncryption, keyHint } from './crypto.js';
import { coinIcon } from './icons.js';
import { verifyExchangeKey } from './keys.js';
import { createMarketSource, type MarketHooks } from './market.js';
import type { VenueMarket } from '@cs/market';
import { ListingsMonitor } from './listings.js';
import { PairsService } from './pairs.js';
import { ExternalTickers } from './pairs-external.js';
import { HistoryCollector } from './history/collector.js';
import { FUNDING_PERIODS, FundingHistory, type FundingPeriod } from './history/funding.js';
import { SqliteHistoryStore } from './history/sqlite.js';
import type { Timeframe } from './history/store.js';
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

/**
 * Этап релиза. Пока бот-торговец не готов, наружу выходит только скринер:
 * всё торговое в интерфейсе помечено «Скоро» и не взаимодействует, а
 * закреплённые монеты — просто избранное без лимитов тарифа.
 * TRADING_ENABLED=1 включает торговые разделы обратно.
 */
const TRADING_ENABLED = process.env.TRADING_ENABLED === '1';

/** Telegram ID владельца: админ-команды в боте и доступ без подписки. */
const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID) || null;
/** Курс звёзд Telegram к доллару для инвойсов. */
const STARS_PER_USD = Number(process.env.STARS_PER_USD) || 50;
/** Кошельки для USDT: USDT_WALLETS="TRC20:Txxx,TON:UQxxx". */
const USDT_WALLETS = (process.env.USDT_WALLETS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf(':');
    return { network: s.slice(0, i).trim(), address: s.slice(i + 1).trim() };
  })
  .filter((w) => w.network && w.address);
/** Сколько строк скринера видно без подписки. */
const FREE_PREVIEW_ROWS = 3;

/** История спредов: файл SQLite рядом с процессом (см. history/). */
const HISTORY_DB_PATH =
  process.env.HISTORY_DB_PATH?.trim() || join(here, '../../../.data', 'history.sqlite');
const HISTORY_RAW_DAYS = Number(process.env.HISTORY_RAW_DAYS) || 7;
const HISTORY_MINUTE_DAYS = Number(process.env.HISTORY_MINUTE_DAYS) || 30;
const HISTORY_TICK_MIN_SPREAD = Number(process.env.HISTORY_TICK_MIN_SPREAD) || 0.5;
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
// Хуки движка заполняются ниже, когда появятся сервисы, которым они нужны.
const marketHooks: MarketHooks = {};
const market = createMarketSource(app.log, marketHooks);
const repo = await createRepo(app.log);
const state = new StateService(repo, market);
const billing = new Billing({
  repo,
  log: app.log,
  botToken: BOT_TOKEN || undefined,
  adminId: ADMIN_TELEGRAM_ID,
  starsPerUsd: STARS_PER_USD,
  wallets: USDT_WALLETS,
  trading: TRADING_ENABLED,
});
let bot: BotHandle | null = null;

// Сверка пар: таблица из базы → движок; новые рынки → пары-кандидаты;
// раз в минуту — автосверка по ценам и CoinGecko.
const externalTickers = new ExternalTickers(join(dirname(HISTORY_DB_PATH), 'external-tickers.json'), app.log);
const pairs = new PairsService({
  repo,
  engine: market.engine,
  log: app.log,
  external: externalTickers,
  onAnomalies: (count) => {
    if (bot && billing.adminId !== null) {
      void bot.send(
        billing.adminId,
        `Сверка: ${count} новых аномалий ждут решения — Настройки → Сверка пар.`,
      );
    }
  },
});
await pairs.load();
marketHooks.onMarketsChanged = (exchange, markets) => {
  void pairs.syncMarkets(exchange, markets).catch((err: unknown) => {
    app.log.warn({ err: String(err) }, 'сверка: кандидаты не записаны');
  });
};
// Рынки, загруженные до подключения хука, тоже надо занести.
if (market.engine) {
  const byExchange = new Map<ExchangeId, VenueMarket[]>();
  for (const m of market.engine.allMarkets()) {
    byExchange.set(m.exchange, [...(byExchange.get(m.exchange) ?? []), m]);
  }
  for (const [exchange, markets] of byExchange) void pairs.syncMarkets(exchange, markets);
  externalTickers.start();
  pairs.start();
}

// Уведомления — единая очередь в Telegram; алерты по спреду — поверх неё.
const notifications = new NotificationService(() => bot, app.log, process.env.PUBLIC_URL);
const alerts = new AlertEngine(repo, market, notifications, billing, app.log);
void alerts.start();

// Листинги: раз в 10 минут diff инструментов; новые — в сверку, пропавшие — delisted.
const listings = new ListingsMonitor({
  engine: market.engine,
  pairs,
  repo,
  notify: notifications,
  log: app.log,
  notifyAdmin: (text) => {
    if (bot && billing.adminId !== null) void bot.send(billing.adminId, text);
  },
});
if (market.mode === 'live') listings.start();

// Новому пользователю — пробная неделя «Скринера» и сообщение об этом в чат.
// Скрытый флаг «бумажной торговли»: список Telegram ID в app_config,
// переключается кнопкой в админ-меню бота — без пересборки.
const PAPER_KEY = 'paper_trading_users';
state.paperUsers = new Set(
  ((await repo.getConfig(PAPER_KEY)) ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v > 0),
);
if (state.paperUsers.size) app.log.info(`бумажная торговля включена для: ${[...state.paperUsers].join(', ')}`);
async function togglePaper(userId: number): Promise<boolean> {
  if (state.paperUsers.has(userId)) state.paperUsers.delete(userId);
  else state.paperUsers.add(userId);
  await repo.setConfig(PAPER_KEY, [...state.paperUsers].join(','));
  state.invalidate(userId);
  return state.paperUsers.has(userId);
}

state.onNewUser = async (user) => {
  const sub = await billing.grantTrialIfEligible(user.id, user.trialUsedAt);
  if (sub && bot) {
    void bot.send(
      user.id,
      `Тебе открыта пробная неделя MIDNEX — все спреды в реальном времени до ${new Date(sub.expiresAt).toLocaleDateString('ru-RU')}. ` +
        'За день до конца напомню.',
    );
  }
};

// История пишется только с живого рынка: мок-данные истории не заслуживают.
const history = new SqliteHistoryStore(HISTORY_DB_PATH);
const collector = new HistoryCollector({
  store: history,
  market,
  log: app.log,
  tickMinSpreadPct: HISTORY_TICK_MIN_SPREAD,
  rawDays: HISTORY_RAW_DAYS,
  minuteDays: HISTORY_MINUTE_DAYS,
});
if (market.mode === 'live') collector.start();
// Обрывы и лимиты из потоков — в журнал дыр с причиной.
marketHooks.onGap = (exchange, reason) => {
  if (reason) collector.gapOpen(exchange, reason);
  else collector.gapClose(exchange);
};

// История фандинга: биржи хранят её сами — грузим 180 дней по сверенным ногам.
const fundingHistory = new FundingHistory({
  store: history,
  engine: market.engine,
  log: app.log,
  legs: () => market.engine?.allLegs() ?? [],
  backfillDays: 180,
});
if (market.mode === 'live') fundingHistory.start();

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
  trading: TRADING_ENABLED,
  time: Date.now(),
  uptimeSec: Math.round(process.uptime()),
  memoryMb: memoryMb(),
}));

function memoryMb() {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1048576),
    heapUsed: Math.round(mem.heapUsed / 1048576),
    heapTotal: Math.round(mem.heapTotal / 1048576),
    external: Math.round(mem.external / 1048576),
    arrayBuffers: Math.round(mem.arrayBuffers / 1048576),
  };
}

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

  // Без подписки — только верхушка списка: видно, что есть, но не всё.
  if (!(await billing.hasAccess(req.state!.userId))) {
    return {
      ...snapshot,
      rows: snapshot.rows.slice(0, FREE_PREVIEW_ROWS),
      totalRows: snapshot.rows.length,
      preview: true,
      refreshMs: bot.refreshMs,
      botRunning: bot.running,
    };
  }
  return { ...snapshot, refreshMs: bot.refreshMs, botRunning: bot.running };
});

app.get('/api/coin/:base', async (req, reply) => {
  const { base } = req.params as { base: string };
  if (!(await billing.hasAccess(req.state!.userId))) {
    return reply.code(402).send({ error: 'subscription required' });
  }
  const detail = market.coinDetail(base);
  if (!detail) return reply.code(404).send({ error: 'not found' });
  return detail;
});

// ---------------------------------------------------------------- история спредов

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '1h'];

/**
 * Свечи спреда по монете. Пара бирж внутри минуты могла меняться, поэтому
 * на каждый момент отдаём лучшую (по максимуму) свечу — так график монеты
 * показывает «какой спред был доступен», а не историю одной пары.
 */
app.get('/api/history/:base', async (req, reply) => {
  if (!(await billing.hasAccess(req.state!.userId))) {
    return reply.code(402).send({ error: 'subscription required' });
  }
  const { base } = req.params as { base: string };
  const q = req.query as { tf?: string; from?: string; to?: string };
  const tf = (TIMEFRAMES.includes(q.tf as Timeframe) ? q.tf : '1m') as Timeframe;
  const to = Number(q.to) || Date.now();
  const spanDefault = tf === '1m' ? 6 * 3_600_000 : tf === '5m' ? 2 * 86_400_000 : 30 * 86_400_000;
  const from = Number(q.from) || to - spanDefault;
  const canonical = base.toUpperCase();
  const tfMs = tf === '1m' ? 60_000 : tf === '5m' ? 300_000 : 3_600_000;
  const all = history.queryCandles(canonical, tf, from, to);
  const best = new Map<number, (typeof all)[number]>();
  for (const c of all) {
    const cur = best.get(c.ts);
    if (!cur || c.high > cur.high) best.set(c.ts, c);
  }
  // Хвост «вживую»: 5m/1h сворачиваются раз в час, а минутная свеча
  // закрывается по минуте — без этого график отставал бы. Досчитываем
  // недостающие свечи из минутных и незакрытой минуты сборщика.
  const lastTs = Math.max(-1, ...best.keys());
  const tailFrom = Math.max(from, lastTs + tfMs);
  const minutes = tf === '1m' ? [] : history.queryCandles(canonical, '1m', tailFrom, to);
  const partial = collector.current(canonical);
  if (partial && partial.ts >= tailFrom) minutes.push(partial);
  for (const m of minutes) {
    const ts = Math.floor(m.ts / tfMs) * tfMs;
    if (ts < tailFrom) continue;
    const cur = best.get(ts);
    if (!cur) best.set(ts, { ...m, ts });
    else {
      if (m.high > cur.high) {
        cur.high = m.high;
        cur.exA = m.exA;
        cur.exB = m.exB;
      }
      cur.low = Math.min(cur.low, m.low);
      cur.close = m.close;
      cur.samples += m.samples;
    }
  }
  return {
    base: canonical,
    tf,
    from,
    to,
    candles: [...best.values()].sort((a, b) => a.ts - b.ts),
  };
});

/**
 * Накопленный фандинг по монете за период, по каждой бирже: лонг платит,
 * шорт получает. Лучшая пара — шорт там, где ставка выше, лонг — где ниже.
 */
app.get('/api/coin/:base/funding', async (req, reply) => {
  if (!(await billing.hasAccess(req.state!.userId))) {
    return reply.code(402).send({ error: 'subscription required' });
  }
  const { base } = req.params as { base: string };
  const q = req.query as { period?: string };
  const period = (
    FUNDING_PERIODS.includes(q.period as FundingPeriod) ? q.period : '7d'
  ) as FundingPeriod;
  const canonical = base.toUpperCase();
  // Без движка (мок) ног нет — берём стандартные символы, чтобы экран
  // фандинга можно было смотреть на данных из истории.
  const legs =
    market.engine?.legsOf(canonical) ??
    EXCHANGES.map((e) => ({ exchange: e.id, symbol: `${canonical}/USDT:USDT` }));
  const venues = fundingHistory.aggregate(legs, period);
  const breakdown = fundingHistory.breakdown(legs, period);
  const sorted = [...venues].sort((a, b) => a.avgRatePct - b.avgRatePct);
  const best =
    sorted.length >= 2
      ? {
          longExchange: sorted[0]!.exchange,
          shortExchange: sorted[sorted.length - 1]!.exchange,
          netPct: sorted[sorted.length - 1]!.shortPct + sorted[0]!.longPct,
        }
      : null;
  return { base: canonical, period, venues, best, breakdown };
});

/** Состояние сборщика истории — только администратору. */
app.get('/api/history/status', async (req, reply) => {
  if (!billing.isAdmin(req.state!.userId)) return reply.code(403).send({ error: 'admin only' });
  return history.status();
});

/** Состояние подключений к биржам — для экрана отладки в настройках. */
app.get('/api/market/status', async () => {
  return {
    mode: market.mode,
    live: market.live(),
    engine: market.status(),
    // Память процесса в мегабайтах: heap — что держит JS, rss — что занято у ОС.
    memoryMb: memoryMb(),
    uptimeSec: Math.round(process.uptime()),
  };
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

// ---------------------------------------------------------------- вотчлист

app.get('/api/watchlist', async (req) => ({ bases: [...req.state!.watchlist] }));

app.put('/api/watchlist', async (req, reply) => {
  const body = req.body as { bases?: unknown };
  if (!Array.isArray(body?.bases)) return reply.code(400).send({ error: 'bases[] required' });
  const bases = body.bases
    .filter((b): b is string => typeof b === 'string')
    .map((b) => b.toUpperCase());

  // Лимит тарифа проверяет сервер, а не только интерфейс (ТЗ §9).
  // На этапе «только скринер» лимитов нет: это избранное, а не список торговли.
  const limit = TRADING_ENABLED ? (PLAN_WATCHLIST_LIMIT[req.state!.plan] ?? null) : null;
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
    features: { trading: TRADING_ENABLED, admin: billing.isAdmin(s.userId) },
    subscription: await billing.info(s.userId),
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

app.patch('/api/settings/bot', async (req, reply) => {
  const s = req.state!;
  const body = { ...(req.body as Record<string, unknown>) };
  // Исполнение пользователю не выставить: реальные деньги всегда, «бумага» — служебный флаг.
  delete body['executionMode'];
  if (body['mode'] !== undefined && body['mode'] !== 'semi' && body['mode'] !== 'auto') delete body['mode'];
  patch(s.settings.bot, body);
  // Список бирж приходит массивом — общая проверка типов его не покрывает.
  if (Array.isArray(body['enabledExchanges'])) {
    const valid = new Set(EXCHANGES.map((e) => e.id as string));
    const wanted = body['enabledExchanges'].filter(
      (id): id is ExchangeId => typeof id === 'string' && valid.has(id),
    );
    // Торговать можно только там, где есть ключ — иначе бот не сможет открыть сделку.
    const withKeys = new Set((await repo.listKeys(s.userId)).map((k) => k.exchange));
    const missing = wanted.find((id) => !withKeys.has(id));
    if (missing) return reply.code(400).send({ error: 'key required', exchange: missing });
    s.settings.bot.enabledExchanges = wanted;
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

/** Прогресс обучения: список пройденных модулей; сброс — пустой список или без модуля. */
app.patch('/api/settings/onboarding', async (req, reply) => {
  const s = req.state!;
  const body = req.body as { completed?: unknown };
  if (!Array.isArray(body?.completed))
    return reply.code(400).send({ error: 'completed[] required' });
  s.settings.onboarding = {
    completed: [...new Set(body.completed.filter((x): x is string => typeof x === 'string'))].slice(
      0,
      50,
    ),
  };
  await state.saveSettings(s);
  return settingsPayload(s);
});

/** Вид скринера: список или карточки — личная настройка, живёт на сервере. */
app.patch('/api/settings/ui', async (req, reply) => {
  const s = req.state!;
  const body = req.body as { view?: unknown };
  if (body?.view !== 'list' && body?.view !== 'cards') return reply.code(400).send({ error: 'bad view' });
  s.settings.ui = { ...s.settings.ui, view: body.view };
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

// ---------------------------------------------------------------- подписка и оплата

/** Имя бота для ссылок «Открыть чат» — узнаём один раз у Telegram. */
let botUsername: string | null = null;
async function resolveBotUsername(): Promise<string | null> {
  if (botUsername || !BOT_TOKEN) return botUsername;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { ok: boolean; result?: { username?: string } };
    botUsername = body.result?.username ?? null;
  } catch {
    // Сеть моргнула — попробуем при следующем запросе.
  }
  return botUsername;
}

app.get('/api/billing', async (req) => {
  const userId = req.state!.userId;
  return {
    botUsername: await resolveBotUsername(),
    subscription: await billing.info(userId),
    pending: await billing.pendingFor(userId),
    purchasable: purchasablePlans(TRADING_ENABLED),
    starsPerUsd: STARS_PER_USD,
    wallets: billing.wallets.map((w) => w.network),
    starsAvailable: Boolean(BOT_TOKEN),
  };
});

app.post('/api/billing/stars', async (req, reply) => {
  const body = req.body as { plan?: string; months?: number };
  const r = await billing.createStarsInvoice(
    req.state!.userId,
    String(body?.plan ?? ''),
    Number(body?.months),
  );
  if ('error' in r) return reply.code(400).send({ error: r.error });
  return { link: r.link, payment: toPaymentInfo(r.payment) };
});

app.post('/api/billing/stars/:id/chat', async (req, reply) => {
  const { id } = req.params as { id: string };
  const ok = await billing.sendInvoiceToChat(req.state!.userId, id);
  if (!ok) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

app.post('/api/billing/crypto', async (req, reply) => {
  const body = req.body as { plan?: string; months?: number; network?: string };
  const r = await billing.createCryptoRequest(
    req.state!.userId,
    String(body?.plan ?? ''),
    Number(body?.months),
    String(body?.network ?? ''),
  );
  if ('error' in r) return reply.code(400).send({ error: r.error });
  return { payment: toPaymentInfo(r.payment), address: r.wallet.address };
});

app.post('/api/billing/crypto/:id/tx', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { txHash?: string };
  const hash = String(body?.txHash ?? '').trim();
  if (hash.length < 10) return reply.code(400).send({ error: 'tx hash required' });
  const p = await billing.submitTxHash(req.state!.userId, id, hash);
  if (!p) return reply.code(404).send({ error: 'not found' });

  // Админ узнаёт о заявке сразу — подтверждать удобнее по горячим следам.
  const u = req.tgUser!;
  const who = u.username ? `@${u.username}` : `${u.firstName} (id ${u.id})`;
  if (bot) {
    void bot.notifyPayment(
      `💵 Заявка #${p.id}\n${who} · ${p.plan} · ${p.months} мес.\n${p.amount} USDT (${p.network})\nHash: ${p.txHash}`,
      p.id,
    );
  }
  return { payment: toPaymentInfo(p) };
});

app.post('/api/billing/crypto/:id/cancel', async (req, reply) => {
  const { id } = req.params as { id: string };
  const ok = await billing.cancel(req.state!.userId, id);
  if (!ok) return reply.code(404).send({ error: 'not found' });
  return { ok: true };
});

// ---------------------------------------------------------------- алерты

const MAX_RULES_PER_USER = 50;

app.get('/api/alerts', async (req) => {
  const userId = req.state!.userId;
  return {
    rules: await repo.listAlertRules(userId),
    // Без доступа правила молчат — интерфейс показывает это явно.
    active: await billing.hasAccess(userId),
  };
});

app.post('/api/alerts', async (req, reply) => {
  const userId = req.state!.userId;
  const body = req.body as { type?: string; base?: string; thresholdPct?: number };
  const type = body?.type === 'global' ? 'global' : body?.type === 'pair' ? 'pair' : null;
  const threshold = Number(body?.thresholdPct);
  if (!type || !Number.isFinite(threshold) || threshold <= 0 || threshold > 100) {
    return reply.code(400).send({ error: 'type and thresholdPct required' });
  }
  const base =
    type === 'pair'
      ? String(body?.base ?? '')
          .trim()
          .toUpperCase()
      : null;
  if (type === 'pair' && !base) return reply.code(400).send({ error: 'base required' });
  const existing = await repo.listAlertRules(userId);
  if (existing.length >= MAX_RULES_PER_USER) {
    return reply.code(409).send({ error: 'too many rules', limit: MAX_RULES_PER_USER });
  }
  const rule = {
    id: randomUUID().slice(0, 8),
    userId,
    type,
    base,
    thresholdPct: Math.round(threshold * 100) / 100,
    isArmed: true,
    lastFiredAt: null,
    lastBase: null,
    createdAt: Date.now(),
  } as const;
  await repo.createAlertRule(rule);
  await alerts.reloadUser(userId);
  return { rule };
});

app.patch('/api/alerts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { thresholdPct?: number };
  const threshold = Number(body?.thresholdPct);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) {
    return reply.code(400).send({ error: 'thresholdPct required' });
  }
  const rule = await repo.updateAlertRule(req.state!.userId, id, Math.round(threshold * 100) / 100);
  if (!rule) return reply.code(404).send({ error: 'not found' });
  await alerts.reloadUser(req.state!.userId);
  return { rule };
});

app.delete('/api/alerts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const ok = await repo.deleteAlertRule(req.state!.userId, id);
  if (!ok) return reply.code(404).send({ error: 'not found' });
  await alerts.reloadUser(req.state!.userId);
  return { ok: true };
});

// ---------------------------------------------------------------- сверка ног (админ)

app.get('/api/admin/pairs', async (req, reply) => {
  if (!billing.isAdmin(req.state!.userId)) return reply.code(403).send({ error: 'admin only' });
  const q = req.query as { filter?: string; limit?: string };
  const filter = q.filter === 'verified' || q.filter === 'rejected' ? q.filter : 'anomalies';
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
  const all = pairs.list(filter);
  return { pairs: all.slice(0, limit), total: all.length, counts: pairs.counts() };
});

app.post('/api/admin/pairs/decide', async (req, reply) => {
  if (!billing.isAdmin(req.state!.userId)) return reply.code(403).send({ error: 'admin only' });
  const body = req.body as {
    exchangeA?: string;
    symbolA?: string;
    exchangeB?: string;
    symbolB?: string;
    status?: string;
    multiplier?: number;
  };
  const status = body?.status;
  if (status !== 'verified' && status !== 'rejected' && status !== 'candidate') {
    return reply.code(400).send({ error: 'bad status' });
  }
  if (!body.exchangeA || !body.symbolA || !body.exchangeB || !body.symbolB) {
    return reply.code(400).send({ error: 'pair required' });
  }
  const rec = await pairs.setStatus(
    {
      exchangeA: body.exchangeA as ExchangeId,
      symbolA: body.symbolA,
      exchangeB: body.exchangeB as ExchangeId,
      symbolB: body.symbolB,
    },
    status,
    body.multiplier !== undefined ? Number(body.multiplier) : undefined,
    `admin:${req.state!.userId}`,
  );
  if (!rec) return reply.code(404).send({ error: 'not found' });
  return { pair: rec, counts: pairs.counts() };
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

  const body = req.body as {
    apiKey?: string;
    secret?: string;
    passphrase?: string;
    label?: string;
  };
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
    return reply
      .code(422)
      .send({ error: check.error ?? 'key rejected', status: 'invalid' as const });
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
  bot?.stop();
  listings.stop();
  alerts.stop();
  collector.stop();
  fundingHistory.stop();
  history.close();
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
  bot = startBot({
    token: BOT_TOKEN,
    publicUrl: process.env.PUBLIC_URL,
    log: app.log,
    billing,
    repo,
    togglePaper,
    isPaper: (userId) => state.paperUsers.has(userId),
  });
  if (ADMIN_TELEGRAM_ID === null) {
    app.log.warn('ADMIN_TELEGRAM_ID не задан — админ-команды бота выключены');
  }
} else {
  app.log.warn('TELEGRAM_BOT_TOKEN не задан — бот не запущен');
}
