/** Экран «Скринер» — макет docs/mockup-screener.png. */
import {
  EXCHANGES,
  PLAN_WATCHLIST_LIMIT,
  exchange,
  formatClock,
  formatDelta,
  formatPct,
  formatPrice,
  formatSignedPct,
  priceDecimals,
  type ExchangeId,
  type ScreenerSnapshot,
  type SpreadRow,
} from '@cs/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CoinIcon } from '../components/CoinIcon';
import { Sparkline } from '../components/Sparkline';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BoltIcon,
  CheckIcon,
  ChevronDownIcon,
  GearIcon,
  PlusIcon,
  SlidersIcon,
} from '../icons';
import { api } from '../lib/api';
import { haptic } from '../lib/telegram';
import { usePolling } from '../lib/usePolling';

interface Props {
  onOpenSettings: () => void;
  plan: keyof typeof PLAN_WATCHLIST_LIMIT;
  minSpreadPct?: number;
  refreshMs: number;
}

export function ScreenerScreen({ onOpenSettings, plan, minSpreadPct, refreshMs }: Props) {
  const { t } = useTranslation();

  const [minSpread, setMinSpread] = useState('0.50');
  const [coinFilter, setCoinFilter] = useState('all');
  const [venueFilter, setVenueFilter] = useState<'all' | ExchangeId>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Порог берём из настроек бота, но как только пользователь потрогал поле
  // на этом экране — фильтр становится его, и настройки его больше не трогают.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current && minSpreadPct !== undefined) setMinSpread(minSpreadPct.toFixed(2));
  }, [minSpreadPct]);

  const minSpreadNum = Number(minSpread.replace(',', '.')) || 0;

  const fetcher = useCallback(() => api.screener(minSpreadNum), [minSpreadNum]);
  const { data, error, refresh } = usePolling<ScreenerSnapshot>(fetcher, refreshMs);

  const rows = data?.rows ?? [];

  const coinOptions = useMemo(() => [...new Set(rows.map((r) => r.base))].sort(), [rows]);

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (coinFilter !== 'all' && r.base !== coinFilter) return false;
        if (
          venueFilter !== 'all' &&
          r.longExchange !== venueFilter &&
          r.shortExchange !== venueFilter
        )
          return false;
        return true;
      }),
    [rows, coinFilter, venueFilter],
  );

  const watchlistLimit = PLAN_WATCHLIST_LIMIT[plan] ?? null;
  const limitReached = watchlistLimit !== null && selected.size >= watchlistLimit;

  function toggle(symbol: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else if (!limitReached) next.add(symbol);
      else return prev;
      return next;
    });
    haptic('tap');
  }

  const refreshSeconds = Math.max(1, Math.round(refreshMs / 1000));

  return (
    <div className="screener">
      <div className="screener__top">
        {/* Статус бота */}
        <section className="card bot-card">
          <div>
            <div className="bot-card__status">
              {t('screener.bot')}{' '}
              <span
                className={data?.botRunning === false ? 'bot-card__state--off' : 'bot-card__state'}
              >
                {data?.botRunning === false ? t('screener.stopped') : t('screener.active')}
                <i className="bot-card__dot" />
              </span>
            </div>
            <div className="bot-card__activity">
              {data?.botRunning === false ? t('screener.idle') : t('screener.scanning')}
            </div>
          </div>
          <button className="btn-ghost" type="button" onClick={onOpenSettings}>
            <GearIcon size={15} />
            {t('screener.botSettings')}
          </button>
        </section>

        {/* Сводные показатели */}
        <section className="stats">
          <div className="card stat">
            <div className="stat__label">{t('screener.found')}</div>
            <div className="stat__row">
              <span className="stat__value num">{data?.opportunities ?? '—'}</span>
              <Sparkline values={data?.trend ?? []} />
            </div>
          </div>
          <div className="card stat">
            <div className="stat__label">{t('screener.avgSpread')}</div>
            <div className="stat__value num">{data ? formatPct(data.avgSpreadPct) : '—'}</div>
          </div>
          <div className="card stat">
            <div className="stat__label">{t('screener.refreshRate')}</div>
            <div className="stat__value num">
              {t('screener.secondsShort', { count: refreshSeconds })}
            </div>
          </div>
        </section>

        {/* Фильтры */}
        <section className="filters">
          <div className="select-wrap">
            <select
              className="select"
              value={coinFilter}
              onChange={(e) => setCoinFilter(e.target.value)}
              aria-label={t('screener.allCoins')}
            >
              <option value="all">{t('screener.allCoins')}</option>
              {coinOptions.map((base) => (
                <option key={base} value={base}>
                  {base}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="select-wrap__chevron" />
          </div>

          <div className="select-wrap">
            <select
              className="select"
              value={venueFilter}
              onChange={(e) => setVenueFilter(e.target.value as 'all' | ExchangeId)}
              aria-label={t('screener.allExchanges')}
            >
              <option value="all">{t('screener.allExchanges')}</option>
              {EXCHANGES.map((ex) => (
                <option key={ex.id} value={ex.id}>
                  {ex.name}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="select-wrap__chevron" />
          </div>

          <div className="field">
            <span className="field__label">{t('screener.minSpread')}</span>
            <input
              className="input num"
              inputMode="decimal"
              value={`${minSpread}%`}
              onChange={(e) => {
                touched.current = true;
                setMinSpread(e.target.value.replace('%', ''));
              }}
            />
          </div>

          <button className="icon-btn-square" type="button" aria-label={t('screener.moreFilters')}>
            <SlidersIcon size={17} />
          </button>
        </section>

        <div className="table-head">
          <span />
          <span>{t('screener.colCoin')}</span>
          <span>{t('screener.colVenue1')}</span>
          <span>{t('screener.colVenue2')}</span>
          <span>{t('screener.colSpread')}</span>
          <span />
        </div>
      </div>

      {/* Скроллится только список монет — шапка и подвал стоят на месте. */}
      <div className="screener__list">
        {visible.map((row) => (
          <CoinRow
            key={row.symbol}
            row={row}
            checked={selected.has(row.symbol)}
            disabled={!selected.has(row.symbol) && limitReached}
            onToggle={() => toggle(row.symbol)}
          />
        ))}
        {visible.length === 0 && <div className="card empty">{t('screener.empty')}</div>}
        {watchlistLimit !== null && (
          <div className="watchlist-note">
            {t('screener.watchlistLimit', { count: watchlistLimit })} — {selected.size}/
            {watchlistLimit}
          </div>
        )}
      </div>

      <section className="card autorefresh screener__footer">
        <BoltIcon size={17} className="autorefresh__icon" />
        <div className="autorefresh__text">
          <div className="autorefresh__title">
            {t('screener.autoRefresh', { count: refreshSeconds })}
          </div>
          <div className="autorefresh__sub">
            {error
              ? t('app.loadError')
              : t('screener.lastUpdate', { time: formatClock(data?.updatedAt ?? Date.now()) })}
          </div>
        </div>
        <button className="btn-ghost btn-ghost--green" type="button" onClick={refresh}>
          {t('screener.refreshNow')}
        </button>
      </section>
    </div>
  );
}

function CoinRow({
  row,
  checked,
  disabled,
  onToggle,
}: {
  row: SpreadRow;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const decimals = priceDecimals(row.longPrice);
  const direction = row.spreadPct > 0.0001 ? 'up' : row.spreadPct < -0.0001 ? 'down' : 'flat';
  const spreadText = formatDelta(row.spreadAbs, decimals);

  return (
    <div className={`coin-row${row.stale ? ' coin-row--stale' : ''}`}>
      <button
        type="button"
        className={`checkbox${checked ? ' checkbox--on' : ''}${disabled ? ' checkbox--disabled' : ''}`}
        onClick={onToggle}
        aria-pressed={checked}
        aria-label={row.base}
      >
        <CheckIcon />
      </button>

      <div className="coin-id">
        <CoinIcon base={row.base} />
        <div className="coin-id__text">
          <div className="coin-id__ticker">{row.base}</div>
          <div className="coin-id__name">{row.name}</div>
        </div>
      </div>

      <Venue id={row.longExchange} price={row.longPrice} decimals={decimals} side="long" />
      <Venue id={row.shortExchange} price={row.shortPrice} decimals={decimals} side="short" />

      <div className={`spread spread--${direction}`}>
        <div className={`spread__abs num${isLong(spreadText) ? ' spread__abs--long' : ''}`}>
          {spreadText}
        </div>
        <div className="spread__pct num">({formatPct(row.spreadPct)})</div>
        <div className={`spread__net num${row.netPct > 0 ? ' spread__net--good' : ''}`}>
          {row.stale
            ? t('screener.stale')
            : t('screener.netShort', { value: formatSignedPct(row.netPct) })}
        </div>
      </div>

      <span className="row-plus">
        <PlusIcon />
      </span>
    </div>
  );
}

/** Строка длиннее этого не помещается в колонку обычным кеглем. */
function isLong(text: string): boolean {
  return text.length > 9;
}

function Venue({
  id,
  price,
  decimals,
  side,
}: {
  id: ExchangeId;
  price: number;
  decimals: number;
  side: 'long' | 'short';
}) {
  const { t } = useTranslation();
  const meta = exchange(id);
  const text = formatPrice(price, decimals);
  return (
    <div className="venue">
      <div className="venue__name" style={{ color: meta.brand }}>
        {meta.name}
        {/* Направление ноги: вверх — где покупаем (дешевле), вниз — где шортим. */}
        <span className={`venue__side venue__side--${side}`} title={side}>
          {side === 'long' ? <ArrowUpIcon /> : <ArrowDownIcon />}
        </span>
      </div>
      <div className={`venue__price num${isLong(text) ? ' venue__price--long' : ''}`}>{text}</div>
      <div className="venue__quote">{t('app.usdt')}</div>
    </div>
  );
}
