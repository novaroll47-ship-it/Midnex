/**
 * Телеграм-бот.
 *
 * Мини-приложение — это только половина продукта. Вторая половина — сам бот:
 * без него пользователь жмёт «Запустить», не получает ничего и делает вывод,
 * что всё сломано. Здесь бот отвечает на /start сообщением с кнопкой,
 * открывающей приложение, и сам держит кнопку меню в актуальном состоянии.
 *
 * На M5 сюда же приедут уведомления из ТЗ §11 (найден спред, открыта или
 * закрыта позиция, сработал риск-лимит) — отправлять их надо тем же способом.
 */
import type { FastifyBaseLogger } from 'fastify';
import { PLAN_ORDER, REFERRAL_BONUS_DAYS, type PlanId } from '@cs/shared';

import { planTitle, type Billing } from './billing.js';
import { PAUSE_GRACE_DAYS, Partners, anomaly, fmtUsd, termsText } from './partners.js';
import type { PartnerRecord, PartnerStats, PartnerTerms, Repo } from './repo/index.js';

const API = 'https://api.telegram.org';

/** Канал проекта: анонсы, разборы спредов, новости о ботах. */
export const CHANNEL_URL = 'https://t.me/midnexio';

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; first_name: string; username?: string };
    successful_payment?: {
      currency: string;
      total_amount: number;
      invoice_payload: string;
      telegram_payment_charge_id: string;
    };
  };
  pre_checkout_query?: {
    id: string;
    from: { id: number };
    currency: string;
    total_amount: number;
    invoice_payload: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

type Keyboard = { text: string; callback_data: string }[][];

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface BotOptions {
  token: string;
  /** Публичный HTTPS-адрес приложения. Без него кнопку показать нельзя. */
  publicUrl?: string;
  log: FastifyBaseLogger;
  billing: Billing;
  repo: Repo;
  partners: Partners;
  /** Переключить «бумажную торговлю» для пользователя; возвращает новое состояние. */
  togglePaper?: (userId: number) => Promise<boolean>;
  isPaper?: (userId: number) => boolean;
}

/** Что бот умеет наружу: слать сообщения из API и останавливаться. */
export interface BotHandle {
  send(chatId: number, text: string, extra?: Record<string, unknown>): Promise<boolean>;
  stop(): void;
}

async function call<T>(
  token: string,
  method: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<TgResponse<T>> {
  // Без таймаута обрыв сети превращается в вечно висящий запрос. Сетевую
  // ошибку не бросаем, а отдаём как неудачный ответ: вызовы вроде
  // `void bot.send(...)` иначе роняли процесс необработанным отказом, когда
  // пропадал интернет.
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await res.json()) as TgResponse<T>;
  } catch (err) {
    return { ok: false, description: `network: ${String(err).slice(0, 160)}` } as TgResponse<T>;
  }
}

/**
 * Адрес приложения. Если его не передали через окружение, спрашиваем у самого
 * Telegram — кнопку меню ставит скрипт запуска, и там всегда актуальный адрес.
 * Так адрес живёт в одном месте, а не в двух рассинхронизированных.
 */
async function resolveAppUrl(token: string, fallback?: string): Promise<string | undefined> {
  if (fallback) return fallback;
  const res = await call<{ type: string; web_app?: { url: string } }>(token, 'getChatMenuButton');
  return res.result?.web_app?.url;
}

function greeting(appUrl: string | undefined, name: string, referred: boolean): string {
  if (!appUrl) {
    return (
      `Привет, ${name}.\n\n` +
      'Приложение сейчас недоступно — адрес не настроен. ' +
      'Попробуй позже.'
    );
  }
  return (
    `Привет, ${name}.\n\n` +
    'MIDNEX — скринер спредов: в реальном времени сравнивает цены фьючерсов ' +
    'на восьми биржах и показывает, где одну и ту же монету можно купить дешевле ' +
    'и продать дороже — уже за вычетом комиссий.\n\n' +
    'Первая неделя — бесплатно, без карты и без ограничений.\n\n' +
    (referred
      ? 'Ты пришёл по ссылке партнёра: +7 дней в подарок к первой оплаченной подписке.\n\n'
      : '') +
    'Автоматическая торговля по этим спредам — в разработке.\n\n' +
    `Новости и разборы — в канале ${CHANNEL_URL}\n\n` +
    'Нажми кнопку ниже, чтобы открыть скринер.'
  );
}

