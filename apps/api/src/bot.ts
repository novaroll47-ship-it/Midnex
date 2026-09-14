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

const API = 'https://api.telegram.org';

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; first_name: string; username?: string };
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

export function startBot({ token, publicUrl, log }: BotOptions): () => void {
  let offset = 0;
  let stopped = false;

  async function handle(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;

    log.info(
      { chatId: msg.chat.id, from: msg.from?.username, text: msg.text.slice(0, 64) },
      'бот: входящее сообщение',
    );

    if (msg.chat.type !== 'private') return;

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
          allowed_updates: ['message'],
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
  }

  void boot().catch((err: unknown) => log.error({ err: String(err) }, 'бот: не смог запуститься'));

  return () => {
    stopped = true;
  };
}
