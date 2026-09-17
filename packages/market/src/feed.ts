/**
 * Поток котировок с одной биржи.
 *
 * Стратегия: сначала WebSocket через ccxt.pro — он даёт обновления по мере
 * прихода. Если биржа его не поддерживает или соединение разваливается,
 * переходим на REST-опрос всех тикеров одним запросом. Опрос медленнее, но
 * гарантированно работает у всех восьми, поэтому именно он — страховка,
 * а не WebSocket.
 *
 * Поток никогда не «умирает»: любая ошибка логируется, соединение
 * переподнимается с растущей паузой. Замершие котировки при этом остаются
 * в памяти, но помечаются устаревшими по времени последнего обновления —
 * этим занимается движок спредов, здесь только сбор.
 */
import type { Exchange, Ticker } from 'ccxt';
import type { ExchangeId } from '@cs/shared';

import type { VenueMarket } from './universe.js';

export interface Quote {
  bid: number;
  ask: number;
  last: number;
  /** Когда котировка пришла на сервер, мс. */
  receivedAt: number;
}

export type FeedMode = 'ws' | 'rest';
export type FeedStatus = 'starting' | 'live' | 'reconnecting' | 'down';

export interface FeedState {
  exchange: ExchangeId;
  mode: FeedMode;
  status: FeedStatus;
  /** Сколько символов вселенной обслуживает эта биржа. */
  symbols: number;
  /** Сколько из них получили хотя бы одну котировку. */
  quoted: number;
  lastUpdateAt: number | null;
  /** Время последнего REST-запроса или последнего WS-сообщения. */
  latencyMs: number | null;
  reconnects: number;
  lastError: string | null;
}

export interface FeedLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface FeedOptions {
  exchange: ExchangeId;
  client: Exchange;
  markets: VenueMarket[];
  /** Интервал REST-опроса. */
  pollMs: number;
  onQuote: (market: VenueMarket, quote: Quote) => void;
  /** Биржа перестала давать данные / снова даёт — для журнала дыр. */
  onGap?: (exchange: ExchangeId, reason: GapReason | null) => void;
  log: FeedLogger;
}

export type GapReason = 'ws_closed' | 'ws_stall' | 'rest_429' | 'rest_error' | 'rest_fallback';

/**
 * Экспоненциальный backoff с джиттером: 1–2 с → до 60 с, разброс ±30 %,
 * чтобы восемь бирж после общего обрыва сети не ломились обратно разом.
 */
function nextBackoff(prevMs: number): number {
  const base = Math.min(Math.max(prevMs * 2, 1000), 60_000);
  const jitter = 1 + (Math.random() * 0.6 - 0.3);
  return Math.round(base * jitter);
}

/** Пауза, которую просит биржа при 429/418; если не просит — минута. */
function retryAfterMs(message: string): number {
  const m = /retry[- ]after[^0-9]*(\d+)/i.exec(message);
  if (m) return Math.min(Number(m[1]) * 1000, 5 * 60_000);
  return 60_000;
}

function isRateLimited(message: string): boolean {
  return /\b(429|418)\b|rate ?limit|too many requests|ddos/i.test(message);
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return undefined;
}

