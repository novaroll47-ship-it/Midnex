/**
 * Состояние пользователя в памяти процесса.
 *
 * На M3 это переезжает в Postgres и становится состоянием *каждого*
 * пользователя отдельно. Сейчас это один общий набор настроек и позиций —
 * ровно столько, сколько нужно, чтобы экраны настроек и кнопки позиций
 * действительно работали, а не были картинками.
 */
import {
  DEFAULT_BOT,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_RISK,
  DEFAULT_TAKER_PCT,
  ROUND_TRIP_LEGS,
  type BotSettings,
  type ExchangeId,
  type NotificationSettings,
  type PlanId,
  type Position,
  type PositionFunding,
  type PositionsSummary,
  type RiskSettings,
} from '@cs/shared';

import { fundingRatePct, nextFundingTime } from './mock.js';

/** Запись о позиции: то, что действительно хранится. Живые цифры считаются при чтении. */
export interface PositionRecord {
  id: string;
  base: string;
  name: string;
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  longEntry: number;
  shortEntry: number;
  amount: number;
  leverage: number;
  openedAt: number;
  status: 'open' | 'closed';
  closedAt?: number;
  /** Зафиксированный PnL на момент закрытия. */
  realizedPnlUsdt?: number;
  /** Спред в момент закрытия — на нём и зафиксирован результат. */
  exitSpreadPct?: number;
  closeReason?: 'manual' | 'target' | 'risk' | 'timeout';
  targetSpreadPct: number | null;
  stopSpreadPct: number | null;
}

interface Store {
  bot: BotSettings;
  risk: RiskSettings;
  notifications: NotificationSettings;
  plan: PlanId;
  positions: PositionRecord[];
  /** Монеты, отмеченные для торговли (чекбоксы в скринере). */
  watchlist: string[];
}

const now = Date.now();

export const store: Store = {
  bot: { ...DEFAULT_BOT },
  risk: { ...DEFAULT_RISK },
  notifications: { ...DEFAULT_NOTIFICATIONS },
  plan: 'unlimited',
  watchlist: [],
  positions: [
    {
      id: 'p1',
      base: 'BTC',
      name: 'Bitcoin',
      longExchange: 'binance',
      shortExchange: 'bybit',
      longEntry: 66245.3,
      shortEntry: 66815.2,
      amount: 0.01,
      leverage: 10,
      openedAt: now - 26 * 60_000,
      status: 'open',
      targetSpreadPct: 0.1,
      stopSpreadPct: 1.6,
    },
    {
      id: 'p2',
      base: 'ETH',
      name: 'Ethereum',
      longExchange: 'okx',
      shortExchange: 'binance',
      longEntry: 3142.65,
      shortEntry: 3177.1,
      amount: 0.2,
      leverage: 10,
      openedAt: now - 590 * 60_000,
      status: 'open',
      targetSpreadPct: 0.15,
      stopSpreadPct: 2,
    },
  ],
};

/** Плавный детерминированный дрейф — тот же приём, что в мок-скринере. */
function wave(seed: number, t: number, speed: number): number {
  return (
    Math.sin(t * speed + seed * 1.7) * 0.6 +
    Math.sin(t * speed * 2.3 + seed * 4.1) * 0.3 +
    Math.sin(t * speed * 5.1 + seed * 9.3) * 0.1
  );
}

/** Текущий спред открытой позиции: сходится к нулю, но может и разойтись. */
function liveSpreadPct(rec: PositionRecord, at: number): number {
  const entry = ((rec.shortEntry - rec.longEntry) / rec.longEntry) * 100;
  const seed = rec.id.charCodeAt(1) || 1;
  const convergence = 0.62 + wave(seed * 7, at / 1000, 0.05) * 0.14;
  return entry * convergence;
}

export function toPosition(rec: PositionRecord, at = Date.now()): Position {
  const entrySpreadPct = ((rec.shortEntry - rec.longEntry) / rec.longEntry) * 100;
  const notional = rec.longEntry * rec.amount;

  const currentSpreadPct =
    rec.status === 'closed' ? (rec.exitSpreadPct ?? 0) : liveSpreadPct(rec, at);

  const pnlUsdt =
    rec.status === 'closed'
      ? (rec.realizedPnlUsdt ?? 0)
      : ((entrySpreadPct - currentSpreadPct) / 100) * notional * 2.9;

  return {
    id: rec.id,
    symbol: `${rec.base}/USDT:USDT`,
    base: rec.base,
    name: rec.name,
    status: rec.status,
    executionMode: store.bot.executionMode,
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
    closedAt: rec.closedAt,
  };
}

export function summary(open: Position[]): PositionsSummary {
  const totalPnl = open.reduce((s, p) => s + p.pnlUsdt, 0);
  return {
    openCount: open.length,
    totalPnlUsdt: totalPnl,
    unrealizedPnlUsdt: totalPnl,
    capitalInUseUsdt: open.reduce((s, p) => s + p.long.notional + p.short.notional, 0),
  };
}

/** Комиссии round-trip по позиции, USDT — для экрана деталей. */
export function roundTripFeesUsdt(rec: PositionRecord): number {
  const notional = rec.longEntry * rec.amount;
  return ((DEFAULT_TAKER_PCT * ROUND_TRIP_LEGS) / 100) * notional;
}

export function findPosition(id: string): PositionRecord | undefined {
  return store.positions.find((p) => p.id === id);
}

/**
 * Закрытие позиции. В ТЗ §6.2 закрытие — всегда маркет на обеих биржах
 * одновременно, поэтому здесь нет частичных состояний: либо закрыта, либо нет.
 */
export function closePosition(id: string, reason: PositionRecord['closeReason'] = 'manual') {
  const rec = findPosition(id);
  if (!rec || rec.status === 'closed') return undefined;

  const at = Date.now();
  const live = toPosition(rec, at);
  rec.status = 'closed';
  rec.closedAt = at;
  rec.realizedPnlUsdt = live.pnlUsdt;
  rec.exitSpreadPct = live.currentSpreadPct;
  rec.closeReason = reason;
  return toPosition(rec, at);
}

/** Интервал выплат фандинга — 8 часов, как у большинства бирж. */
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

/**
 * Фандинг по парной позиции.
 *
 * Лонг платит фандинг при положительной ставке, шорт его получает, поэтому
 * итог для дельта-нейтральной пары — разница ставок на двух биржах. Это
 * ровно та величина, которая может съесть прибыль от схождения спреда.
 */
export function positionFunding(rec: PositionRecord, at = Date.now()): PositionFunding {
  const longRatePct = fundingRatePct(rec.base, rec.longExchange, at);
  const shortRatePct = fundingRatePct(rec.base, rec.shortExchange, at);
  const perPeriodPct = shortRatePct - longRatePct;

  const end = rec.closedAt ?? at;
  const periodsElapsed = Math.floor((end - rec.openedAt) / FUNDING_INTERVAL_MS);

  const netPct = perPeriodPct * periodsElapsed;
  const notional = rec.longEntry * rec.amount;

  return {
    longRatePct,
    shortRatePct,
    netPct,
    netUsdt: (netPct / 100) * notional,
    nextAt: nextFundingTime(at),
    periodsElapsed,
  };
}
