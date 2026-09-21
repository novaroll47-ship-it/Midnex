/**
 * HTTP-слой приложения.
 *
 * Рыночные данные — живые, с восьми бирж через @cs/market. Состояние каждого
 * пользователя (настройки, позиции, ключи, вотчлист, сессии) — в хранилище:
 * Postgres при заданном DATABASE_URL, иначе память процесса.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
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

import { BOT_IDS, type BotId } from '@cs/shared';
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
import { Billing, planTitle, toPaymentInfo } from './billing.js';
import { Partners } from './partners.js';
import { CryptoPay } from './cryptopay.js';
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
import { scheduleCpuProfile } from './diag.js';
import { HistoryCollector } from './history/collector.js';
import { VictoriaMetrics } from './history/victoria.js';
import { FUNDING_PERIODS, FundingHistory, type FundingPeriod } from './history/funding.js';
import { GapFiller } from './history/gapfill.js';
import { SqliteHistoryStore } from './history/sqlite.js';
import type { PairTimeframe, SpreadCandle, Timeframe } from './history/store.js';
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
/** Сколько строк скринера видно без подписки. */
const FREE_PREVIEW_ROWS = 3;

/** История спредов: файл SQLite рядом с процессом (см. history/). */
const HISTORY_DB_PATH =
  process.env.HISTORY_DB_PATH?.trim() || join(here, '../../../.data', 'history.sqlite');
const HISTORY_RAW_DAYS = Number(process.env.HISTORY_RAW_DAYS) || 7;
const HISTORY_MINUTE_DAYS = Number(process.env.HISTORY_MINUTE_DAYS) || 30;
const HISTORY_TICK_MIN_SPREAD = Number(process.env.HISTORY_TICK_MIN_SPREAD) || 0.5;
/** VictoriaMetrics для посекундного спреда (таймфрейм «1с»); retention — на её стороне. */
const VICTORIA_URL = (process.env.VICTORIA_URL?.trim() || 'http://127.0.0.1:8428').replace(/\/+$/, '');
/** Писать ли посекундно каждую сверенную пару бирж (≈14 тыс. серий), а не только лучшую по монете. */
const VICTORIA_WRITE_PAIRS = process.env.VICTORIA_WRITE_PAIRS !== '0';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const DEV_FAKE_USER = process.env.DEV_FAKE_USER === '1';
const IS_PROD = process.env.NODE_ENV === 'production';

if (DEV_FAKE_USER && IS_PROD) {
  throw new Error('DEV_FAKE_USER=1 недопустим при NODE_ENV=production — это обход авторизации');
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL?.trim() || 'info' } });

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
// @CryptoBot: токен приложения из .env; CRYPTOPAY_TESTNET=1 — тестовая сеть.
const CRYPTOPAY_TOKEN = process.env.CRYPTOPAY_TOKEN?.trim() ?? '';
const CRYPTOPAY_WEBHOOK_SECRET = process.env.CRYPTOPAY_WEBHOOK_SECRET?.trim() ?? '';
const cryptoPay = CRYPTOPAY_TOKEN
  ? new CryptoPay(CRYPTOPAY_TOKEN, process.env.CRYPTOPAY_TESTNET === '1', app.log)
  : null;

// Партнёрская программа: закрепление по ссылке, начисления при оплате,
// удержание → доступно к выплате раз в час.
const partners = new Partners({ repo, log: app.log });
setInterval(() => {
  void partners.release().catch((err: unknown) => {
    app.log.warn({ err: String(err) }, 'партнёрка: снятие удержания не удалось');
  });
}, 60 * 60 * 1000);

const billing = new Billing({
  repo,
  log: app.log,
  botToken: BOT_TOKEN || undefined,
  adminId: ADMIN_TELEGRAM_ID,
  starsPerUsd: STARS_PER_USD,
  trading: TRADING_ENABLED,
  partners,
  cryptoPay,
  publicUrl: process.env.PUBLIC_URL,
});
if (cryptoPay) {
  cryptoPay
    .getMe()
    .then((me) =>
      app.log.info(`CryptoBot: приложение «${me.name}»${cryptoPay.isTestnet ? ' (testnet)' : ''}`),
    )
    .catch((err: unknown) => app.log.error({ err: String(err) }, 'CryptoBot: токен не принят'));
  if (!CRYPTOPAY_WEBHOOK_SECRET)
    app.log.warn('CRYPTOPAY_WEBHOOK_SECRET не задан — вебхук выключен, только опрос');
  // Запасной опрос раз в 3 минуты — на случай пропущенного вебхука.
  setInterval(() => {
    void billing.pollCryptoBot().catch((err: unknown) => {
      app.log.warn({ err: String(err) }, 'CryptoBot: опрос не удался');
    });
  }, 180_000);
}
let bot: BotHandle | null = null;

