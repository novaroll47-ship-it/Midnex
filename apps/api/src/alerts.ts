/**
 * Пороговые алерты по спреду.
 *
 * Правила пользователей лежат в памяти, индексированные по монете (плюс
 * отдельный список общих правил), и проверяются на каждом снимке скринера —
 * раз в секунду, без обращений к базе. База — только для хранения правил и
 * состояния «взведено», чтобы после рестарта не выстрелить повторно.
 *
 * Гистерезис: правило срабатывает один раз при пересечении порога снизу
 * вверх и снова взводится, когда спред опустился ниже порога на буфер
 * (0,3 %) — иначе колебания около порога дали бы сообщение каждую секунду.
 *
 * Уведомления идут только пользователям с активным доступом: без подписки
 * правило можно создать, но оно молчит (и интерфейс об этом говорит).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { SpreadRow } from '@cs/shared';

import type { Billing } from './billing.js';
import type { MarketSource } from './market.js';
import type { NotificationService } from './notifications.js';
import type { AlertRuleRecord, Repo } from './repo/index.js';

const REARM_BUFFER_PCT = 0.3;

export class AlertEngine {
  private byBase = new Map<string, AlertRuleRecord[]>();
  private global: AlertRuleRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirty = new Set<string>();
  /** Кэш доступа: userId → до какого времени доступ проверен. */
  private access = new Map<number, { ok: boolean; until: number }>();

  constructor(
    private readonly repo: Repo,
    private readonly market: MarketSource,
    private readonly notify: NotificationService,
    private readonly billing: Billing,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.tick(), 1000);
    // Состояние «взведено» — в базу раз в минуту, а не на каждое срабатывание.
    setInterval(() => void this.flush(), 60_000);
    this.log.info(`алерты: правил ${this.count()}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.flush();
  }

  /** Перечитать все правила из базы (при старте и после изменения). */
  async reload(): Promise<void> {
    const rules = await this.repo.listAlertRules();
    this.byBase = new Map();
    this.global = [];
    for (const r of rules) {
      if (r.type === 'global' || !r.base) this.global.push(r);
      else this.byBase.set(r.base, [...(this.byBase.get(r.base) ?? []), r]);
    }
  }

  /** Пользователь изменил свои правила — обновить только их. */
  async reloadUser(userId: number): Promise<void> {
    await this.flush();
    await this.reload();
    this.access.delete(userId);
  }

  count(): number {
    let n = this.global.length;
    for (const list of this.byBase.values()) n += list.length;
    return n;
  }

  private async hasAccess(userId: number): Promise<boolean> {
    const cached = this.access.get(userId);
    const now = Date.now();
    if (cached && cached.until > now) return cached.ok;
    const ok = await this.billing.hasAccess(userId);
    this.access.set(userId, { ok, until: now + 60_000 });
    return ok;
  }

  private async tick(): Promise<void> {
    if (!this.market.live()) return;
    if (this.global.length === 0 && this.byBase.size === 0) return;
    const rows = this.market.snapshot(0).rows;
    for (const row of rows) {
      if (row.stale || row.suspect) continue;
      const rules = [...(this.byBase.get(row.base) ?? []), ...this.global];
      for (const rule of rules) await this.check(rule, row);
    }
  }

  private async check(rule: AlertRuleRecord, row: SpreadRow): Promise<void> {
    const above = row.spreadPct >= rule.thresholdPct;
    if (rule.isArmed && above) {
      if (!(await this.hasAccess(rule.userId))) return;
      rule.isArmed = false;
      rule.lastFiredAt = Date.now();
      rule.lastBase = row.base;
      this.dirty.add(rule.id);
      this.notify.emit(rule.userId, {
        type: 'threshold_alert',
        base: row.base,
        longExchange: row.longExchange,
        shortExchange: row.shortExchange,
        spreadPct: row.spreadPct,
        thresholdPct: rule.thresholdPct,
        rule: rule.type,
      });
      return;
    }
    // Общее правило взводится обратно, когда ни одна монета не держит порог;
    // здесь достаточно, чтобы именно эта монета опустилась ниже буфера.
    if (!rule.isArmed && row.spreadPct < rule.thresholdPct - REARM_BUFFER_PCT) {
      if (rule.type === 'global' && rule.lastBase && rule.lastBase !== row.base) return;
      rule.isArmed = true;
      this.dirty.add(rule.id);
    }
  }

  private async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    const all = [...this.global, ...[...this.byBase.values()].flat()];
    for (const id of ids) {
      const rule = all.find((r) => r.id === id);
      if (!rule) continue;
      try {
        await this.repo.updateAlertState(rule.id, rule.isArmed, rule.lastFiredAt, rule.lastBase);
      } catch (err) {
        this.log.warn({ err: String(err) }, 'алерты: состояние не сохранено');
      }
    }
  }
}
