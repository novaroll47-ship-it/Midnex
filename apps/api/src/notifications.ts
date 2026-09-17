/**
 * Сервис уведомлений: одно место, откуда всё приложение пишет пользователю
 * в Telegram. Событие любого типа превращается в текст по шаблону и уходит
 * через бота; торговый бот потом просто добавит свои типы событий.
 *
 * Очередь с ограничением частоты: Telegram режет ботов, которые шлют
 * быстрее ~30 сообщений в секунду суммарно и чаще одного в секунду в один
 * чат. Уведомлений от скринера может быть много разом (десять монет пробили
 * порог в одну секунду), поэтому отправка — не напрямую, а через очередь.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ExchangeId } from '@cs/shared';

import { CHANNEL_URL, type BotHandle } from './bot.js';

export type NotificationEvent =
  | {
      type: 'threshold_alert';
      base: string;
      longExchange: ExchangeId;
      shortExchange: ExchangeId;
      spreadPct: number;
      thresholdPct: number;
      /** Правило по монете или общее. */
      rule: 'pair' | 'global';
    }
  | { type: 'delisting_warning'; base: string; exchange: ExchangeId }
  | { type: 'trial_ending'; expiresAt: number }
  | { type: 'subscription_ending'; plan: string; expiresAt: number }
  | { type: 'position_opened'; base: string; text: string }
  | { type: 'position_closed'; base: string; text: string };

const EXCHANGE_NAME: Record<string, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  mexc: 'MEXC',
  bitget: 'Bitget',
  bingx: 'BingX',
  gate: 'Gate',
  kucoin: 'KuCoin',
};

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** Текст сообщения по типу события. Новые типы — новые ветки, ядро не меняется. */
export function render(e: NotificationEvent): string {
  switch (e.type) {
    case 'threshold_alert':
      return (
        `🔔 Спред по ${e.base} (${EXCHANGE_NAME[e.longExchange]} ↔ ${EXCHANGE_NAME[e.shortExchange]}): ` +
        `${e.spreadPct.toFixed(2)}% (порог ${e.thresholdPct.toFixed(2)}%${e.rule === 'global' ? ', общее правило' : ''})`
      );
    case 'delisting_warning':
      return `⚠️ ${e.base}: ${EXCHANGE_NAME[e.exchange]} убирает контракт с торгов. Пара уходит из скринера; если у тебя есть позиция — закрой её заранее.`;
    case 'trial_ending':
      return `Пробная неделя заканчивается ${fmtDate(e.expiresAt)}. Чтобы скринер не закрылся, оформи подписку: Настройки → Подписка.`;
    case 'subscription_ending':
      return `Подписка ${e.plan} заканчивается ${fmtDate(e.expiresAt)}. Продлить можно в приложении: Настройки → Подписка.`;
    case 'position_opened':
      return `📈 Открыта позиция по ${e.base}\n${e.text}`;
    case 'position_closed':
      return `📉 Закрыта позиция по ${e.base}\n${e.text}`;
  }
}

export class NotificationService {
  private readonly queue: { userId: number; text: string; extra?: Record<string, unknown> }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lastSentAt = new Map<number, number>();

  constructor(
    private readonly bot: () => BotHandle | null,
    private readonly log: FastifyBaseLogger,
    private readonly appUrl: string | undefined,
  ) {}

  /** Поставить событие в очередь; приоритетные — в начало. */
  emit(userId: number, event: NotificationEvent, priority = false): void {
    const text = render(event);
    const extra = this.appUrl
      ? {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Открыть скринер', web_app: { url: this.appUrl } }],
              ...(event.type === 'threshold_alert'
                ? [[{ text: 'Канал MIDNEX', url: CHANNEL_URL }]]
                : []),
            ],
          },
        }
      : undefined;
    const item = { userId, text, extra };
    if (priority) this.queue.unshift(item);
    else this.queue.push(item);
    this.ensurePump();
  }

  /** Отправить сразу, минуя очередь (напоминания раз в сутки — им очередь ни к чему). */
  async sendNow(userId: number, event: NotificationEvent): Promise<boolean> {
    const bot = this.bot();
    if (!bot) return false;
    return bot.send(userId, render(event));
  }

  private ensurePump(): void {
    if (this.timer) return;
    // 25 сообщений в секунду суммарно — с запасом до лимита Telegram.
    this.timer = setInterval(() => void this.pump(), 40);
  }

  private async pump(): Promise<void> {
    const bot = this.bot();
    if (!bot) return;
    const now = Date.now();
    // Один чат — не чаще раза в секунду: ищем первого, кому можно.
    const idx = this.queue.findIndex((i) => now - (this.lastSentAt.get(i.userId) ?? 0) >= 1000);
    if (idx < 0) {
      if (this.queue.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    const [item] = this.queue.splice(idx, 1);
    this.lastSentAt.set(item!.userId, now);
    try {
      await bot.send(item!.userId, item!.text, item!.extra);
    } catch (err) {
      this.log.warn({ err: String(err), user: item!.userId }, 'уведомления: не отправлено');
    }
  }

  pending(): number {
    return this.queue.length;
  }
}