// Сверка пар: таблица из базы → движок; новые рынки → пары-кандидаты;
// раз в минуту — автосверка по ценам и CoinGecko.
const externalTickers = new ExternalTickers(
  join(dirname(HISTORY_DB_PATH), 'external-tickers.json'),
  app.log,
);
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
if (state.paperUsers.size)
  app.log.info(`бумажная торговля включена для: ${[...state.paperUsers].join(', ')}`);
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
const victoria = new VictoriaMetrics(
  VICTORIA_URL,
  VICTORIA_WRITE_PAIRS,
  app.log,
  process.env.VICTORIA_WRITE !== '0',
);
// CPU_PROFILE="60,30" — снять профиль в .tools (см. diag.ts).
scheduleCpuProfile(process.env.CPU_PROFILE, join(here, '../../../.tools'), app.log);
const collector = new HistoryCollector({
  victoria,
  store: history,
  market,
  log: app.log,
  tickMinSpreadPct: HISTORY_TICK_MIN_SPREAD,
  rawDays: HISTORY_RAW_DAYS,
  minuteDays: HISTORY_MINUTE_DAYS,
});
victoria.start();
if (market.mode === 'live') collector.start();
else {
  // В моке посекундный спред тоже пишется — чтобы график «1с» можно было
  // разрабатывать без бирж (в SQLite при этом ничего не пишется).
  setInterval(() => victoria.write(Date.now(), market.snapshot(0).rows, []), 1000).unref();
}
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

// Дыры в истории (перезапуски, обрывы) закрываются часовыми свечами бирж.
const gapFiller = new GapFiller({ store: history, engine: market.engine, log: app.log });
if (market.mode === 'live') gapFiller.start();

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

// JSON разбираем сами, сохраняя сырое тело: вебхуку CryptoBot нужна подпись
// именно по байтам, а не по пересобранному объекту.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
  if (!body || (body as string).length === 0) return done(null, {});
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
  }
});

app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.url.startsWith('/api/')) return;
  // Логотипы браузер тянет тегом <img>, а он не умеет слать заголовок с
  // подписью Telegram. Ничего чувствительного там нет, поэтому пускаем без неё.
  if (req.url.startsWith('/api/health') || req.url.startsWith('/api/icon/')) return;
  // Вебхук CryptoBot приходит без Telegram-подписи: его защищает секретный путь и HMAC тела.
  if (req.url.startsWith('/api/cryptopay/webhook/')) return;

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

  // Прямая ссылка на приложение с партнёрским кодом: закрепляем до того, как
  // state.forUser заведёт пользователя — иначе он уже «зарегистрирован».
  const partnerCode = Partners.codeFromStart(user.startParam);
  if (partnerCode) {
    try {
      const isNew = !(await repo.getUser(user.id));
      const r = await partners.attribute(user.id, partnerCode, isNew);
      req.log.info({ user: user.id, code: partnerCode, result: r }, 'партнёрка: переход по ссылке');
    } catch (err) {
      req.log.warn({ err: String(err) }, 'партнёрка: закрепление не удалось');
    }
  }

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
  eventLoopMs: eventLoopLag(),
  books: market.engine?.booksStats() ?? null,
}));

// Задержка event loop за последнюю минуту: сколько миллисекунд таймеры
// ждали своей очереди. Если p99 уходит за секунду — сборщик пропускает
// секунды, и это видно на графике «1с».
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
setInterval(() => loopDelay.reset(), 60_000).unref();
function eventLoopLag() {
  const ms = (n: number) => Math.round(n / 1e6);
  return { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) };
}

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
  const q = req.query as { venues?: string };
  const valid = new Set(EXCHANGES.map((e) => e.id as string));
  const venues = (q.venues ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is ExchangeId => valid.has(v));
  const detail = market.coinDetail(base, venues.length >= 2 ? venues : undefined);
  if (!detail) return reply.code(404).send({ error: 'not found' });
  // Пока монету смотрят — держим глубокие стаканы по её ногам.
  market.engine?.watchDeep(detail.base);
  return { ...detail, pairs: market.engine?.pairsOf(detail.base) ?? [] };
});

