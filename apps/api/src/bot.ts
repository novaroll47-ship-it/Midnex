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
}

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
  stop(): void;
}

async function call<T>(token: string, method: string, body?: unknown): Promise<TgResponse<T>> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
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

  // ---------------------------------------------------------------- админ-команды

  async function resolveUserId(arg: string): Promise<number | null> {
    if (/^\d+$/.test(arg)) return Number(arg);
    const u = await repo.findUserByUsername(arg);
    return u?.id ?? null;
  }

  async function admin(chatId: number, text: string): Promise<boolean> {
    const [cmd, ...args] = text.trim().split(/\s+/);
    switch (cmd) {
      case '/help':
      case '/admin': {
        await send(
          chatId,
          'Команды администратора:\n' +
            '/users — сколько пользователей и активных подписок\n' +
            '/pending — открытые заявки на оплату USDT\n' +
            '/approve <код> — подтвердить перевод\n' +
            '/reject <код> [причина] — отклонить\n' +
            '/grant <id|@username> <дней> [screener|limited|unlimited] — выдать доступ\n' +
            '/revoke <id|@username> — отозвать доступ\n' +
            '/sub <id|@username> — статус подписки',
        );
        return true;
      }
      case '/users': {
        const [users, active] = await Promise.all([
          repo.countUsers(),
          repo.countActiveSubscriptions(),
        ]);
        await send(chatId, `Пользователей: ${users}\nАктивных подписок: ${active}`);
        return true;
      }
      case '/pending': {
        const list = (await repo.listPendingPayments()).filter((p) => p.method === 'crypto');
        if (list.length === 0) {
          await send(chatId, 'Открытых заявок нет.');
          return true;
        }
        const lines = await Promise.all(
          list.map(async (p) => {
            const u = await repo.getUser(p.userId);
            const who = u?.username ? `@${u.username}` : `id ${p.userId}`;
            return (
              `#${p.id} · ${who} · ${planTitle(p.plan)} ${p.months} мес · ${p.amount} USDT (${p.network})` +
              `\n   hash: ${p.txHash ?? '— ещё не прислан'}`
            );
          }),
        );
        await send(chatId, lines.join('\n\n') + '\n\n/approve <код> или /reject <код>');
        return true;
      }
      case '/approve': {
        const id = args[0];
        if (!id) return send(chatId, 'Укажи код заявки: /approve a1b2c3');
        const r = await billing.approve(id);
        if (!r) return send(chatId, `Заявка #${id} не найдена или уже закрыта.`);
        await send(chatId, `Готово: #${id} подтверждена, доступ до ${fmtDate(r.sub.expiresAt)}.`);
        await send(
          r.payment.userId,
          `Оплата получена — спасибо! ${planTitle(r.payment.plan)} активен до ${fmtDate(r.sub.expiresAt)}.`,
        );
        return true;
      }
      case '/reject': {
        const id = args[0];
        if (!id) return send(chatId, 'Укажи код заявки: /reject a1b2c3 причина');
        const note = args.slice(1).join(' ') || null;
        const p = await billing.reject(id, note);
        if (!p) return send(chatId, `Заявка #${id} не найдена или уже закрыта.`);
        await send(chatId, `Заявка #${id} отклонена.`);
        await send(
          p.userId,
          `Заявка на оплату #${id} отклонена${note ? `: ${note}` : ''}. ` +
            'Проверь перевод и создай заявку заново в приложении, либо напиши в поддержку.',
        );
        return true;
      }
      case '/grant': {
        const [who, daysRaw, planRaw] = args;
        const days = Number(daysRaw);
        if (!who || !Number.isFinite(days) || days <= 0) {
          return send(chatId, 'Формат: /grant <id|@username> <дней> [screener|limited|unlimited]');
        }
        const userId = await resolveUserId(who);
        if (userId === null)
          return send(
            chatId,
            `Пользователь ${who} не найден — он должен хотя бы раз открыть приложение.`,
          );
        const plan = (PLAN_ORDER.includes(planRaw as PlanId) ? planRaw : 'screener') as PlanId;
        const sub = await billing.grant(userId, days, plan);
        await send(chatId, `Выдано: ${who} → ${planTitle(plan)} до ${fmtDate(sub.expiresAt)}.`);
        await send(userId, `Тебе открыт доступ: ${planTitle(plan)} до ${fmtDate(sub.expiresAt)}.`);
        return true;
      }
      case '/revoke': {
        const who = args[0];
        if (!who) return send(chatId, 'Формат: /revoke <id|@username>');
        const userId = await resolveUserId(who);
        if (userId === null) return send(chatId, `Пользователь ${who} не найден.`);
        await repo.revokeSubscription(userId);
        await send(chatId, `Доступ ${who} отозван.`);
        return true;
      }
      case '/sub': {
        const who = args[0];
        if (!who) return send(chatId, 'Формат: /sub <id|@username>');
        const userId = await resolveUserId(who);
        if (userId === null) return send(chatId, `Пользователь ${who} не найден.`);
        const info = await billing.info(userId);
        await send(
          chatId,
          info.active
            ? `${who}: ${planTitle(info.plan)}, активна, до ${info.expiresAt ? fmtDate(info.expiresAt) : '∞'} (${info.daysLeft} дн.)`
            : `${who}: подписки нет${info.expiresAt ? `, истекла ${fmtDate(info.expiresAt)}` : ''}.`,
        );
        return true;
      }
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- апдейты

  async function handle(update: TgUpdate): Promise<void> {
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

    if (
      billing.isAdmin(msg.chat.id) &&
      msg.text.startsWith('/') &&
      !msg.text.startsWith('/start')
    ) {
      if (await admin(msg.chat.id, msg.text)) return;
    }

    const appUrl = await resolveAppUrl(token, publicUrl);
    const name = msg.from?.first_name ?? 'друг';

    const res = await call(token, 'sendMessage', {
      chat_id: msg.chat.id,
      text: greeting(appUrl, name),
      reply_markup: appUrl
        ? { inline_keyboard: [[{ text: 'Открыть MIDNEX', web_app: { url: appUrl } }]] }
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
        const res = await call<TgUpdate[]>(token, 'getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message', 'pre_checkout_query'],
        });

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
