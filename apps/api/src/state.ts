/**
 * Состояние пользователя: настройки, позиции, вотчлист, тариф.
 *
 * Читается из хранилища при первом обращении и кешируется в памяти процесса;
 * каждое изменение пишется насквозь. Живые цифры позиций (текущий спред,
 * PnL) считаются при чтении по котировкам рыночного движка — так бумажная
 * позиция следует за настоящим рынком, а не за синтетикой.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BOT,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_RISK,
  DEFAULT_TAKER_PCT,
  ROUND_TRIP_LEGS,
  type ExchangeId,
  type PlanId,
  type Position,
  type PositionFunding,
  type PositionsSummary,
} from '@cs/shared';

import type { MarketSource } from './market.js';
import { fundingRatePct, nextFundingTime } from './mock.js';
import type { PositionRecord, Repo, UserSettings } from './repo/index.js';

const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

export interface UserState {
  userId: number;
  plan: PlanId;
  settings: UserSettings;
  positions: Map<string, PositionRecord>;
  watchlist: Set<string>;
}

export class StateService {
  private readonly cache = new Map<number, Promise<UserState>>();

  constructor(
    private readonly repo: Repo,
    private readonly market: MarketSource,
  ) {}

  // ---------------------------------------------------------------- загрузка

  async forUser(
    userId: number,
    profile?: { username?: string; firstName: string; language?: string },
  ): Promise<UserState> {
    let pending = this.cache.get(userId);
    if (!pending) {
      pending = this.load(userId, profile);
      this.cache.set(userId, pending);
      pending.catch(() => this.cache.delete(userId));
    }
    return pending;
  }

  private async load(
    userId: number,
    profile?: { username?: string; firstName: string; language?: string },
  ): Promise<UserState> {
    const user = await this.repo.upsertUser({
      id: userId,
      username: profile?.username,
      firstName: profile?.firstName ?? '',
      language: profile?.language,
    });

    let settings = await this.repo.getSettings(userId);
    if (!settings) {
      settings = {
        bot: { ...DEFAULT_BOT },
        risk: { ...DEFAULT_RISK },
        notifications: { ...DEFAULT_NOTIFICATIONS },
      };
      await this.repo.saveSettings(userId, settings);
    } else {
      // Новые поля из кода получают значения по умолчанию, старые — из базы.
      settings = {
        bot: { ...DEFAULT_BOT, ...settings.bot },
        risk: { ...DEFAULT_RISK, ...settings.risk },
        notifications: { ...DEFAULT_NOTIFICATIONS, ...settings.notifications },
      };
    }

    let positions = await this.repo.listPositions(userId);
    // Без базы показываем две демонстрационные позиции — иначе экран
    // «Позиции» пуст до M4. В базу фиктивные сделки не пишем.
    if (positions.length === 0 && this.repo.kind === 'memory') {
      positions = demoPositions(userId);
      for (const p of positions) await this.repo.savePosition(p);
    }

    return {
      userId,
      plan: user.plan,
      settings,
      positions: new Map(positions.map((p) => [p.id, p])),
      watchlist: new Set(await this.repo.getWatchlist(userId)),
    };
  }

  // ---------------------------------------------------------------- настройки

  async saveSettings(state: UserState): Promise<void> {
    await this.repo.saveSettings(state.userId, state.settings);
  }

  async setPlan(state: UserState, plan: PlanId): Promise<void> {
    state.plan = plan;
    await this.repo.setPlan(state.userId, plan);
  }

  async setWatchlist(state: UserState, bases: string[]): Promise<void> {
    state.watchlist = new Set(bases);
    await this.repo.setWatchlist(state.userId, bases);
  }

  // ---------------------------------------------------------------- позиции

  /**
   * Текущий спред открытой пары по живым котировкам тех самых двух бирж.
   * Если движок ещё не готов — плавная синтетика, чтобы карточка не пустела.
   */
  private currentSpreadPct(rec: PositionRecord, at: number): number {
    const detail = this.market.live() ? this.market.coinDetail(rec.base) : undefined;
    if (detail) {
      const long = detail.quotes.find((q) => q.exchange === rec.longExchange);
      const short = detail.quotes.find((q) => q.exchange === rec.shortExchange);
      if (long && short && long.ask > 0) return ((short.bid - long.ask) / long.ask) * 100;
    }
    const entry = ((rec.shortEntry - rec.longEntry) / rec.longEntry) * 100;
    const seed = rec.id.charCodeAt(1) || 1;
    return entry * (0.62 + wave(seed * 7, at / 1000, 0.05) * 0.14);
  }

  toPosition(
    rec: PositionRecord,
    executionMode: Position['executionMode'],
    at = Date.now(),
  ): Position {
    const entrySpreadPct = ((rec.shortEntry - rec.longEntry) / rec.longEntry) * 100;
    const notional = rec.longEntry * rec.amount;
    const currentSpreadPct =
      rec.status === 'closed' ? (rec.exitSpreadPct ?? 0) : this.currentSpreadPct(rec, at);
    const pnlUsdt =
      rec.status === 'closed'
        ? (rec.realizedPnlUsdt ?? 0)
        : ((entrySpreadPct - currentSpreadPct) / 100) * notional;

    return {
      id: rec.id,
      symbol: `${rec.base}/USDT:USDT`,
      base: rec.base,
      name: rec.base,
      status: rec.status,
      executionMode: rec.executionMode ?? executionMode,
      long: {
        exchange: rec.longExchange,
        side: 'long',
        entryPrice: rec.longEntry,
        amount: rec.amount,
        notional,
      },
      short: {
        exchange: rec.shortExchange,
        side: 'short',
        entryPrice: rec.shortEntry,
        amount: rec.amount,
        notional: rec.shortEntry * rec.amount,
      },
      entrySpreadPct,
      currentSpreadPct,
      leverage: rec.leverage,
      pnlUsdt,
      pnlPct: (pnlUsdt / notional) * 100,
      openedAt: rec.openedAt,
      closedAt: rec.closedAt ?? undefined,
    };
  }

  summary(open: Position[]): PositionsSummary {
    const totalPnl = open.reduce((s, p) => s + p.pnlUsdt, 0);
    return {
      openCount: open.length,
      totalPnlUsdt: totalPnl,
      unrealizedPnlUsdt: totalPnl,
      capitalInUseUsdt: open.reduce((s, p) => s + p.long.notional + p.short.notional, 0),
    };
  }

  roundTripFeesUsdt(rec: PositionRecord): number {
    return ((DEFAULT_TAKER_PCT * ROUND_TRIP_LEGS) / 100) * rec.longEntry * rec.amount;
  }

  positionFunding(rec: PositionRecord, at = Date.now()): PositionFunding {
    const longRatePct = fundingRatePct(rec.base, rec.longExchange, at);
    const shortRatePct = fundingRatePct(rec.base, rec.shortExchange, at);
    const perPeriodPct = shortRatePct - longRatePct;
    const end = rec.closedAt ?? at;
    const periodsElapsed = Math.floor((end - rec.openedAt) / FUNDING_INTERVAL_MS);
    const netPct = perPeriodPct * periodsElapsed;
    return {
      longRatePct,
      shortRatePct,
      netPct,
      netUsdt: (netPct / 100) * rec.longEntry * rec.amount,
      nextAt: nextFundingTime(at),
      periodsElapsed,
    };
  }

  async adjustPosition(
    state: UserState,
    rec: PositionRecord,
    patch: { targetSpreadPct?: number | null; stopSpreadPct?: number | null },
  ): Promise<void> {
    if (patch.targetSpreadPct !== undefined) rec.targetSpreadPct = patch.targetSpreadPct;
    if (patch.stopSpreadPct !== undefined) rec.stopSpreadPct = patch.stopSpreadPct;
    await this.repo.savePosition(rec);
  }

  /** Закрытие: маркет на обеих ногах разом (ТЗ §6.2), без частичных состояний. */
  async closePosition(
    state: UserState,
    rec: PositionRecord,
    reason: NonNullable<PositionRecord['closeReason']>,
  ): Promise<Position> {
    const at = Date.now();
    const live = this.toPosition(rec, state.settings.bot.executionMode, at);
    rec.status = 'closed';
    rec.closedAt = at;
    rec.realizedPnlUsdt = live.pnlUsdt;
    rec.exitSpreadPct = live.currentSpreadPct;
    rec.closeReason = reason;
    await this.repo.savePosition(rec);
    return this.toPosition(rec, state.settings.bot.executionMode, at);
  }
}