/**
 * Ликвидность: спред и прибыль на объёме пользователя, рекомендуемый объём,
 * кривая «объём → прибыль». Объём — из запроса, иначе из настроек.
 */
app.get('/api/coin/:base/liquidity', async (req, reply) => {
  if (!(await billing.hasAccess(req.state!.userId))) {
    return reply.code(402).send({ error: 'subscription required' });
  }
  const { base } = req.params as { base: string };
  const q = req.query as { volume?: string; exA?: string; exB?: string; venues?: string };
  const engine = market.engine;
  if (!engine || market.mode !== 'live') return reply.code(503).send({ error: 'books unavailable' });
  const valid = new Set(EXCHANGES.map((e) => e.id as string));
  const venues = (q.venues ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is ExchangeId => valid.has(v));
  const pair =
    q.exA && q.exB && valid.has(q.exA) && valid.has(q.exB) && q.exA !== q.exB
      ? { exA: q.exA as ExchangeId, exB: q.exB as ExchangeId }
      : undefined;
  const volume = Number(q.volume) || req.state!.settings.ui.volumeUsdt || 1000;
  engine.watchDeep(base.toUpperCase());
  const detail = engine.liquidityDetail(base, volume, pair, venues.length >= 2 ? venues : undefined);
  if (!detail) return reply.code(404).send({ error: 'no books yet' });
  return detail;
});

// ---------------------------------------------------------------- история спредов

const HOUR = 3_600_000;

/**
 * Свечи спреда по монете. Пара бирж внутри минуты могла меняться, поэтому
 * на каждый момент отдаём лучшую (по максимуму) свечу — так график монеты
 * показывает «какой спред был доступен», а не историю одной пары.
 */
function coinCandles(canonical: string, tf: Timeframe, from: number, to: number): SpreadCandle[] {
  const tfMs = tf === '1m' ? 60_000 : tf === '5m' ? 300_000 : HOUR;
  const all = history.queryCandles(canonical, tf, from, to);
  const best = new Map<number, SpreadCandle>();
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
  let candles = [...best.values()].sort((a, b) => a.ts - b.ts);
  // Дыры (процесс не работал) на 1m/5m закрываем часовыми свечами: каждый
  // час без единой мелкой свечи получает часовую (живую или восстановленную
  // по свечам бирж). Помечаем реконструкцией — на графике пунктир.
  if (tf !== '1h') {
    const hourFrom = Math.floor(from / HOUR) * HOUR;
    const hourly = history.queryCandles(canonical, '1h', hourFrom, to);
    const bestHour = new Map<number, SpreadCandle>();
    for (const c of hourly) {
      const cur = bestHour.get(c.ts);
      if (!cur || c.high > cur.high) bestHour.set(c.ts, c);
    }
    const covered = new Set<number>();
    for (const c of candles) covered.add(Math.floor(c.ts / HOUR) * HOUR);
    let missingHours = 0;
    const filled = [...candles];
    for (let h = hourFrom; h + HOUR <= to; h += HOUR) {
      if (covered.has(h)) continue;
      const hc = bestHour.get(h);
      if (hc) filled.push({ ...hc, source: 'reconstructed' });
      else missingHours++;
    }
    candles = filled.sort((a, b) => a.ts - b.ts);
    // Часов без данных вообще — попросим дозаполнение по этой монете, не дожидаясь получаса.
    if (missingHours > 0) gapFiller.fillBase(canonical);
  } else {
    const have = new Set(candles.map((c) => c.ts));
    let missing = 0;
    for (let h = Math.floor(from / HOUR) * HOUR; h + HOUR <= to; h += HOUR)
      if (!have.has(h)) missing++;
    if (missing > 0) gapFiller.fillBase(canonical);
  }
  return candles;
}

/** Свечи по конкретной паре бирж: свои таблицы (15m/1h) и незакрытая свеча. */
function pairCandles(
  canonical: string,
  exA: ExchangeId,
  exB: ExchangeId,
  tf: PairTimeframe,
  from: number,
  to: number,
): SpreadCandle[] {
  const candles = history.queryPairCandles(canonical, exA, exB, tf, from, to);
  const partial = collector.currentPair(canonical, exA, exB, tf);
  if (partial && !candles.some((c) => c.ts === partial.ts)) candles.push(partial);
  // Часы без 15-минутных свечей закрываем часовыми по той же паре.
  if (tf === '15m') {
    const hourFrom = Math.floor(from / HOUR) * HOUR;
    const hourly = history.queryPairCandles(canonical, exA, exB, '1h', hourFrom, to);
    const covered = new Set(candles.map((c) => Math.floor(c.ts / HOUR) * HOUR));
    let missing = 0;
    for (let h = hourFrom; h + HOUR <= to; h += HOUR) {
      if (covered.has(h)) continue;
      const hc = hourly.find((c) => c.ts === h);
      if (hc) candles.push({ ...hc, source: 'reconstructed' });
      else missing++;
    }
    if (missing > 0) gapFiller.fillBase(canonical);
  }
  return candles.sort((a, b) => a.ts - b.ts);
}