export function startBot(opts: BotOptions): BotHandle {
  const { token, publicUrl, log, billing, repo, partners } = opts;
  let offset = 0;
  let stopped = false;
  let botUsername = '';

  async function send(
    chatId: number,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    const res = await call(token, 'sendMessage', { chat_id: chatId, text, ...extra });
    if (!res.ok) {
      log.warn({ chatId, description: res.description }, 'бот: сообщение не ушло');
    }
    return res.ok;
  }

  async function notifyAdmin(text: string): Promise<void> {
    if (billing.adminId !== null) await send(billing.adminId, text);
  }

  // ---------------------------------------------------------------- админка

  /**
   * Панель администратора живёт на кнопках: меню, действия с вводом (выдать,
   * отозвать, статус, отметить выплату) — бот задаёт вопрос и ждёт следующее
   * сообщение. Текстовые команды тоже работают.
   */
  type Awaiting =
    | 'grant'
    | 'revoke'
    | 'sub'
    | 'padd'
    | 'pdef'
    | 'pmin'
    | `pset:${string}`
    | `paid:${string}`
    | null;
  let awaiting: Awaiting = null;

  const MENU: Keyboard = [
    [
      { text: '👥 Пользователи', callback_data: 'adm:users' },
      { text: '🔎 Статус подписки', callback_data: 'adm:sub' },
    ],
    [
      { text: '➕ Выдать доступ', callback_data: 'adm:grant' },
      { text: '🚫 Отозвать', callback_data: 'adm:revoke' },
    ],
    [{ text: '🤝 Партнёры', callback_data: 'adm:partners' }],
    [
      { text: '💸 Выплаты партнёрам', callback_data: 'adm:payouts' },
      { text: '⚙️ Настройки партнёрки', callback_data: 'adm:pcfg' },
    ],
    [{ text: '🧪 Бумажная торговля: вкл/выкл для меня', callback_data: 'adm:paper' }],
  ];
  const BACK: Keyboard = [[{ text: '← Меню', callback_data: 'adm:menu' }]];
  const CANCEL: Keyboard = [[{ text: 'Отмена', callback_data: 'adm:menu' }]];
  const TO_PARTNERS: Keyboard = [
    [
      { text: '← Партнёры', callback_data: 'adm:partners' },
      { text: '← Меню', callback_data: 'adm:menu' },
    ],
  ];

  function kb(inline_keyboard: Keyboard): Record<string, unknown> {
    return { reply_markup: { inline_keyboard } };
  }

  async function resolveUserId(arg: string): Promise<number | null> {
    if (/^\d+$/.test(arg)) return Number(arg);
    const u = await repo.findUserByUsername(arg);
    return u?.id ?? null;
  }

  async function showMenu(chatId: number): Promise<void> {
    awaiting = null;
    const [users, active] = await Promise.all([repo.countUsers(), repo.countActiveSubscriptions()]);
    // Партнёрка может быть ещё не развёрнута (миграция) — меню всё равно показываем.
    let partnersLine: string;
    try {
      const list = await partners.list();
      const min = await partners.minPayout();
      const payable = list.filter((x) => x.stats.available >= min);
      const due = payable.reduce((sum, x) => sum + x.stats.available, 0);
      partnersLine =
        `Партнёров: ${list.length}` +
        (payable.length ? ` · к выплате ${payable.length} на ${fmtUsd(due)}` : '');
    } catch (err) {
      partnersLine = adminError(err);
    }
    await send(
      chatId,
      `Панель администратора\n\nПользователей: ${users}\nАктивных подписок: ${active}\n${partnersLine}`,
      kb(MENU),
    );
  }

  // ---------------------------------------------------------------- партнёры (админ)

  const PARTNER_HELP =
    'Текстовые команды (дубль кнопок):\n' +
    '/partner_add @user код [процент месяцев дней_закрепления дней_удержания] — создать\n' +
    '/partner_set код процент месяцев [дней_закрепления дней_удержания] — изменить условия (только будущие начисления)\n' +
    '/partner_pause код · /partner_resume код — пауза / возобновить\n' +
    '/partner_defaults [процент месяцев дней_закрепления дней_удержания] — условия по умолчанию\n' +
    '/payouts — кому платить · /paid код [ссылка на перевод] — отметить выплату\n' +
    '/min_payout сумма — минимальная выплата';

  function partnerLine(p: PartnerRecord, s: PartnerStats): string {
    const flag = anomaly(s);
    return (
      `${p.status === 'paused' ? '⏸ ' : ''}${p.code} · ${termsText(p)}\n` +
      `  переходов ${s.clicks} · пробных ${s.trials} · оплатили ${s.paidUsers}` +
      ` · за 30 дн: ${s.clicks30d}/${s.paidUsers30d}\n` +
      `  удержание ${fmtUsd(s.onHold)} · к выплате ${fmtUsd(s.available)} · выплачено ${fmtUsd(s.paid)}` +
      (flag ? `\n  ⚠ ${flag}` : '')
    );
  }

  /** Список партнёров: каждая строка — кнопка с карточкой партнёра. */
  async function showPartners(chatId: number): Promise<void> {
    awaiting = null;
    const list = await partners.list();
    const rows: Keyboard = list.map(({ partner, stats }) => [
      {
        text:
          `${partner.status === 'paused' ? '⏸ ' : ''}${partner.code} · ` +
          `${stats.paidUsers} опл. · к выплате ${fmtUsd(stats.available)}` +
          (anomaly(stats) ? ' ⚠' : ''),
        callback_data: `ptn:${partner.code}`,
      },
    ]);
    rows.push([{ text: '➕ Добавить партнёра', callback_data: 'adm:padd' }]);
    rows.push([
      { text: '⚙️ Настройки партнёрки', callback_data: 'adm:pcfg' },
      { text: '← Меню', callback_data: 'adm:menu' },
    ]);
    const paused = list.filter((x) => x.partner.status === 'paused').length;
    const total = list.reduce(
      (acc, x) => ({
        clicks: acc.clicks + x.stats.clicks,
        paid: acc.paid + x.stats.paidUsers,
        due: acc.due + x.stats.available,
        hold: acc.hold + x.stats.onHold,
      }),
      { clicks: 0, paid: 0, due: 0, hold: 0 },
    );
    await send(
      chatId,
      list.length === 0
        ? 'Партнёров пока нет. Нажми «Добавить партнёра».'
        : `Партнёров: ${list.length}${paused ? ` (на паузе ${paused})` : ''}\n` +
            `Переходов: ${total.clicks} · оплатили: ${total.paid}\n` +
            `На удержании: ${fmtUsd(total.hold)} · к выплате: ${fmtUsd(total.due)}\n\n` +
            'Нажми на партнёра — карточка с условиями и действиями.',
      kb(rows),
    );
  }

  /** Карточка партнёра: статистика и все действия кнопками. */
  async function showPartnerCard(chatId: number, code: string): Promise<void> {
    awaiting = null;
    const partner = await partners.byCode(code);
    if (!partner) return void (await send(chatId, `Партнёр ${code} не найден.`, kb(TO_PARTNERS)));
    const stats = await partners.stats(partner);
    const u = await repo.getUser(partner.telegramId);
    const who = u?.username ? `@${u.username}` : `id ${partner.telegramId}`;
    const text =
      `🤝 ${partner.code} — ${who}${partner.status === 'paused' ? ' · ⏸ на паузе' : ''}\n` +
      `Условия: ${termsText(partner)}\n` +
      `Закрепление ${partner.attributionDays} дн. · удержание ${partner.holdDays} дн.\n` +
      `Ссылка: ${partnerLink(partner)}\n\n` +
      partnerLine(partner, stats).split('\n').slice(1).join('\n');
    const rows: Keyboard = [
      [
        { text: '✏️ Условия', callback_data: `pte:${partner.code}` },
        { text: '📅 По месяцам', callback_data: `ptm:${partner.code}` },
      ],
      [
        partner.status === 'paused'
          ? { text: '▶️ Возобновить', callback_data: `ptv:${partner.code}` }
          : { text: '⏸ Пауза', callback_data: `ptz:${partner.code}` },
        { text: '🔗 Прислать ссылку партнёру', callback_data: `ptl:${partner.code}` },
      ],
    ];
    if (stats.available > 0)
      rows.push([
        {
          text: `💸 Отметить выплату ${fmtUsd(stats.available)}`,
          callback_data: `ptp:${partner.code}`,
        },
      ]);
    rows.push(...TO_PARTNERS);
    await send(chatId, text, kb(rows));
  }

  /** Настройки программы: условия по умолчанию, минимальная выплата, константы. */
  async function showPartnerConfig(chatId: number): Promise<void> {
    awaiting = null;
    const d = await partners.defaults();
    await send(
      chatId,
      '⚙️ Настройки партнёрской программы\n\n' +
        `Условия по умолчанию (для новых партнёров):\n  ${termsText(d)}\n` +
        `  закрепление ${d.attributionDays} дн. · удержание ${d.holdDays} дн.\n` +
        `Минимальная выплата: ${fmtUsd(await partners.minPayout())}\n\n` +
        `Зашито в код: +${REFERRAL_BONUS_DAYS} дней пользователю к первой оплате, ` +
        `после паузы партнёра начисления за старых — ещё ${PAUSE_GRACE_DAYS} дн., ` +
        'напоминание о выплатах — 1-го числа.',
      kb([
        [{ text: '✏️ Условия по умолчанию', callback_data: 'adm:pdef' }],
        [{ text: '💵 Минимальная выплата', callback_data: 'adm:pmin' }],
        [
          { text: '← Партнёры', callback_data: 'adm:partners' },
          { text: '← Меню', callback_data: 'adm:menu' },
        ],
      ]),
    );
  }

  async function showPayouts(chatId: number): Promise<void> {
    const list = await partners.payable();
    if (list.length === 0) {
      await send(
        chatId,
        `К выплате никого нет (минимум ${fmtUsd(await partners.minPayout())}).`,
        kb(BACK),
      );
      return;
    }
    for (const { partner, stats } of list) {
      const u = await repo.getUser(partner.telegramId);
      const who = u?.username ? `@${u.username}` : `id ${partner.telegramId}`;
      await send(
        chatId,
        `${partner.code} (${who}): к выплате ${fmtUsd(stats.available)} USDT`,
        kb([
          [
            {
              text: `✅ Отметить выплату ${fmtUsd(stats.available)}`,
              callback_data: `ptp:${partner.code}`,
            },
          ],
        ]),
      );
    }
    await send(chatId, `Всего: ${list.length}`, kb(TO_PARTNERS));
  }

  async function markPaid(chatId: number, code: string, reference: string | null): Promise<void> {
    const r = await partners.markPaid(code, reference);
    if (!r) {
      await send(
        chatId,
        `У партнёра ${code} нет доступных начислений (или он не найден).`,
        kb(BACK),
      );
      return;
    }
    await send(chatId, `✅ ${code}: выплата ${fmtUsd(r.payout.amount)} отмечена.`, kb(TO_PARTNERS));
    await send(
      r.partner.telegramId,
      `Выплата по партнёрской программе MIDNEX: ${fmtUsd(r.payout.amount)} USDT` +
        (reference ? `\n${reference}` : '') +
        '\n\nСтатистика — /partner.',
    );
  }

  function parseTerms(args: string[]): Partial<PartnerTerms> | { error: string } {
    const keys: (keyof PartnerTerms)[] = [
      'rewardPercent',
      'rewardMonths',
      'attributionDays',
      'holdDays',
    ];
    const out: Partial<PartnerTerms> = {};
    for (let i = 0; i < Math.min(args.length, keys.length); i++) {
      const v = Number(args[i]);
      if (!Number.isFinite(v)) return { error: `не число: ${args[i]}` };
      out[keys[i]!] = v;
    }
    return out;
  }

  async function partnerAdd(chatId: number, args: string[]): Promise<void> {
    const [who, code, ...rest] = args;
    if (!who || !code) {
      await send(
        chatId,
        'Формат: @user код [процент месяцев дней_закрепления дней_удержания]',
        kb(TO_PARTNERS),
      );
      return;
    }
    const telegramId = await resolveUserId(who);
    if (telegramId === null) {
      await send(
        chatId,
        `Пользователь ${who} не найден — укажи числовой Telegram ID (он получит его командой /id).`,
        kb(BACK),
      );
      return;
    }
    const terms = parseTerms(rest);
    if ('error' in terms) return void (await send(chatId, terms.error, kb(BACK)));
    const r = await partners.create(telegramId, code, terms);
    if ('error' in r) return void (await send(chatId, `Не создал: ${r.error}`, kb(TO_PARTNERS)));
    await send(chatId, `🤝 Партнёр ${r.code} создан: ${termsText(r)}.\nСсылка: ${partnerLink(r)}`);
    // Партнёру — его ссылка и условия; команда /partner появится у него в меню.
    await call(token, 'setMyCommands', {
      scope: { type: 'chat', chat_id: r.telegramId },
      commands: [
        { command: 'partner', description: 'Партнёрская статистика' },
        { command: 'start', description: 'Открыть скринер' },
      ],
    });
    const ok = await send(r.telegramId, partnerSummary(r, await partners.stats(r)));
    if (!ok)
      await send(
        chatId,
        'Партнёр ещё не писал боту — ссылку и условия он увидит по /partner, когда откроет чат.',
      );
    await showPartnerCard(chatId, r.code);
  }

  async function partnerSet(chatId: number, args: string[]): Promise<void> {
    const [code, ...rest] = args;
    if (!code || rest.length === 0) {
      await send(
        chatId,
        'Формат: /partner_set код процент месяцев [дней_закрепления дней_удержания]',
        kb(BACK),
      );
      return;
    }
    const terms = parseTerms(rest);
    if ('error' in terms) return void (await send(chatId, terms.error, kb(BACK)));
    const r = await partners.setTerms(code, terms);
    if ('error' in r) return void (await send(chatId, r.error, kb(TO_PARTNERS)));
    await send(
      chatId,
      `${r.code}: ${termsText(r)}, закрепление ${r.attributionDays} дн., удержание ${r.holdDays} дн. Действует на будущие оплаты.`,
    );
    await send(
      r.telegramId,
      `Условия партнёрской программы обновлены: ${termsText(r)}. Уже созданные начисления не меняются.`,
    );
    await showPartnerCard(chatId, r.code);
  }

  async function partnerStatus(
    chatId: number,
    code: string | undefined,
    status: PartnerRecord['status'],
  ): Promise<void> {
    if (!code) return void (await send(chatId, 'Укажи код партнёра.', kb(BACK)));
    const p = await partners.setStatus(code, status);
    if (!p) return void (await send(chatId, `Партнёр ${code} не найден.`, kb(TO_PARTNERS)));
    await send(
      chatId,
      status === 'paused'
        ? `⏸ ${p.code} на паузе: новые переходы не закрепляются, за уже приведённых — начисления ещё ${PAUSE_GRACE_DAYS} дней.`
        : `▶️ ${p.code} снова активен.`,
    );
    await showPartnerCard(chatId, p.code);
  }

  async function partnerDefaults(chatId: number, args: string[]): Promise<void> {
    if (args.length > 0) {
      const terms = parseTerms(args);
      if ('error' in terms) return void (await send(chatId, terms.error, kb(BACK)));
      await partners.setDefaults(terms);
    }
    await showPartnerConfig(chatId);
  }

  // ---------------------------------------------------------------- партнёры (сам партнёр)

  function partnerLink(p: PartnerRecord): string {
    return `https://t.me/${botUsername || 'midnexbot'}?start=p_${p.code}`;
  }

  /** Только цифры: имена и ID приведённых пользователей партнёр не видит. */
  function partnerSummary(p: PartnerRecord, s: PartnerStats): string {
    return (
      `Партнёрская ссылка: ${partnerLink(p)}\n\n` +
      `Ваши условия: ${termsText(p)}` +
      (p.status === 'paused'
        ? '\n⏸ Программа приостановлена: новые переходы не засчитываются.'
        : '') +
      '\n\nЗа всё время:\n' +
      `  Переходов по ссылке:  ${s.clicks}\n` +
      `  Запустили пробный период:  ${s.trials}\n` +
      `  Оплатили:  ${s.paidUsers}\n\n` +
      'Начислено:\n' +
      `  На удержании:  ${fmtUsd(s.onHold)}   (станет доступно в течение ${p.holdDays} дней)\n` +
      `  Доступно к выплате:  ${fmtUsd(s.available)}\n` +
      `  Выплачено всего:  ${fmtUsd(s.paid)}`
    );
  }

  async function showPartner(chatId: number, p: PartnerRecord): Promise<void> {
    await send(
      chatId,
      partnerSummary(p, await partners.stats(p)),
      kb([[{ text: '📅 По месяцам', callback_data: 'ptr:months' }]]),
    );
  }

  async function showPartnerMonths(chatId: number, p: PartnerRecord): Promise<void> {
    const rows = await partners.monthly(p);
    const extra = billing.isAdmin(chatId)
      ? kb([[{ text: `← ${p.code}`, callback_data: `ptn:${p.code}` }]])
      : {};
    if (rows.length === 0) return void (await send(chatId, 'Начислений пока не было.', extra));
    await send(
      chatId,
      'Начисления по месяцам:\n' +
        rows.map((r) => `  ${r.month}: ${fmtUsd(r.amount)} · оплативших ${r.users}`).join('\n'),
      extra,
    );
  }

  async function showUsers(chatId: number): Promise<void> {
    const [users, active] = await Promise.all([repo.countUsers(), repo.countActiveSubscriptions()]);
    await send(chatId, `Пользователей: ${users}\nАктивных подписок: ${active}`, kb(BACK));
  }

  /** Ответ администратора на вопрос бота (выдать / отозвать / статус). */
  async function handleAwaiting(chatId: number, text: string): Promise<void> {
    const action = awaiting;
    awaiting = null;
    if (action?.startsWith('paid:')) {
      const ref = text.trim();
      return markPaid(chatId, action.slice(5), ref === '-' ? null : ref);
    }
    const args = text.trim().split(/\s+/).filter(Boolean);
    if (action === 'padd') return partnerAdd(chatId, args);
    if (action === 'pdef') return partnerDefaults(chatId, args);
    if (action?.startsWith('pset:')) return partnerSet(chatId, [action.slice(5), ...args]);
    if (action === 'pmin') {
      const v = Number(args[0]);
      if (!(v > 0))
        return void (await send(chatId, 'Нужна сумма в долларах, например 20.', kb(CANCEL)));
      await partners.setMinPayout(v);
      return showPartnerConfig(chatId);
    }
    const [who, daysRaw, planRaw] = args;
    if (!who) return showMenu(chatId);
    const userId = await resolveUserId(who);
    if (userId === null) {
      await send(
        chatId,
        `Пользователь ${who} не найден — он должен хотя бы раз открыть приложение.`,
        kb(BACK),
      );
      return;
    }
    if (action === 'grant') {
      const days = Number(daysRaw);
      if (!Number.isFinite(days) || days <= 0) {
        await send(chatId, 'Нужно число дней, например: @user 30', kb(BACK));
        return;
      }
      const plan = (PLAN_ORDER.includes(planRaw as PlanId) ? planRaw : 'screener') as PlanId;
      const sub = await billing.grant(userId, days, plan);
      await send(
        chatId,
        `Выдано: ${who} → ${planTitle(plan)} до ${fmtDate(sub.expiresAt)}.`,
        kb(BACK),
      );
      await send(userId, `Тебе открыт доступ: ${planTitle(plan)} до ${fmtDate(sub.expiresAt)}.`);
    } else if (action === 'revoke') {
      await repo.revokeSubscription(userId);
      await send(chatId, `Доступ ${who} отозван.`, kb(BACK));
    } else if (action === 'sub') {
      const info = await billing.info(userId);
      await send(
        chatId,
        info.active
          ? `${who}: ${planTitle(info.plan)}, активна до ${info.expiresAt ? fmtDate(info.expiresAt) : '∞'} (${info.daysLeft} дн.)`
          : `${who}: подписки нет${info.expiresAt ? `, истекла ${fmtDate(info.expiresAt)}` : ''}.`,
        kb(BACK),
      );
    }
  }

  /** Текст ошибки для админа; отсутствие таблиц партнёрки — с подсказкой про миграцию. */
  function adminError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /relation "(partners|user_referrals|partner_earnings|partner_payouts)" does not exist/.test(
        msg,
      )
    ) {
      return '⚠️ Таблицы партнёрской программы ещё не созданы. Примени миграцию apps/api/migrations/0013_partners.sql в Supabase (SQL Editor) — и команды заработают.';
    }
    return `⚠️ Ошибка: ${msg.slice(0, 300)}`;
  }

  async function onCallback(q: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    const chatId = q.message?.chat.id ?? q.from.id;
    await call(token, 'answerCallbackQuery', { callback_query_id: q.id });
    const data = q.data ?? '';
    if (billing.isAdmin(q.from.id)) {
      try {
        await onAdminCallback(chatId, data);
      } catch (err) {
        await send(chatId, adminError(err), kb(BACK));
      }
      return;
    }

    // Кнопки партнёра — доступны только самому партнёру.
    if (data === 'ptr:months') {
      const p = await partners.byTelegramId(q.from.id);
      if (p) await showPartnerMonths(chatId, p);
    }
  }

  async function onAdminCallback(chatId: number, data: string): Promise<void> {
    if (data === 'ptr:months') {
      const p = await partners.byTelegramId(chatId);
      if (p) await showPartnerMonths(chatId, p);
      return;
    }
    if (data === 'adm:menu') return showMenu(chatId);
    if (data === 'adm:users') return showUsers(chatId);
    if (data === 'adm:partners') return showPartners(chatId);
    if (data === 'adm:payouts') return showPayouts(chatId);
    if (data === 'adm:pcfg') return showPartnerConfig(chatId);
    if (data === 'adm:padd') {
      awaiting = 'padd';
      const d = await partners.defaults();
      return void (await send(
        chatId,
        'Новый партнёр. Отправь: @username код\n' +
          'Пример: @cryptochannel cryptochannel\n\n' +
          `Условия возьмутся по умолчанию (${termsText(d)}, закрепление ${d.attributionDays} дн., удержание ${d.holdDays} дн.). ` +
          'Свои — допиши числами: процент месяцев [закрепление удержание], например: @user code 30 3 30 14.\n' +
          'Если партнёр ещё не открывал приложение — вместо @username его числовой ID (он получит его командой /id).',
        kb(CANCEL),
      ));
    }
    if (data === 'adm:pdef') {
      awaiting = 'pdef';
      const d = await partners.defaults();
      return void (await send(
        chatId,
        `Условия по умолчанию сейчас: ${d.rewardPercent} ${d.rewardMonths} ${d.attributionDays} ${d.holdDays}\n` +
          'Отправь новые четырьмя числами: процент месяцев дней_закрепления дней_удержания.\n' +
          'Действуют на партнёров, которых создашь после.',
        kb(CANCEL),
      ));
    }
    if (data === 'adm:pmin') {
      awaiting = 'pmin';
      return void (await send(
        chatId,
        `Минимальная выплата сейчас: ${fmtUsd(await partners.minPayout())}. Отправь новую сумму в долларах.`,
        kb(CANCEL),
      ));
    }
    if (data.startsWith('ptn:')) return showPartnerCard(chatId, data.slice(4));
    if (data.startsWith('ptm:')) {
      const p = await partners.byCode(data.slice(4));
      if (p) await showPartnerMonths(chatId, p);
      return;
    }
    if (data.startsWith('ptz:')) return partnerStatus(chatId, data.slice(4), 'paused');
    if (data.startsWith('ptv:')) return partnerStatus(chatId, data.slice(4), 'active');
    if (data.startsWith('ptl:')) {
      const p = await partners.byCode(data.slice(4));
      if (!p) return;
      const ok = await send(p.telegramId, partnerSummary(p, await partners.stats(p)));
      return void (await send(
        chatId,
        ok
          ? `Ссылка и статистика отправлены партнёру ${p.code}.`
          : `Не доставлено: ${p.code} ещё не писал боту.`,
        kb(TO_PARTNERS),
      ));
    }
    if (data.startsWith('pte:')) {
      const p = await partners.byCode(data.slice(4));
      if (!p) return;
      awaiting = `pset:${p.code}`;
      return void (await send(
        chatId,
        `Условия ${p.code} сейчас: ${p.rewardPercent} ${p.rewardMonths} ${p.attributionDays} ${p.holdDays}\n` +
          'Отправь новые: процент месяцев [дней_закрепления дней_удержания].\n' +
          'Меняются только будущие начисления; партнёр получит сообщение.',
        kb(CANCEL),
      ));
    }
    if (data.startsWith('ptp:')) {
      awaiting = `paid:${data.slice(4)}`;
      return void (await send(
        chatId,
        `Отмечаю выплату ${data.slice(4)}. Пришли ссылку или комментарий к переводу (или «-», если без него).`,
        kb(CANCEL),
      ));
    }
    if (data === 'adm:grant') {
      awaiting = 'grant';
      return void (await send(
        chatId,
        'Кому и на сколько дней? Отправь: @username 30\nТретьим словом можно указать тариф: screener, limited или unlimited.',
        kb(CANCEL),
      ));
    }
    if (data === 'adm:revoke') {
      awaiting = 'revoke';
      return void (await send(
        chatId,
        'У кого отозвать доступ? Отправь @username или ID.',
        kb(CANCEL),
      ));
    }
    if (data === 'adm:paper') {
      if (!opts.togglePaper) return void (await send(chatId, 'Недоступно.', kb(BACK)));
      const on = await opts.togglePaper(chatId);
      return void (await send(
        chatId,
        on
          ? '🧪 Бумажная торговля включена для тебя: сделки бота — виртуальные, без реальных ордеров.'
          : 'Бумажная торговля выключена: бот торгует реальными деньгами.',
        kb(BACK),
      ));
    }
    if (data === 'adm:sub') {
      awaiting = 'sub';
      return void (await send(
        chatId,
        'Чей статус показать? Отправь @username или ID.',
        kb(CANCEL),
      ));
    }
  }

  /** Текстовые команды — дубль кнопок для тех, кому так быстрее. */
  async function admin(chatId: number, text: string): Promise<boolean> {
    const [cmd, ...args] = text.trim().split(/\s+/);
    switch (cmd) {
      case '/admin':
      case '/help':
      case '/menu':
        await showMenu(chatId);
        return true;
      case '/users':
        await showUsers(chatId);
        return true;
      case '/partners':
        await showPartners(chatId);
        return true;
      case '/partner_help':
        await send(chatId, PARTNER_HELP, kb(TO_PARTNERS));
        return true;
      case '/partner_add':
        await partnerAdd(chatId, args);
        return true;
      case '/partner_set':
        await partnerSet(chatId, args);
        return true;
      case '/partner_pause':
        await partnerStatus(chatId, args[0], 'paused');
        return true;
      case '/partner_resume':
        await partnerStatus(chatId, args[0], 'active');
        return true;
      case '/partner_defaults':
        await partnerDefaults(chatId, args);
        return true;
      case '/payouts':
        await showPayouts(chatId);
        return true;
      case '/paid':
        if (!args[0]) await send(chatId, 'Формат: /paid код [ссылка на перевод]', kb(BACK));
        else await markPaid(chatId, args[0], args.slice(1).join(' ') || null);
        return true;
      case '/min_payout': {
        const v = Number(args[0]);
        if (!(v > 0)) await send(chatId, 'Формат: /min_payout 20', kb(BACK));
        else {
          await partners.setMinPayout(v);
          await send(chatId, `Минимальная выплата: ${fmtUsd(v)}.`, kb(BACK));
        }
        return true;
      }
      case '/grant':
        awaiting = 'grant';
        await handleAwaiting(chatId, args.join(' '));
        return true;
      case '/revoke':
        awaiting = 'revoke';
        await handleAwaiting(chatId, args.join(' '));
        return true;
      case '/sub':
        awaiting = 'sub';
        await handleAwaiting(chatId, args.join(' '));
        return true;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- апдейты

  async function handle(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      await onCallback(update.callback_query);
      return;
    }

    // Telegram спрашивает разрешение на списание звёзд — отвечать надо за 10 с.
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      const check = await billing.preCheckout(q.invoice_payload);
      await call(token, 'answerPreCheckoutQuery', {
        pre_checkout_query_id: q.id,
        ok: check.ok,
        ...(check.ok ? {} : { error_message: check.error }),
      });
      return;
    }

    const msg = update.message;
    if (!msg) return;

    if (msg.successful_payment) {
      const sp = msg.successful_payment;
      const sub = await billing.starsPaid(sp.invoice_payload, sp.telegram_payment_charge_id);
      if (sub) {
        await send(
          msg.chat.id,
          `Оплата прошла — спасибо! ${planTitle(sub.plan)} активен до ${fmtDate(sub.expiresAt)}.`,
        );
        await notifyAdmin(
          `⭐ Оплата звёздами: ${msg.from?.username ? '@' + msg.from.username : msg.chat.id}, ` +
            `${planTitle(sub.plan)}, ${sp.total_amount} XTR, до ${fmtDate(sub.expiresAt)}`,
        );
      } else {
        log.error({ payload: sp.invoice_payload }, 'оплата: successful_payment без заявки');
        await notifyAdmin(
          `⚠️ Пришла оплата звёздами без заявки: payload ${sp.invoice_payload}, чат ${msg.chat.id}`,
        );
      }
      return;
    }

    if (!msg.text) return;

    log.info(
      { chatId: msg.chat.id, from: msg.from?.username, text: msg.text.slice(0, 64) },
      'бот: входящее сообщение',
    );

    if (msg.chat.type !== 'private') return;

    if (msg.text.startsWith('/id')) {
      await send(msg.chat.id, `Твой Telegram ID: ${msg.chat.id}`);
      return;
    }

    if (/^\/partner(?:@\w+)?$/.test(msg.text.trim())) {
      const p = await partners.byTelegramId(msg.chat.id);
      if (p) await showPartner(msg.chat.id, p);
      else if (!billing.isAdmin(msg.chat.id))
        await send(msg.chat.id, 'Эта команда — для партнёров программы MIDNEX.');
      if (p || !billing.isAdmin(msg.chat.id)) return;
    }

    // /start p_<код> — переход по партнёрской ссылке: закрепляем нового
    // пользователя до того, как он откроет приложение.
    let referred = false;
    const startArg = msg.text.match(/^\/start(?:@\w+)?\s+(\S+)/)?.[1];
    const code = Partners.codeFromStart(startArg);
    if (code) {
      const isNew = !(await repo.getUser(msg.chat.id));
      const r = await partners.attribute(msg.chat.id, code, isNew);
      referred = r === 'ok';
      log.info({ chatId: msg.chat.id, code, result: r }, 'партнёрка: переход по ссылке');
    }

    if (billing.isAdmin(msg.chat.id)) {
      // Ошибка в админ-действии — ответом в чат, а не молчанием: иначе
      // «бот не реагирует», а причина только в логе.
      try {
        if (awaiting && !msg.text.startsWith('/')) {
          await handleAwaiting(msg.chat.id, msg.text);
          return;
        }
        if (msg.text.startsWith('/') && !msg.text.startsWith('/start')) {
          if (await admin(msg.chat.id, msg.text)) return;
        }
      } catch (err) {
        await send(msg.chat.id, adminError(err), kb(BACK));
        return;
      }
    }

    const appUrl = await resolveAppUrl(token, publicUrl);
    const name = msg.from?.first_name ?? 'друг';

    const res = await call(token, 'sendMessage', {
      chat_id: msg.chat.id,
      text: greeting(appUrl, name, referred),
      reply_markup: appUrl
        ? {
            inline_keyboard: [
              [{ text: 'Открыть MIDNEX', web_app: { url: appUrl } }],
              [{ text: 'Канал MIDNEX', url: CHANNEL_URL }],
            ],
          }
        : undefined,
    });

    // Без этой проверки провал отправки выглядит как успех: Telegram отвечает
    // HTTP 200 с ok:false, и молчание бота становится необъяснимым.
    if (!res.ok) {
      log.error(
        { chatId: msg.chat.id, code: res.error_code, description: res.description },
        'бот: НЕ СМОГ отправить ответ',
      );
      return;
    }
    log.info({ chatId: msg.chat.id, appUrl }, 'бот: ответ с кнопкой отправлен');
  }

  async function poll(): Promise<void> {
    while (!stopped) {
      try {
        // timeout=25 — long polling: соединение висит до появления апдейта,
        // а не долбит Telegram в цикле.
        const res = await call<TgUpdate[]>(
          token,
          'getUpdates',
          {
            offset,
            timeout: 25,
            allowed_updates: ['message', 'pre_checkout_query', 'callback_query'],
          },
          40_000,
        );

        if (!res.ok) {
          // 409 — где-то запущен второй экземпляр бота с тем же токеном.
          // Молча продолжать нельзя: два бота будут отвечать по два раза.
          if (res.error_code === 409) {
            log.error(
              { description: res.description },
              'бот: конфликт, уже запущен другой экземпляр',
            );
            stopped = true;
            return;
          }
          log.warn({ description: res.description }, 'бот: getUpdates вернул ошибку');
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        for (const update of res.result ?? []) {
          offset = update.update_id + 1;
          try {
            await handle(update);
          } catch (err) {
            log.error({ err: String(err) }, 'бот: не смог обработать сообщение');
          }
        }
      } catch (err) {
        // Обрыв сети не должен убивать бота — просто ждём и пробуем снова.
        log.warn({ err: String(err) }, 'бот: сеть недоступна, повтор через 5 с');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async function boot(): Promise<void> {
    if (publicUrl) {
      const res = await call(token, 'setChatMenuButton', {
        menu_button: {
          type: 'web_app',
          text: 'MIDNEX',
          web_app: { url: publicUrl },
        },
      });
      if (res.ok) log.info(`бот: кнопка меню привязана к ${publicUrl}`);
      else log.warn({ description: res.description }, 'бот: не удалось привязать кнопку меню');
    }

    await call(token, 'setMyCommands', {
      commands: [{ command: 'start', description: 'Открыть скринер' }],
    });
    if (billing.adminId !== null) {
      await call(token, 'setMyCommands', {
        scope: { type: 'chat', chat_id: billing.adminId },
        commands: [
          { command: 'admin', description: 'Панель администратора' },
          { command: 'partners', description: 'Партнёры' },
          { command: 'payouts', description: 'Партнёрам к выплате' },
          { command: 'start', description: 'Открыть скринер' },
        ],
      });
    }

    const me = await call<{ username: string }>(token, 'getMe');
    botUsername = me.result?.username ?? '';
    log.info(`бот: слушаю @${botUsername || '?'}`);
    void poll();
    void remind();
    setInterval(() => void remind(), 6 * 60 * 60 * 1000);
  }

  /**
   * Напоминания: за три дня до конца и в день окончания. Одно на подписку —
   * reminded_at сбрасывается при продлении, так что после оплаты цикл начнётся заново.
   */
  async function remind(): Promise<void> {
    try {
      const now = Date.now();
      // Платные — за три дня, пробные — за день: неделя короткая, три дня
      // от неё — почти половина срока.
      const soon = await repo.listSubscriptionsExpiring(now, now + 3 * 86_400_000);
      for (const sub of soon) {
        const trial = sub.source === 'trial';
        if (trial && sub.expiresAt - now > 86_400_000) continue;
        if (sub.remindedAt && now - sub.remindedAt < 2.5 * 86_400_000) continue;
        const ok = await send(
          sub.userId,
          trial
            ? `Пробная неделя заканчивается ${fmtDate(sub.expiresAt)}. Чтобы скринер не закрылся, оформи подписку: Настройки → Подписка.`
            : `Подписка ${planTitle(sub.plan)} заканчивается ${fmtDate(sub.expiresAt)}. ` +
                'Продлить можно в приложении: Настройки → Подписка.',
        );
        if (ok) await repo.markReminded(sub.userId);
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'бот: напоминания не разосланы');
    }
    await remindPayouts();
  }

  /**
   * Раз в месяц — список партнёров к выплате администратору. Отметка месяца
   * в app_config: если ПК был выключен 1-го числа, письмо уйдёт при первом
   * запуске в новом месяце.
   */
  async function remindPayouts(): Promise<void> {
    if (billing.adminId === null) return;
    try {
      const d = new Date();
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if ((await repo.getConfig('partner_payout_reminded')) === month) return;
      await repo.setConfig('partner_payout_reminded', month);
      const list = await partners.payable();
      if (list.length === 0) return;
      await send(
        billing.adminId,
        `💸 Партнёрам к выплате за месяц:\n` +
          list.map((x) => `  ${x.partner.code}: ${fmtUsd(x.stats.available)}`).join('\n') +
          '\n\nПеревести в USDT через CryptoBot и отметить: /paid код [ссылка].',
      );
    } catch (err) {
      log.warn({ err: String(err) }, 'бот: напоминание о выплатах не ушло');
    }
  }

  void boot().catch((err: unknown) => log.error({ err: String(err) }, 'бот: не смог запуститься'));

  return {
    send,
    stop() {
      stopped = true;
    },
  };
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
