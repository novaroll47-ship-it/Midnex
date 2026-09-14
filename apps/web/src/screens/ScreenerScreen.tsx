/** Экран «Скринер» — макет docs/mockup-screener.png. */
import {
  DEFAULT_BOT,
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
import { BoltIcon, CheckIcon, ChevronRightIcon, SearchIcon, SlidersIcon, XIcon } from '../icons';
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

/** Порядок переключения сортировок по нажатию на ссылку над таблицей. */
const SORT_ORDER: SortKey[] = ['spread', 'name', 'price'];

/** Подписи сортировок для ссылки над таблицей. */
const SORT_LABEL: Record<SortKey, string> = {
  spread: 'screener.sortBySpread',
  net: 'screener.sortNet',
  name: 'screener.sortAlpha',
  price: 'screener.sortPrice',
};

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
  const [sheet, setSheet] = useState<'filters' | null>(null);

  // Вотчлист хранится на сервере: закреплённые монеты переживают перезапуск
  // приложения и одинаковы на телефоне и на компьютере.
  useEffect(() => {
    let alive = true;
    api
      .watchlist()
      .then((r) => alive && setSelected(new Set(r.bases)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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
  const { data, error, refresh } = usePolling<ScreenerSnapshot>(
    fetcher,
    refreshMs,
    true,
    'screener',
  );

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
      const pinned = Number(selected.has(b.base)) - Number(selected.has(a.base));
      if (pinned !== 0) return pinned;
      // Свежие выше устаревших, подозрительные в конце — как и на сервере;
      // иначе любая сортировка по спреду поднимала бы фантомы наверх.
      const rank = (r: SpreadRow) => (r.suspect ? 2 : r.stale ? 1 : 0);
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return bySort(a, b);
    });
  }, [rows, search, extra, selected]);

  const watchlistLimit = PLAN_WATCHLIST_LIMIT[plan] ?? null;
  const limitReached = watchlistLimit !== null && selected.size >= watchlistLimit;

  function toggle(base: string) {
    const next = new Set(selected);
    if (next.has(base)) next.delete(base);
    else if (!limitReached) next.add(base);
    else return;
    haptic('tap');
    // Сначала показываем, потом сохраняем; если сервер отказал (лимит тарифа
    // или сеть) — возвращаем как было, чтобы экран не расходился с базой.
    setSelected(next);
    api.setWatchlist([...next]).catch(() => setSelected(selected));
  }

  const refreshSeconds = Math.max(1, Math.round(refreshMs / 1000));
  const errorText = !error
    ? null
    : error instanceof ApiError && error.status === 401
      ? t('app.unauthorized')
      : t('app.loadError');

  const extraCount =
    (venues.length === 2 ? 1 : 0) +
    (extra.onlyPositiveNet ? 1 : 0) +
    (extra.onlyProfitableFunding ? 1 : 0) +
    (extra.maxSpreadPct > 0 ? 1 : 0);

  return (
    <div className="screener">
      <div className="screener__top">
        {/* Одна панель: состояние бота и две сводные цифры. */}
        <section className="card panel">
          <div className="panel__head">
            <div>
              <div className="panel__status">
                <i
                  className={`panel__dot${data?.botRunning === false ? ' panel__dot--off' : ''}`}
                />
                {data?.botRunning === false ? t('screener.botStopped') : t('screener.botActive')}
              </div>
              <div className="panel__sub">
                {data?.botRunning === false ? t('screener.idle') : t('screener.scanningShort')} ·{' '}
                <span className="num">{formatClock(data?.updatedAt ?? Date.now())}</span>
              </div>
            </div>
            <button className="panel__btn" type="button" onClick={onOpenSettings}>
              {t('screener.configure')}
            </button>
          </div>
          <div className="panel__stats">
            <div className="panel__stat">
              <div className="panel__value num">{data?.opportunities ?? '—'}</div>
              <div className="panel__label">{t('screener.opportunities')}</div>
            </div>
            <div className="panel__stat">
              <div className="panel__value panel__value--green num">
                {data ? formatPct(data.avgSpreadPct) : '—'}
              </div>
              <div className="panel__label">{t('screener.avgSpreadLower')}</div>
            </div>
          </div>
        </section>

        {/* Поиск и фильтры */}
        <section className="filters filters--pill">
          <div className="search search--pill">
            <SearchIcon className="search__icon" size={16} />
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
            className={`icon-btn-round${extraCount ? ' icon-btn-round--active' : ''}`}
            type="button"
            aria-label={t('screener.moreFilters')}
            onClick={() => setSheet('filters')}
          >
            <SlidersIcon size={18} />
            {extraCount > 0 && <span className="icon-btn-square__badge">{extraCount}</span>}
          </button>
        </section>

        <div className="list-head">
          <span className="list-head__title">{t('screener.spreadsNow')}</span>
          <button
            type="button"
            className="list-head__sort"
            onClick={() => {
              haptic('tap');
              // Каждое нажатие — следующая сортировка по кругу, без меню.
              setExtra((e) => ({
                ...e,
                sort: SORT_ORDER[(SORT_ORDER.indexOf(e.sort) + 1) % SORT_ORDER.length]!,
              }));
            }}
          >
            {t(SORT_LABEL[extra.sort])}
          </button>
        </div>
      </div>

      {/* Скроллится только список монет — шапка и подвал стоят на месте. */}
      <div className="screener__list">
        {visible.map((row) => (
          <CoinRow
            key={row.symbol}
            row={row}
            checked={selected.has(row.base)}
            disabled={!selected.has(row.base) && limitReached}
            onToggle={() => toggle(row.base)}
            onOpen={() => onOpenCoin(row.base)}
          />
        ))}
        {visible.length === 0 && (
          <div className="card empty">
            {errorText ??
              (!data
                ? t('app.loading')
                : search
                  ? t('screener.nothingFound', { query: search })
                  : t('screener.empty'))}
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

      {sheet === 'filters' && (
        <FiltersSheet
          value={extra}
          onChange={setExtra}
          minSpread={minSpread}
          onMinSpread={(v) => {
            touched.current = true;
            setMinSpread(v);
          }}
          venues={venues}
          onVenues={setVenues}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

function FiltersSheet({
  value,
  onChange,
  minSpread,
  onMinSpread,
  venues,
  onVenues,
  onClose,
}: {
  value: ExtraFilters;
  onChange: (next: ExtraFilters) => void;
  minSpread: string;
  onMinSpread: (next: string) => void;
  venues: ExchangeId[];
  onVenues: (next: ExchangeId[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [minDraft, setMinDraft] = useState(minSpread);
  const [pair, setPair] = useState<ExchangeId[]>(venues);

  // Пара бирж: третий выбор вытесняет самый ранний, пара всегда из двух.
  // Пока выбрана пара, спред считается именно между ними, а не между
  // лучшими из восьми — иначе выбор ничего не значил бы.
  function pick(id: ExchangeId) {
    haptic('tap');
    setPair((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return prev.length < 2 ? [...prev, id] : [prev[1]!, id];
    });
  }

  function apply() {
    const n = Number(minDraft.replace(',', '.'));
    onMinSpread(Number.isFinite(n) && n >= 0 ? n.toFixed(2) : minSpread);
    onVenues(pair.length === 2 ? pair : []);
    onChange(draft);
    onClose();
  }

  return (
    <Sheet
      title={t('screener.moreFilters')}
      onClose={onClose}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              onChange({ ...DEFAULT_EXTRA, sort: value.sort });
              onMinSpread(DEFAULT_BOT.minSpreadPct.toFixed(2));
              onVenues([]);
              onClose();
            }}
          >
            {t('screener.resetFilters')}
          </Button>
          <Button onClick={apply}>{t('app.apply')}</Button>
        </div>
      }
    >
      <div className="sheet__group">
        <label className="sheet__row">
          <span>
            <span className="sheet__row-title">{t('screener.minSpread')}</span>
            <span className="sheet__row-sub">{t('screener.thresholdHint')}</span>
          </span>
          <span className="num-field">
            <input
              className="num-field__input num"
              inputMode="decimal"
              value={minDraft}
              onChange={(e) => setMinDraft(e.target.value)}
            />
            <span className="num-field__unit">%</span>
          </span>
        </label>
      </div>

      <div className="section-label section-label--sheet">{t('screener.venuePairTitle')}</div>
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
      <p className="hint hint--sheet">{t('screener.venuePairHint')}</p>

      <div className="section-label section-label--sheet">{t('screener.moreFilters')}</div>
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
