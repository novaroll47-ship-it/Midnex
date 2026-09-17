/**
 * Мониторинг листингов: раз в 10 минут перечитываем инструменты каждой
 * биржи и сравниваем с прошлым снимком.
 *
 * Новая нога → кандидат на сверку (в ленту не попадает, пока администратор
 * её не подтвердит) + сообщение администратору. Пропавшая нога → статус
 * delisted, пара уходит из ленты, а пользователи с алертом на эту монету
 * получают предупреждение вне очереди.
 */
import type { FastifyBaseLogger } from 'fastify';
import { EXCHANGES, type ExchangeId } from '@cs/shared';
import type { MarketEngine } from '@cs/market';

import type { NotificationService } from './notifications.js';
import type { PairsService } from './pairs.js';
import type { Repo } from './repo/index.js';

export interface ListingsOptions {
  engine: MarketEngine | null;
  pairs: PairsService;
  repo: Repo;
  notify: NotificationService;
  log: FastifyBaseLogger;
  /** Сообщить администратору (текст + кнопка на сверку). */
  notifyAdmin: (text: string) => void;
  intervalMs?: number;
}

export class ListingsMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly o: ListingsOptions) {}

  start(): void {
    if (this.timer || !this.o.engine) return;
    const every = this.o.intervalMs ?? 10 * 60_000;
    // Первый проход — через полный интервал: сразу после старта снимок и так свежий.
    this.timer = setInterval(() => void this.check(), every);
    this.o.log.info(`листинги: проверка каждые ${Math.round(every / 60_000)} мин`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    if (this.running || !this.o.engine) return;
    this.running = true;
    try {
      const added: string[] = [];
      const removed: { base: string; exchange: ExchangeId }[] = [];
      for (const ex of EXCHANGES) {
        try {
          const diff = await this.o.engine.refreshMarkets(ex.id);
          if (!diff) continue;
          // Новые ноги: кандидаты создаст хук onMarketsChanged; здесь — только список.
          for (const m of diff.added) added.push(`${m.base} (${ex.name})`);
          for (const m of diff.removed) {
            removed.push({ base: m.base, exchange: m.exchange });
            await this.o.pairs.setStatus(m.exchange, m.symbol, 'delisted', undefined, 'listings');
          }
        } catch (err) {
          this.o.log.warn(
            { exchange: ex.id, err: String(err).slice(0, 120) },
            'листинги: не перечитал рынки',
          );
        }
      }
      if (added.length) {
        this.o.log.info(`листинги: новых инструментов ${added.length}`);
        this.o.notifyAdmin(
          `🆕 Новые инструменты (${added.length}): ${added.slice(0, 15).join(', ')}${added.length > 15 ? '…' : ''}\n` +
            'Они ждут сверки — Настройки → Сверка пар.',
        );
      }
      if (removed.length) {
        this.o.log.info(`листинги: делистинг ${removed.length}`);
        await this.warnAboutDelisting(removed);
        this.o.notifyAdmin(
          `⚠️ Делистинг (${removed.length}): ${removed.map((r) => `${r.base} (${r.exchange})`).join(', ')}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** Все, у кого есть правило на монету, получают предупреждение вне очереди. */
  private async warnAboutDelisting(
    removed: { base: string; exchange: ExchangeId }[],
  ): Promise<void> {
    const rules = await this.o.repo.listAlertRules();
    for (const r of removed) {
      const users = new Set(
        rules
          .filter((rule) => rule.type === 'pair' && rule.base === r.base)
          .map((rule) => rule.userId),
      );
      for (const userId of users) {
        this.o.notify.emit(
          userId,
          { type: 'delisting_warning', base: r.base, exchange: r.exchange },
          true,
        );
      }
    }
  }
}