export class Feed {
  readonly state: FeedState;
  private readonly bySymbol: Map<string, VenueMarket>;
  private running = false;
  private restTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: FeedOptions) {
    this.bySymbol = new Map(opts.markets.map((m) => [m.symbol, m]));
    this.state = {
      exchange: opts.exchange,
      mode: opts.client.has['watchTickers'] ? 'ws' : 'rest',
      status: 'starting',
      symbols: opts.markets.length,
      quoted: 0,
      lastUpdateAt: null,
      latencyMs: null,
      reconnects: 0,
      lastError: null,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.state.mode === 'ws') void this.runWs();
    else this.runRest();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.restTimer) clearInterval(this.restTimer);
    this.restTimer = null;
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = null;
    try {
      await this.opts.client.close();
    } catch {
      // Соединение уже могло быть закрыто самой биржей.
    }
  }

  private readonly quotedSymbols = new Set<string>();

  private ingest(tickers: Record<string, Ticker>, receivedAt: number): void {
    let touched = 0;
    for (const [symbol, t] of Object.entries(tickers)) {
      const market = this.bySymbol.get(symbol);
      if (!market) continue;

      // Котировка стакана предпочтительнее последней сделки: спред на вход
      // исполняется по bid/ask, а last может быть минуту назад.
      const bid = pickNumber(t.bid, t.last, t.close);
      const ask = pickNumber(t.ask, t.last, t.close);
      const last = pickNumber(t.last, t.close, t.bid);
      if (!bid || !ask || !last) continue;

      // Приводим к цене за одну монету: 1000PEPE → PEPE.
      const k = market.multiplier;
      this.opts.onQuote(market, { bid: bid / k, ask: ask / k, last: last / k, receivedAt });
      this.quotedSymbols.add(symbol);
      touched++;
    }
    if (touched > 0) {
      this.state.lastUpdateAt = receivedAt;
      this.state.quoted = this.quotedSymbols.size;
    }
  }

  // ---------------------------------------------------------------- WebSocket

  /**
   * Провалы WS подряд. Обрыв после устойчивой работы — не провал: биржи
   * штатно рвут соединение раз в несколько минут. Провал — это когда
   * соединение падает, так и не продержавшись STABLE_MS.
   */
  private wsStrikes = 0;
  private static readonly STABLE_MS = 30_000;
  private static readonly MAX_STRIKES = 3;
  /** Тихий обрыв: сокет открыт, но тиков нет дольше этого — переподключаемся. */
  private static readonly STALL_MS = 20_000;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private gapOpen = false;

  private gap(reason: GapReason | null): void {
    if (reason === null && !this.gapOpen) return;
    this.gapOpen = reason !== null;
    this.opts.onGap?.(this.opts.exchange, reason);
  }

  /**
   * Сторож тишины. ccxt держит ping-pong по правилам каждой биржи, но
   * бывает, что соединение живо, а данные перестали идти; тогда watchTickers
   * висит бесконечно. Закрываем клиент — ожидание оборвётся исключением,
   * и цикл переподключится обычным путём.
   */
  private armStallWatch(): void {
    if (this.stallTimer) return;
    this.stallTimer = setInterval(() => {
      if (!this.running || this.state.mode !== 'ws') return;
      const last = this.state.lastUpdateAt;
      if (last !== null && Date.now() - last > Feed.STALL_MS && this.state.status === 'live') {
        this.state.status = 'reconnecting';
        this.opts.log.warn(
          `${this.opts.exchange}: тишина ${Feed.STALL_MS / 1000} с — переподключаюсь`,
        );
        this.gap('ws_stall');
        void this.opts.client.close().catch(() => {});
      }
    }, 5000);
  }

  private async runWs(): Promise<void> {
    const { client, log, exchange } = this.opts;
    let backoffMs = 0;
    this.armStallWatch();

    while (this.running) {
      const connectedAt = Date.now();
      try {
        this.state.status = this.state.reconnects > 0 ? 'reconnecting' : 'starting';
        // Без списка символов биржа отдаёт общий поток по всем рынкам —
        // одно соединение вместо сотен подписок. Если биржа так не умеет,
        // ccxt бросит исключение, и ниже мы попробуем явный список.
        // Список берётся заново при каждом подключении — ресабскрайб после
        // обрыва идёт на актуальный набор рынков.
        const symbols = this.wantsSymbolList ? this.opts.markets.map((m) => m.symbol) : undefined;
        while (this.running) {
          const t0 = Date.now();
          const tickers = await client.watchTickers(symbols);
          const now = Date.now();
          this.ingest(tickers, now);
          this.state.latencyMs = now - t0;
          this.state.status = 'live';
          this.state.lastError = null;
          this.gap(null);
          backoffMs = 0;
          if (now - connectedAt >= Feed.STABLE_MS) this.wsStrikes = 0;
        }
      } catch (err) {
        if (!this.running) return;
        const message = err instanceof Error ? err.message : String(err);
        this.state.lastError = message.slice(0, 200);
        this.state.reconnects++;
        this.gap(isRateLimited(message) ? 'rest_429' : 'ws_closed');

        // Первая неудача без списка символов — пробуем со списком.
        if (!this.wantsSymbolList && /symbol|argument|requires/i.test(message)) {
          this.wantsSymbolList = true;
          log.warn(`${exchange}: общий поток недоступен, подписываюсь по списку символов`);
          continue;
        }

        const heldMs = Date.now() - connectedAt;
        if (heldMs < Feed.STABLE_MS) this.wsStrikes++;

        // Несколько провалов подряд без устойчивой работы — сдаёмся на REST.
        // Лучше опрос раз в две секунды, чем вечное переподключение без данных.
        if (this.wsStrikes >= Feed.MAX_STRIKES) {
          log.warn(
            `${exchange}: WebSocket не держится (${message.slice(0, 80)}), перехожу на REST`,
          );
          this.state.mode = 'rest';
          this.gap('rest_fallback');
          this.runRest();
          return;
        }

        // 429/418 — биржа просит паузу; иначе экспоненциальный backoff с джиттером.
        backoffMs = isRateLimited(message) ? retryAfterMs(message) : nextBackoff(backoffMs);
        log.warn(
          `${exchange}: WS оборвался после ${Math.round(heldMs / 1000)}с (${message.slice(0, 80)}), ` +
            `повтор через ${Math.round(backoffMs / 1000)}с`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  private wantsSymbolList = false;

  // ---------------------------------------------------------------- REST

  private runRest(): void {
    const { client, log, exchange, pollMs } = this.opts;
    let inFlight = false;
    let pausedUntil = 0;

    const tick = async () => {
      if (!this.running || inFlight || Date.now() < pausedUntil) return;
      inFlight = true;
      const t0 = Date.now();
      try {
        const tickers = await client.fetchTickers();
        const now = Date.now();
        this.ingest(tickers, now);
        this.state.latencyMs = now - t0;
        this.state.status = 'live';
        this.state.lastError = null;
        this.gap(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.state.status = 'reconnecting';
        this.state.lastError = message.slice(0, 200);
        this.state.reconnects++;
        if (isRateLimited(message)) {
          // Лимит: слепой повтор только продлит бан — ждём, сколько просят.
          pausedUntil = Date.now() + retryAfterMs(message);
          this.gap('rest_429');
          log.warn(
            `${exchange}: лимит запросов, пауза ${Math.round((pausedUntil - Date.now()) / 1000)} с`,
          );
        } else {
          this.gap('rest_error');
          log.warn(`${exchange}: REST-опрос не удался (${message.slice(0, 80)})`);
        }
      } finally {
        inFlight = false;
      }
    };

    void tick();
    this.restTimer = setInterval(() => void tick(), pollMs);
  }
}