// ---------------------------------------------------------------- вспомогательное

function wave(seed: number, t: number, speed: number): number {
  return (
    Math.sin(t * speed + seed * 1.7) * 0.6 +
    Math.sin(t * speed * 2.3 + seed * 4.1) * 0.3 +
    Math.sin(t * speed * 5.1 + seed * 9.3) * 0.1
  );
}

function demoPositions(userId: number): PositionRecord[] {
  const now = Date.now();
  const mk = (
    base: string,
    longExchange: ExchangeId,
    shortExchange: ExchangeId,
    longEntry: number,
    shortEntry: number,
    amount: number,
    minutesAgo: number,
    target: number,
    stop: number,
  ): PositionRecord => ({
    id: randomUUID(),
    userId,
    base,
    executionMode: 'paper',
    longExchange,
    shortExchange,
    longEntry,
    shortEntry,
    amount,
    leverage: 10,
    targetSpreadPct: target,
    stopSpreadPct: stop,
    status: 'open',
    openedAt: now - minutesAgo * 60_000,
    closedAt: null,
    exitSpreadPct: null,
    realizedPnlUsdt: null,
    closeReason: null,
  });
  return [
    mk('BTC', 'binance', 'bybit', 66245.3, 66815.2, 0.01, 26, 0.1, 1.6),
    mk('ETH', 'okx', 'binance', 3142.65, 3177.1, 0.2, 590, 0.15, 2),
  ];
}
