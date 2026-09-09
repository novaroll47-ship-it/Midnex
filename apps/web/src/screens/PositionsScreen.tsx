/** Экран «Позиции» — макет docs/mockup-positions.png. */
import {
  EXCHANGES,
  exchange,
  formatDate,
  formatPct,
  formatPrice,
  formatSignedPct,
  formatSignedUsdt,
  formatUsdt,
  priceDecimals,
  type ExchangeId,
  type Position,
} from '@cs/shared';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { CoinIcon } from '../components/CoinIcon';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ExchangeLogo } from '../components/ExchangeLogo';
import { Sheet } from '../components/Sheet';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  DetailsIcon,
  FilterIcon,
  LinkIcon,
  PencilIcon,
  ShieldIcon,
} from '../icons';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';

type PosTab = 'open' | 'closed' | 'history';
type PosSort = 'pnl' | 'time' | 'coin';

interface PosFilters {
  coin: string;
  venue: ExchangeId | null;
  sort: PosSort;
}

const NO_FILTERS: PosFilters = { coin: '', venue: null, sort: 'time' };

export function PositionsScreen({
  onOpenDetails,
  onOpenEdit,
}: {
  onOpenDetails: (id: string) => void;
  onOpenEdit: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PosTab>('open');
  const [closing, setClosing] = useState<Position | null>(null);
  const [filters, setFilters] = useState<PosFilters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetcher = useCallback(() => api.positions(tab), [tab]);
  const { data, refresh } = usePolling(fetcher, 1000);
  const summary = data?.summary;

  const positions = useMemo(() => {
    const all = data?.positions ?? [];
    const query = filters.coin.trim().toLowerCase();

    const filtered = all.filter((p) => {
      if (query && !p.base.toLowerCase().includes(query) && !p.name.toLowerCase().includes(query))
        return false;
      if (filters.venue && p.long.exchange !== filters.venue && p.short.exchange !== filters.venue)
        return false;
      return true;
    });

    return filtered.sort((a, b) => {
      switch (filters.sort) {
        case 'pnl':
          return b.pnlUsdt - a.pnlUsdt;
        case 'coin':
          return a.base.localeCompare(b.base);
        default:
          return b.openedAt - a.openedAt;
      }
    });
  }, [data, filters]);

  const activeFilters =
    (filters.coin ? 1 : 0) + (filters.venue ? 1 : 0) + (filters.sort !== 'time' ? 1 : 0);

  function confirmClose() {
    if (!closing) return;
    setBusy(true);
    api
      .closePosition(closing.id)
      .then(() => {
        setClosing(null);
        setError(null);
        refresh();
      })
      .catch(() => setError(t('positions.closeFailed')))
      .finally(() => setBusy(false));
  }

  return (
    <div className="stack">
      <div className="screen-title">
        <h1>{t('positions.title')}</h1>
        <button
          className={`btn-ghost${activeFilters ? ' btn-ghost--on' : ''}`}
          type="button"
          onClick={() => setFiltersOpen(true)}
        >
          <FilterIcon />
          {t('positions.filters')}
          {activeFilters > 0 && <span className="btn-ghost__badge">{activeFilters}</span>}
        </button>
      </div>

      <div className="segmented">
        <button
          type="button"
          className={`segmented__item${tab === 'open' ? ' segmented__item--active' : ''}`}
          onClick={() => setTab('open')}
        >
          {t('positions.tabOpen', { count: summary?.openCount ?? 0 })}
        </button>
        <button
          type="button"
          className={`segmented__item${tab === 'closed' ? ' segmented__item--active' : ''}`}
          onClick={() => setTab('closed')}
        >
          {t('positions.tabClosed')}
        </button>
        <button
          type="button"
          className={`segmented__item${tab === 'history' ? ' segmented__item--active' : ''}`}
          onClick={() => setTab('history')}
        >
          {t('positions.tabHistory')}
        </button>
      </div>

      {tab === 'open' && summary && (
        <section className="card summary">
          <SummaryCell
            label={t('positions.openCount')}
            value={String(summary.openCount)}
            unit={t('positions.pcs')}
            tone={summary.openCount > 0 ? 'green' : 'plain'}
          />
          <SummaryCell
            label={t('positions.totalPnl')}
            value={formatSignedUsdt(summary.totalPnlUsdt)}
            unit={t('app.usdt')}
            tone={summary.totalPnlUsdt >= 0 ? 'green' : 'red'}
          />
          <SummaryCell
            label={t('positions.unrealizedPnl')}
            value={formatSignedUsdt(summary.unrealizedPnlUsdt)}
            unit={t('app.usdt')}
            tone={summary.unrealizedPnlUsdt >= 0 ? 'green' : 'red'}
          />
          <SummaryCell
            label={t('positions.capitalInUse')}
            value={formatUsdt(summary.capitalInUseUsdt)}
            unit={t('app.usdt')}
            tone="plain"
          />
        </section>
      )}

      {error && (
        <section className="card notice notice--warn">
          <ShieldIcon className="notice__icon" />
          <span>{error}</span>
        </section>
      )}

      {positions.map((p) => (
        <PositionCard
          key={p.id}
          position={p}
          onDetails={() => onOpenDetails(p.id)}
          onEdit={() => onOpenEdit(p.id)}
          onClose={() => setClosing(p)}
        />
      ))}

      {positions.length === 0 && (
        <div className="card empty">
          {tab === 'closed' ? t('positions.emptyClosed') : t('positions.emptyHistory')}
        </div>
      )}

      {tab === 'open' && positions.length > 0 && (
        <section className="card notice">
          <ShieldIcon className="notice__icon" />
          <span>{t('positions.autoNote')}</span>
        </section>
      )}

      {filtersOpen && (
        <PositionFiltersSheet
          value={filters}
          onChange={setFilters}
          onClose={() => setFiltersOpen(false)}
        />
      )}

      {closing && (
        <ConfirmDialog
          title={t('positions.closeConfirmTitle')}
          message={t('positions.closeConfirmText', {
            symbol: `${closing.base}/USDT`,
            pnl: formatSignedUsdt(closing.pnlUsdt),
          })}
          confirmLabel={t('positions.closePosition')}
          danger
          busy={busy}
          onConfirm={confirmClose}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  );
}

function PositionFiltersSheet({
  value,
  onChange,
  onClose,
}: {
  value: PosFilters;
  onChange: (next: PosFilters) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);

  const sorts: { key: PosSort; label: string }[] = [
    { key: 'time', label: t('positions.sortTime') },
    { key: 'pnl', label: t('positions.sortPnl') },
    { key: 'coin', label: t('positions.sortCoin') },
  ];

  return (
    <Sheet
      title={t('positions.filters')}
      onClose={onClose}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              onChange(NO_FILTERS);
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
          <span className="sheet__row-title">{t('positions.filterCoin')}</span>
          <input
            className="sheet__input"
            value={draft.coin}
            placeholder={t('screener.searchCoin')}
            onChange={(e) => setDraft((d) => ({ ...d, coin: e.target.value }))}
          />
        </label>
      </div>

      <div className="section-label section-label--sheet">{t('positions.filterVenue')}</div>
      <div className="venue-grid">
        {EXCHANGES.map((ex) => (
          <button
            key={ex.id}
            type="button"
            className={`venue-tile${draft.venue === ex.id ? ' venue-tile--on' : ''}`}
            onClick={() => setDraft((d) => ({ ...d, venue: d.venue === ex.id ? null : ex.id }))}
          >
            <ExchangeLogo id={ex.id} size={20} />
            <span>{ex.name}</span>
          </button>
        ))}
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

function SummaryCell({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string;
  unit: string;
  tone: 'green' | 'red' | 'plain';
}) {
  const color = tone === 'green' ? 'var(--green)' : tone === 'red' ? 'var(--red)' : 'var(--text)';
  return (
    <div className="summary__cell">
      <div className="summary__label">{label}</div>
      <div className="summary__value num" style={{ color }}>
        {value}
      </div>
      <div className="summary__unit">{unit}</div>
    </div>
  );
}

function PositionCard({
  position: p,
  onDetails,
  onEdit,
  onClose,
}: {
  position: Position;
  onDetails: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const decimals = priceDecimals(p.long.entryPrice);
  const profit = p.pnlUsdt >= 0;
  const longMeta = exchange(p.long.exchange);
  const shortMeta = exchange(p.short.exchange);

  return (
    <article className="card pos">
      <div className="pos__head">
        <div className="pos__legs">
          <div className="pos__leg">
            <div className="pos__leg-top">
              <CoinIcon base={p.base} size={26} />
              <span className="pos__symbol">{p.base}/USDT</span>
            </div>
            <span className="badge badge--long">
              <ArrowUpIcon size={10} />
              LONG
            </span>
            <div className="pos__venue">
              <ExchangeLogo id={p.long.exchange} />
              {longMeta.name}
            </div>
          </div>

          <div className="pos__link">
            <LinkIcon />
          </div>

          <div className="pos__leg">
            <div className="pos__leg-top">
              <span className="pos__symbol">{p.base}/USDT</span>
            </div>
            <span className="badge badge--short">
              <ArrowDownIcon size={10} />
              SHORT
            </span>
            <div className="pos__venue">
              <ExchangeLogo id={p.short.exchange} />
              {shortMeta.name}
            </div>
          </div>
        </div>

        <div className="pos__pnl" style={{ color: profit ? 'var(--green)' : 'var(--red)' }}>
          <div className="pos__pnl-value num">
            {formatSignedUsdt(p.pnlUsdt)}
            <span className="pos__pnl-unit">{t('app.usdt')}</span>
          </div>
          <div className="pos__pnl-pct num">({formatSignedPct(p.pnlPct)})</div>
          <span className="badge badge--soon" style={{ marginTop: 6 }}>
            {t(
              p.executionMode === 'paper'
                ? 'positions.modePaper'
                : p.executionMode === 'testnet'
                  ? 'positions.modeTestnet'
                  : 'positions.modeLive',
            )}
          </span>
        </div>
      </div>

      <div className="pos__grid pos__grid--4">
        <Metric
          label={t('positions.volume')}
          value={`${formatPrice(p.long.amount, 3)} ${p.base}`}
          sub={`≈ ${formatUsdt(p.long.notional)} ${t('app.usdt')}`}
        />
        <Metric label={t('positions.avgSpread')} value={formatPct(p.entrySpreadPct)} />
        <Metric
          label={t('positions.currentSpread')}
          value={formatPct(p.currentSpreadPct)}
          tone={p.currentSpreadPct < p.entrySpreadPct ? 'green' : 'red'}
        />
        <Metric label={t('positions.leverage')} value={`${p.leverage}x`} />
      </div>

      <div className="pos__grid pos__grid--3">
        <Metric
          label={t('positions.openedAt')}
          value={new Date(p.openedAt).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
          sub={formatDate(p.openedAt)}
        />
        <Metric label={t('positions.entryLong')} value={formatPrice(p.long.entryPrice, decimals)} />
        <Metric
          label={t('positions.entryShort')}
          value={formatPrice(p.short.entryPrice, decimals)}
        />
      </div>

      <div className="pos__actions">
        <button className="btn-outline" type="button" onClick={onDetails}>
          <DetailsIcon />
          {t('positions.details')}
        </button>
        <button
          className="btn-outline"
          type="button"
          onClick={onEdit}
          disabled={p.status === 'closed'}
        >
          <PencilIcon />
          {t('positions.edit')}
        </button>
        <button
          className="btn-outline btn-outline--danger"
          type="button"
          onClick={onClose}
          disabled={p.status === 'closed'}
        >
          {t('positions.closePosition')}
        </button>
      </div>
    </article>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'green' | 'red';
}) {
  const color = tone === 'green' ? 'var(--green)' : tone === 'red' ? 'var(--red)' : undefined;
  return (
    <div>
      <div className="pos__metric-label">{label}</div>
      <div className="pos__metric-value num" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="pos__metric-sub num">{sub}</div>}
    </div>
  );
}
