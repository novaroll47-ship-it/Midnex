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
import { PLAN_ORDER, type PlanId } from '@cs/shared';

import { planTitle, type Billing } from './billing.js';
import type { Repo } from './repo/index.js';

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
}

/** Что бот умеет наружу: слать сообщения из API и останавливаться. */
export interface BotHandle {
  send(chatId: number, text: string, extra?: Record<string, unknown>): Promise<boolean>;
  /** Сообщить администратору о заявке на оплату — с кнопками подтверждения. */
  notifyPayment(text: string, paymentId: string): Promise<void>;
  stop(): void;
}

async function call<T>(
  token: string,
  method: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<TgResponse<T>> {
  // Без таймаута обрыв сети превращается в вечно висящий запрос.
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await res.json()) as TgResponse<T>;
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

function greeting(appUrl: string | undefined, name: string): string {
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
    'Автоматическая торговля по этим спредам — в разработке.\n\n' +
    `Новости и разборы — в канале ${CHANNEL_URL}\n\n` +
    'Нажми кнопку ниже, чтобы открыть скринер.'
  );
}

export function startBot({ token, publicUrl, log, billing, repo }: BotOptions): BotHandle {
  let offset = 0;
  let stopped = false;

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
   * Панель администратора живёт на кнопках: меню, заявки с «Подтвердить /
   * Отклонить», действия с вводом (выдать, отозвать, статус) — бот задаёт
   * вопрос и ждёт следующее сообщение. Текстовые команды тоже работают.
   */
  type Awaiting = 'grant' | 'revoke' | 'sub' | null;
  let awaiting: Awaiting = null;

  const MENU: Keyboard = [
    [
      { text: '📋 Заявки', callback_data: 'adm:pending' },
      { text: '👥 Пользователи', callback_data: 'adm:users' },
    ],
    [
      { text: '➕ Выдать доступ', callback_data: 'adm:grant' },
      { text: '🚫 Отозвать', callback_data: 'adm:revoke' },
    ],
    [{ text: '🔎 Статус подписки', callback_data: 'adm:sub' }],
  ];
  const BACK: Keyboard = [[{ text: '← Меню', callback_data: 'adm:menu' }]];
  const CANCEL: Keyboard = [[{ text: 'Отмена', callback_data: 'adm:menu' }]];

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
    const [users, active, pending] = await Promise.all([
      repo.countUsers(),
      repo.countActiveSubscriptions(),
      repo.listPendingPayments(),
    ]);
    const open = pending.filter((p) => p.method === 'crypto' && p.txHash).length;
    await send(
      chatId,
      `Панель администратора\n\nПользователей: ${users}\nАктивных подписок: ${active}\nЗаявок на проверку: ${open}`,
      kb(MENU),
    );
  }

  async function showPending(chatId: number): Promise<void> {
    const list = (await repo.listPendingPayments()).filter((p) => p.method === 'crypto');
    if (list.length === 0) {
      await send(chatId, 'Открытых заявок нет.', kb(BACK));
      return;
    }
    for (const p of list) {
      const u = await repo.getUser(p.userId);
      const who = u?.username ? `@${u.username}` : `id ${p.userId}`;
      await send(
        chatId,
        `Заявка #${p.id}\n${who} · ${planTitle(p.plan)} · ${p.months} мес.\n` +
          `${p.amount} USDT (${p.network})\nHash: ${p.txHash ?? 'ещё не прислан'}`,
        kb([
          [
            { text: '✅ Подтвердить', callback_data: `pay:ok:${p.id}` },
            { text: '❌ Отклонить', callback_data: `pay:no:${p.id}` },
          ],
        ]),
      );
    }
    await send(chatId, `Всего заявок: ${list.length}`, kb(BACK));
  }

  async function showUsers(chatId: number): Promise<void> {
    const [users, active] = await Promise.all([repo.countUsers(), repo.countActiveSubscriptions()]);
    await send(chatId, `Пользователей: ${users}\nАктивных подписок: ${active}`, kb(BACK));
  }

  async function approvePayment(chatId: number, id: string): Promise<void> {
    const r = await billing.approve(id);
    if (!r) {
      await send(chatId, `Заявка #${id} не найдена или уже закрыта.`, kb(BACK));
      return;
    }
    await send(chatId, `✅ #${id} подтверждена. Доступ до ${fmtDate(r.sub.expiresAt)}.`, kb(BACK));
    await send(
      r.payment.userId,
      `Оплата получена — спасибо! ${planTitle(r.payment.plan)} активен до ${fmtDate(r.sub.expiresAt)}.`,
    );
  }

  async function rejectPayment(chatId: number, id: string): Promise<void> {
    const p = await billing.reject(id, null);
    if (!p) {
      await send(chatId, `Заявка #${id} не найдена или уже закрыта.`, kb(BACK));
      return;
    }
    await send(chatId, `❌ #${id} отклонена.`, kb(BACK));
    await send(
      p.userId,
      `Заявка на оплату #${id} отклонена: перевод не найден. ` +
        'Проверь сумму, сеть и хэш и создай заявку заново в приложении.',
    );
  }

  /** Ответ администратора на вопрос бота (выдать / отозвать / статус). */
  async function handleAwaiting(chatId: number, text: string): Promise<void> {
    const action = awaiting;
    awaiting = null;
    const [who, daysRaw, planRaw] = text.trim().split(/\s+/);
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

  async function onCallback(q: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    const chatId = q.message?.chat.id ?? q.from.id;
    await call(token, 'answerCallbackQuery', { callback_query_id: q.id });
    if (!billing.isAdmin(q.from.id)) return;
    const data = q.data ?? '';

    if (data === 'adm:menu') return showMenu(chatId);
    if (data === 'adm:pending') return showPending(chatId);
    if (data === 'adm:users') return showUsers(chatId);
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
    if (data === 'adm:sub') {
      awaiting = 'sub';
      return void (await send(
        chatId,
        'Чей статус показать? Отправь @username или ID.',
        kb(CANCEL),
      ));
    }
    if (data.startsWith('pay:ok:')) return approvePayment(chatId, data.slice(7));
    if (data.startsWith('pay:no:')) return rejectPayment(chatId, data.slice(7));
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
      case '/pending':
        await showPending(chatId);
        return true;
      case '/users':
        await showUsers(chatId);
        return true;
      case '/approve':
        if (args[0]) await approvePayment(chatId, args[0]);
        return true;
      case '/reject':
        if (args[0]) await rejectPayment(chatId, args[0]);
        return true;
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

    if (billing.isAdmin(msg.chat.id)) {
      if (awaiting && !msg.text.startsWith('/')) {
        await handleAwaiting(msg.chat.id, msg.text);
        return;
      }
      if (msg.text.startsWith('/') && !msg.text.startsWith('/start')) {
        if (await admin(msg.chat.id, msg.text)) return;
      }
    }

    const appUrl = await resolveAppUrl(token, publicUrl);
    const name = msg.from?.first_name ?? 'друг';

    const res = await call(token, 'sendMessage', {
      chat_id: msg.chat.id,
      text: greeting(appUrl, name),
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
          { command: 'pending', description: 'Заявки на оплату' },
          { command: 'start', description: 'Открыть скринер' },
        ],
      });
    }

    const me = await call<{ username: string }>(token, 'getMe');
    log.info(`бот: слушаю @${me.result?.username ?? '?'}`);
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
      const soon = await repo.listSubscriptionsExpiring(now, now + 3 * 86_400_000);
      for (const sub of soon) {
        if (sub.remindedAt && now - sub.remindedAt < 2.5 * 86_400_000) continue;
        const ok = await send(
          sub.userId,
          `Подписка ${planTitle(sub.plan)} заканчивается ${fmtDate(sub.expiresAt)}. ` +
            'Продлить можно в приложении: Настройки → Подписка.',
        );
        if (ok) await repo.markReminded(sub.userId);
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'бот: напоминания не разосланы');
    }
  }

  void boot().catch((err: unknown) => log.error({ err: String(err) }, 'бот: не смог запуститься'));

  return {
    send,
    async notifyPayment(text, paymentId) {
      if (billing.adminId === null) return;
      await send(
        billing.adminId,
        text,
        kb([
          [
            { text: '✅ Подтвердить', callback_data: `pay:ok:${paymentId}` },
            { text: '❌ Отклонить', callback_data: `pay:no:${paymentId}` },
          ],
        ]),
      );
    },
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
