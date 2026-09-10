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

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { CoinIcon } from '../components/CoinIcon';
import { ExchangeLogo } from '../components/ExchangeLogo';
import { Sheet } from '../components/Sheet';
import {
  BoltIcon,
  CheckIcon,
  ChevronRightIcon,
  GearIcon,
  SearchIcon,
  SlidersIcon,
  SwapIcon,
  XIcon,
} from '../icons';
import { ApiError, api } from '../lib/api';
import { haptic } from '../lib/telegram';
import { usePolling } from '../lib/usePolling';

type SortKey = 'spread' | 'net' | 'name' | 'price';

interface ExtraFilters {
  onlyPositiveNet: boolean;
  onlyProfitableFunding: boolean;
  maxSpreadPct: number;
  sort: SortKey;
}

const DEFAULT_EXTRA: ExtraFilters = {
  onlyPositiveNet: false,
  onlyProfitableFunding: false,
  maxSpreadPct: 0,
  sort: 'spread',
};

interface Props {
  onOpenSettings: () => void;
  onOpenCoin: (base: string) => void;
  plan: keyof typeof PLAN_WATCHLIST_LIMIT;
  minSpreadPct?: number;
  refreshMs: number;
}

export function ScreenerScreen({
  onOpenSettings,
  onOpenCoin,
  plan,
  minSpreadPct,
  refreshMs,
}: Props) {
  const { t } = useTranslation();

  const [minSpread, setMinSpread] = useState('0.50');
  const [search, setSearch] = useState('');
  const [venues, setVenues] = useState<ExchangeId[]>([]);
  const [extra, setExtra] = useState<ExtraFilters>(DEFAULT_EXTRA);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<'venues' | 'filters' | null>(null);

  // Порог берём из настроек бота, но как только пользователь потрогал поле
  // на этом экране — фильтр становится его, и настройки его больше не трогают.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current && minSpreadPct !== undefined) setMinSpread(minSpreadPct.toFixed(2));
  }, [minSpreadPct]);

  const minSpreadNum = Number(minSpread.replace(',', '.')) || 0;
  const venueKey = venues.join(',');

  const fetcher = useCallback(
    () => api.screener(minSpreadNum, venueKey || undefined),
    [minSpreadNum, venueKey],
  );
  const { data, error, refresh } = usePolling<ScreenerSnapshot>(fetcher, refreshMs);

  const rows = data?.rows ?? [];

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();

    const filtered = rows.filter((r) => {
      // Поиск идёт по всем монетам подряд, независимо от величины спреда:
      // конкретную монету надо находить и когда спред отрицательный.
      if (query && !r.base.toLowerCase().includes(query) && !r.name.toLowerCase().includes(query))
        return false;
      if (extra.onlyPositiveNet && r.netPct <= 0) return false;
      if (extra.onlyProfitableFunding && r.fundingPct < 0) return false;
      if (extra.maxSpreadPct > 0 && r.spreadPct > extra.maxSpreadPct) return false;
      return true;
    });

    const bySort = (a: SpreadRow, b: SpreadRow) => {
      switch (extra.sort) {
        case 'net':
          return b.netPct - a.netPct;
        case 'name':
          return a.base.localeCompare(b.base);
        case 'price':
          return b.longPrice - a.longPrice;
        default:
          return b.spreadPct - a.spreadPct;
      }
    };

    // Отмеченные монеты бот торгует — они всегда наверху, чтобы не искать их
    // в списке после каждой пересортировки. Подозрительные — всегда внизу:
    // их спред как число смысла не имеет, и любая сортировка по нему
    // вытолкнула бы их на первое место.
    return filtered.sort((a, b) => {
      const pinned = Number(selected.has(b.symbol)) - Number(selected.has(a.symbol));
      if (pinned !== 0) return pinned;
      const suspect = Number(Boolean(a.suspect)) - Number(Boolean(b.suspect));
      if (suspect !== 0) return suspect;
      return bySort(a, b);
    });
  }, [rows, search, extra, selected]);

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
  const errorText = !error
    ? null
    : error instanceof ApiError && error.status === 401
      ? t('app.unauthorized')
      : t('app.loadError');

  const extraCount =
    (extra.onlyPositiveNet ? 1 : 0) +
    (extra.onlyProfitableFunding ? 1 : 0) +
    (extra.maxSpreadPct > 0 ? 1 : 0) +
    (extra.sort !== 'spread' ? 1 : 0);

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

        {/* Две сводные цифры. Частота обновления убрана — она и так написана
            в подвале, а спарклайн ничего не добавлял к самому числу. */}
        <section className="stats stats--two">
          <div className="card stat">
            <div className="stat__label">{t('screener.found')}</div>
            <div className="stat__value num">{data?.opportunities ?? '—'}</div>
          </div>
          <div className="card stat">
            <div className="stat__label">{t('screener.avgSpread')}</div>
            <div className="stat__value num">{data ? formatPct(data.avgSpreadPct) : '—'}</div>
          </div>
        </section>

        {/* Фильтры */}
        <section className="filters">
          <div className="search">
            <SearchIcon className="search__icon" />
            <input
              className="search__input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('screener.searchCoin')}
              aria-label={t('screener.searchCoin')}
            />
            {search && (
              <button
                className="search__clear"
                type="button"
                onClick={() => setSearch('')}
                aria-label={t('app.cancel')}
              >
                <XIcon size={13} />
              </button>
            )}
          </div>

          <button
            className={`chip${venues.length ? ' chip--active' : ''}`}
            type="button"
            onClick={() => setSheet('venues')}
          >
            {venues.length === 2 ? (
              <>
                <ExchangeLogo id={venues[0]!} size={13} />
                <SwapIcon size={11} />
                <ExchangeLogo id={venues[1]!} size={13} />
              </>
            ) : (
              t('screener.allExchanges')
            )}
          </button>

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

          <button
            className={`icon-btn-square${extraCount ? ' icon-btn-square--active' : ''}`}
            type="button"
            aria-label={t('screener.moreFilters')}
            onClick={() => setSheet('filters')}
          >
            <SlidersIcon size={17} />
            {extraCount > 0 && <span className="icon-btn-square__badge">{extraCount}</span>}
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
            onOpen={() => onOpenCoin(row.base)}
          />
        ))}
        {visible.length === 0 && (
          <div className="card empty">
            {errorText ??
              (search ? t('screener.nothingFound', { query: search }) : t('screener.empty'))}
          </div>
        )}
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
            {errorText ??
              t('screener.lastUpdate', { time: formatClock(data?.updatedAt ?? Date.now()) })}
          </div>
        </div>
        <button className="btn-ghost btn-ghost--green" type="button" onClick={refresh}>
          {t('screener.refreshNow')}
        </button>
      </section>

      {sheet === 'venues' && (
        <VenuePairSheet value={venues} onChange={setVenues} onClose={() => setSheet(null)} />
      )}
      {sheet === 'filters' && (
        <FiltersSheet value={extra} onChange={setExtra} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

/**
 * Выбор конкретной пары бирж.
 *
 * Пока выбрана пара, спред считается именно между этими двумя биржами, а не
 * между лучшими из восьми — иначе выбор ничего не значил бы.
 */
function VenuePairSheet({
  value,
  onChange,
  onClose,
}: {
  value: ExchangeId[];
  onChange: (next: ExchangeId[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [pair, setPair] = useState<ExchangeId[]>(value);

  function pick(id: ExchangeId) {
    haptic('tap');
    setPair((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // Третий выбор вытесняет самый ранний — пара всегда из двух бирж.
      return prev.length < 2 ? [...prev, id] : [prev[1]!, id];
    });
  }

  return (
    <Sheet
      title={t('screener.venuePairTitle')}
      description={t('screener.venuePairHint')}
      onClose={onClose}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              onChange([]);
              onClose();
            }}
          >
            {t('screener.allExchanges')}
          </Button>
          <Button
            disabled={pair.length !== 2}
            onClick={() => {
              onChange(pair);
              onClose();
            }}
          >
            {t('app.apply')}
          </Button>
        </div>
      }
    >
      <div className="venue-grid">
        {EXCHANGES.map((ex) => {
          const index = pair.indexOf(ex.id);
          return (
            <button
              key={ex.id}
              type="button"
              className={`venue-tile${index >= 0 ? ' venue-tile--on' : ''}`}
              onClick={() => pick(ex.id)}
            >
              <ExchangeLogo id={ex.id} size={20} />
              <span>{ex.name}</span>
              {index >= 0 && <span className="venue-tile__order">{index + 1}</span>}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

function FiltersSheet({
  value,
  onChange,
  onClose,
}: {
  value: ExtraFilters;
  onChange: (next: ExtraFilters) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);

  const sorts: { key: SortKey; label: string }[] = [
    { key: 'spread', label: t('screener.sortSpread') },
    { key: 'net', label: t('screener.sortNet') },
    { key: 'name', label: t('screener.sortName') },
    { key: 'price', label: t('screener.sortPrice') },
  ];

  return (
    <Sheet
      title={t('screener.moreFilters')}
      onClose={onClose}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              onChange(DEFAULT_EXTRA);
              onClose();
            }}
          >
            {t('screener.resetFilters')}
          </Button>
          <Button
            onClick={() => {
              onChange(draft);
              onClose();
            }}
          >
            {t('app.apply')}
          </Button>
        </div>
      }
    >
      <div className="sheet__group">
        <label className="sheet__row">
          <span>
            <span className="sheet__row-title">{t('screener.onlyPositiveNet')}</span>
            <span className="sheet__row-sub">{t('screener.onlyPositiveNetSub')}</span>
          </span>
          <Switch
            checked={draft.onlyPositiveNet}
            aria-label={t('screener.onlyPositiveNet')}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, onlyPositiveNet: v }))}
          />
        </label>

        <label className="sheet__row">
          <span>
            <span className="sheet__row-title">{t('sd.onlyProfitableFunding')}</span>
            <span className="sheet__row-sub">{t('screener.onlyProfitableFundingSub')}</span>
          </span>
          <Switch
            checked={draft.onlyProfitableFunding}
            aria-label={t('sd.onlyProfitableFunding')}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, onlyProfitableFunding: v }))}
          />
        </label>

        <label className="sheet__row">
          <span>
            <span className="sheet__row-title">{t('screener.maxSpread')}</span>
            <span className="sheet__row-sub">{t('screener.maxSpreadSub')}</span>
          </span>
          <span className="num-field">
            <input
              className="num-field__input num"
              inputMode="decimal"
              value={draft.maxSpreadPct || ''}
              placeholder="—"
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  maxSpreadPct: Number(e.target.value.replace(',', '.')) || 0,
                }))
              }
            />
            <span className="num-field__unit">%</span>
          </span>
        </label>
      </div>

      <div className="section-label section-label--sheet">{t('screener.sortBy')}</div>
      <div className="sheet__group">
        {sorts.map((s) => (
          <button
            key={s.key}
            type="button"
            className="sheet__row sheet__row--tap"
            onClick={() => setDraft((d) => ({ ...d, sort: s.key }))}
          >
            <span className="sheet__row-title">{s.label}</span>
            <span style={{ color: draft.sort === s.key ? 'var(--green)' : 'transparent' }}>
              <CheckIcon size={14} />
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function CoinRow({
  row,
  checked,
  disabled,
  onToggle,
  onOpen,
}: {
  row: SpreadRow;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const decimals = priceDecimals(row.longPrice);
  const direction = row.spreadPct > 0.0001 ? 'up' : row.spreadPct < -0.0001 ? 'down' : 'flat';
  const spreadText = formatDelta(row.spreadAbs, decimals);

  return (
    <div
      className={`coin-row${row.stale ? ' coin-row--stale' : ''}${checked ? ' coin-row--pinned' : ''}`}
    >
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
        <CoinIcon base={row.base} size={20} />
        <div className="coin-id__text">
          <div className={`coin-id__ticker${tickerSizeClass(row.base)}`}>{row.base}</div>
          {row.name !== row.base && <div className="coin-id__name">{row.name}</div>}
        </div>
      </div>

      <Venue id={row.longExchange} price={row.longPrice} decimals={decimals} side="long" />
      <Venue id={row.shortExchange} price={row.shortPrice} decimals={decimals} side="short" />

      <div className={`spread spread--${row.suspect ? 'flat' : direction}`}>
        <div className={`spread__abs num${isLong(spreadText) ? ' spread__abs--long' : ''}`}>
          {row.suspect ? '—' : spreadText}
        </div>
        <div className="spread__pct num">{row.suspect ? '' : `(${formatPct(row.spreadPct)})`}</div>
        <div
          className={`spread__net num${row.netPct > 0 && !row.suspect ? ' spread__net--good' : ''}`}
        >
          {row.suspect
            ? t('md.suspect')
            : row.stale
              ? t('screener.stale')
              : t(row.fundingKnown === false ? 'screener.fundingUnknown' : 'screener.netShort', {
                  value: formatSignedPct(row.netPct),
                })}
        </div>
      </div>

      <button
        className="row-open"
        type="button"
        onClick={onOpen}
        aria-label={t('coin.openTitle', { base: row.base })}
      >
        <ChevronRightIcon size={15} />
      </button>
    </div>
  );
}

/**
 * В макете тикеры были по три-четыре буквы, у реальных бирж — до девяти
 * (PENGSTOCK, APPSTOCK). Кегль подстраивается под длину, чтобы тикер
 * помещался целиком; высота строки от этого не меняется.
 */
function tickerSizeClass(base: string): string {
  if (base.length >= 8) return ' coin-id__ticker--xs';
  if (base.length >= 6) return ' coin-id__ticker--sm';
  if (base.length >= 5) return ' coin-id__ticker--md';
  return '';
}

/** Строка длиннее этого не помещается в колонку обычным кеглем. */
function isLong(text: string): boolean {
  return text.length > 7;
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
      <div className="venue__name" title={side}>
        <ExchangeLogo id={id} size={11} />
        <span className="venue__label">{meta.name}</span>
      </div>
      <div className={`venue__price num${isLong(text) ? ' venue__price--long' : ''}`}>{text}</div>
      <div className="venue__quote">{t('app.usdt')}</div>
    </div>
  );
}