/**
 * Укрупнение свечей: 5m → 15m, 1h → 1d. Сутки — по местному времени
 * клиента (`tzOffsetMin` как `getTimezoneOffset()`), чтобы дневная свеча
 * начиналась в полночь пользователя, а не UTC.
 */
function aggregateCandles(rows: SpreadCandle[], bucketMs: number, tzOffsetMin = 0): SpreadCandle[] {
  const shift = tzOffsetMin * 60_000;
  const out = new Map<number, SpreadCandle>();
  for (const c of rows) {
    const key = Math.floor((c.ts - shift) / bucketMs) * bucketMs + shift;
    const cur = out.get(key);
    if (!cur) out.set(key, { ...c, ts: key });
    else {
      if (c.high > cur.high) {
        cur.high = c.high;
        cur.exA = c.exA;
        cur.exB = c.exB;
      }
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.samples += c.samples;
      if (c.source === 'live') cur.source = 'live';
    }
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

const CHART_TFS = ['1s', '1m', '5m', '15m', '1h', '1d'] as const;
type ChartTf = (typeof CHART_TFS)[number];
const CHART_TF_MS: Record<ChartTf, number> = {
  '1s': 1000,
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': HOUR,
  '1d': 86_400_000,
};

/**
 * История спреда для графика: по монете (лучшая пара) или по конкретной
 * паре бирж. Таймфреймы: 1s — из посекундного буфера (поле `series`),
 * 1m/5m/1h — свечи из базы, 15m — из 5m (по паре — свои 15m), 1d — из 1h.
 */
app.get('/api/history/:base', async (req, reply) => {
  if (!(await billing.hasAccess(req.state!.userId))) {
    return reply.code(402).send({ error: 'subscription required' });
  }
  const { base } = req.params as { base: string };
  const q = req.query as {
    tf?: string;
    from?: string;
    to?: string;
    exA?: string;
    exB?: string;
    tz?: string;
  };
  const canonical = base.toUpperCase();
  let tf = (CHART_TFS.includes(q.tf as ChartTf) ? q.tf : '1m') as ChartTf;
  if (q.exA && q.exB && tf === '5m') tf = '15m';
  const tfMs = CHART_TF_MS[tf];
  const tz = Number(q.tz) || 0;
  const to = Number(q.to) || Date.now();
  const spanDefault =
    tf === '1s'
      ? 30 * 60_000
      : tf === '1m'
        ? 6 * HOUR
        : tf === '5m' || tf === '15m'
          ? 2 * 86_400_000
          : 30 * 86_400_000;
  const from = Number(q.from) || to - spanDefault;

  let pair: { exA: ExchangeId; exB: ExchangeId } | undefined;
  if (q.exA && q.exB) {
    const valid = new Set(EXCHANGES.map((e) => e.id as string));
    if (!valid.has(q.exA) || !valid.has(q.exB) || q.exA === q.exB) {
      return reply.code(400).send({ error: 'bad pair' });
    }
    const [exA, exB] = ([q.exA, q.exB] as ExchangeId[]).sort() as [ExchangeId, ExchangeId];
    pair = { exA, exB };
  }

  if (tf === '1s') {
    const series = await victoria.querySeconds(canonical, from, to, pair);
    return { base: canonical, tf, tfMs, from, to, ...pair, candles: [], series };
  }

  let candles: SpreadCandle[];
  if (pair) {
    // Последние семь дней — из посекундных точек VictoriaMetrics (полные
    // свечи, ничего не теряется при перезапусках), старше — из SQLite.
    const { exA, exB } = pair;
    const srcTf: '1m' | '15m' | '1h' = tf === '1d' || tf === '1h' ? '1h' : tf === '15m' ? '15m' : '1m';
    const srcMs = CHART_TF_MS[srcTf];
    const vmFrom = Math.max(from, Date.now() - 7 * 86_400_000);
    const vm = vmFrom < to ? await victoria.queryCandles(canonical, pair, srcMs, vmFrom, to) : [];
    const older = srcTf === '1m' ? [] : pairCandles(canonical, exA, exB, srcTf, from, to);
    // VM недоступна — показываем то, что есть в SQLite, за весь интервал.
    const cutoff = vm.length > 0 ? vmFrom : Infinity;
    candles = [...older.filter((c) => c.ts < cutoff), ...vm];
    if (tf === '1d') candles = aggregateCandles(candles, tfMs, tz);
  } else if (tf === '1d') {
    candles = aggregateCandles(coinCandles(canonical, '1h', from, to), tfMs, tz);
  } else if (tf === '15m') {
    candles = aggregateCandles(coinCandles(canonical, '5m', from, to), tfMs);
  } else {
    candles = coinCandles(canonical, tf, from, to);
  }
  return { base: canonical, tf, tfMs, from, to, ...pair, candles };
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

const watchlistPayload = (w: Map<string, BotId[]>) => ({
  bases: [...w.keys()],
  bots: Object.fromEntries(w),
});

app.get('/api/watchlist', async (req) => watchlistPayload(req.state!.watchlist));

/** Какие боты ведут монету; пустой список — убрать монету из списка. */
app.patch('/api/watchlist/:base', async (req, reply) => {
  const base = (req.params as { base: string }).base.toUpperCase();
  const body = req.body as { bots?: unknown };
  if (!Array.isArray(body?.bots) || !body.bots.every((b) => (BOT_IDS as readonly string[]).includes(String(b)))) {
    return reply.code(400).send({ error: 'bots[] required' });
  }
  const bots = [...new Set(body.bots as BotId[])];
  const s = req.state!;
  const limit = TRADING_ENABLED ? (PLAN_WATCHLIST_LIMIT[s.plan] ?? null) : null;
  if (bots.length > 0 && !s.watchlist.has(base) && limit !== null && s.watchlist.size >= limit) {
    return reply.code(409).send({ error: 'watchlist limit', limit });
  }
  await state.setWatchBots(s, base, bots);
  return watchlistPayload(s.watchlist);
});

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
  return watchlistPayload(req.state!.watchlist);
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
  if (body['mode'] !== undefined && body['mode'] !== 'semi' && body['mode'] !== 'auto')
    delete body['mode'];
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
  const body = req.body as { view?: unknown; volumeUsdt?: unknown };
  const next = { ...s.settings.ui };
  if (body?.view !== undefined) {
    if (body.view !== 'list' && body.view !== 'cards') return reply.code(400).send({ error: 'bad view' });
    next.view = body.view;
  }
  if (body?.volumeUsdt !== undefined) {
    const v = Number(body.volumeUsdt);
    if (!Number.isFinite(v) || v < 10 || v > 10_000_000) return reply.code(400).send({ error: 'bad volume' });
    next.volumeUsdt = Math.round(v);
  }
  s.settings.ui = next;
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
    purchasable: purchasablePlans(TRADING_ENABLED),
    starsPerUsd: STARS_PER_USD,
    starsAvailable: Boolean(BOT_TOKEN),
    cryptoBotAvailable: billing.cryptoBotAvailable,
    // Подарок за переход по партнёрской ссылке — к первой оплате. Пока
    // миграция партнёрки не применена, экран подписки не должен падать.
    bonusDays: await partners.bonusDaysFor(userId).catch((err: unknown) => {
      req.log.warn({ err: String(err) }, 'партнёрка: бонус не посчитан');
      return 0;
    }),
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

app.post('/api/billing/cryptobot', async (req, reply) => {
  const body = req.body as { plan?: string; months?: number };
  const r = await billing.createCryptoBotInvoice(
    req.state!.userId,
    String(body?.plan ?? ''),
    Number(body?.months),
  );
  if ('error' in r) return reply.code(400).send({ error: r.error });
  return { payUrl: r.payUrl, botUrl: r.botUrl, payment: toPaymentInfo(r.payment) };
});

/** Статус заявки — мини-приложение опрашивает после открытия счёта. */
app.get('/api/billing/payment/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const p = await repo.getPayment(id);
  if (!p || p.userId !== req.state!.userId) return reply.code(404).send({ error: 'not found' });
  return { payment: toPaymentInfo(p), subscription: await billing.info(p.userId) };
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

// ---------------------------------------------------------------- CryptoBot webhook

/**
 * invoice_paid от @CryptoBot. Секретный путь + подпись HMAC тела. Обработка
 * идемпотентна: повторный вебхук об уже закрытом счёте — просто 200.
 */
app.post('/api/cryptopay/webhook/:secret', async (req, reply) => {
  const { secret } = req.params as { secret: string };
  if (!cryptoPay || !CRYPTOPAY_WEBHOOK_SECRET || secret !== CRYPTOPAY_WEBHOOK_SECRET) {
    return reply.code(404).send({ error: 'not found' });
  }
  const raw =
    (req as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
  const signature = req.headers['crypto-pay-api-signature'];
  if (!cryptoPay.verifySignature(raw, typeof signature === 'string' ? signature : undefined)) {
    req.log.warn('CryptoBot: подпись вебхука не сошлась');
    return reply.code(403).send({ error: 'bad signature' });
  }
  const inv = cryptoPay.parseWebhook(req.body);
  if (inv) {
    const sub = await billing.cryptoBotPaid(inv.invoiceId, inv.amount, inv.asset);
    if (sub && bot) {
      void bot.send(
        sub.userId,
        `✅ Оплата получена: ${planTitle(sub.plan)} до ${new Date(sub.expiresAt).toLocaleDateString('ru-RU')}. Спасибо!`,
      );
    }
  }
  return { ok: true };
});

// ---------------------------------------------------------------- сверка ног (админ)

app.get('/api/admin/pairs', async (req, reply) => {
  if (!billing.isAdmin(req.state!.userId)) return reply.code(403).send({ error: 'admin only' });
  const q = req.query as { filter?: string; limit?: string };
  const filter =
    q.filter === 'verified' || q.filter === 'rejected' || q.filter === 'pending'
      ? q.filter
      : 'anomalies';
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
  const all = pairs.list(filter);
  return { pairs: all.slice(0, limit), total: all.length, counts: pairs.counts() };
});

/** Решение по инструменту: номинал (factor > 0) или отклонение (factor = 0) — закрывает все его пары. */
app.post('/api/admin/pairs/leg', async (req, reply) => {
  if (!billing.isAdmin(req.state!.userId)) return reply.code(403).send({ error: 'admin only' });
  const body = req.body as { exchange?: string; symbol?: string; factor?: number };
  const valid = new Set(EXCHANGES.map((e) => e.id as string));
  if (!body?.exchange || !valid.has(body.exchange) || !body.symbol) {
    return reply.code(400).send({ error: 'leg required' });
  }
  const factor = Number(body.factor);
  if (!Number.isFinite(factor) || factor < 0) return reply.code(400).send({ error: 'bad factor' });
  await pairs.setLegNominal(
    body.exchange as ExchangeId,
    body.symbol,
    factor,
    `admin:${req.state!.userId}`,
  );
  return { ok: true, counts: pairs.counts() };
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
  victoria.stop();
  fundingHistory.stop();
  history.close();
  await market.stop();
  await repo.close();
});

// Страховка: необработанный отказ промиса (обычно сетевой сбой в фоновой
// задаче) не должен ронять процесс с восемью биржами и ботом.
process.on('unhandledRejection', (err) => {
  app.log.error({ err: String(err).slice(0, 300) }, 'необработанный отказ промиса');
});

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(
  `API на http://localhost:${PORT} | хранилище: ${repo.kind} | dev-байпас авторизации: ${DEV_FAKE_USER ? 'ВКЛ' : 'выкл'}`,
);

// Бот живёт в этом же процессе: пока нагрузка — одно long-polling соединение,
// отдельный сервис только добавил бы точку отказа.
// BOT_DISABLED=1 — для dev-экземпляра рядом с продом: два опроса одного
// токена конфликтуют (Telegram отдаёт 409), и прод-бот замолкает.
if (BOT_TOKEN && process.env.BOT_DISABLED !== '1') {
  bot = startBot({
    token: BOT_TOKEN,
    publicUrl: process.env.PUBLIC_URL,
    log: app.log,
    billing,
    repo,
    partners,
    togglePaper,
    isPaper: (userId) => state.paperUsers.has(userId),
  });
  if (ADMIN_TELEGRAM_ID === null) {
    app.log.warn('ADMIN_TELEGRAM_ID не задан — админ-команды бота выключены');
  }
} else {
  app.log.warn('TELEGRAM_BOT_TOKEN не задан — бот не запущен');
}
