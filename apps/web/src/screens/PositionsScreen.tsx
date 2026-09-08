/** Экран «Позиции» — макет docs/mockup-positions.png. */
import {
  exchange,
  formatDate,
  formatPct,
  formatPrice,
  formatSignedPct,
  formatSignedUsdt,
  formatUsdt,
  priceDecimals,
  type Position,
} from '@cs/shared';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CoinIcon } from '../components/CoinIcon';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ExchangeMark } from '../components/ExchangeMark';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DetailsIcon,
  FilterIcon,
  LinkIcon,
  PencilIcon,
  ShieldIcon,
} from '../icons';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';

type PosTab = 'open' | 'closed' | 'history';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetcher = useCallback(() => api.positions(tab), [tab]);
  const { data, refresh } = usePolling(fetcher, 1000);
  const positions = data?.positions ?? [];
  const summary = data?.summary;

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
        <button className="btn-ghost" type="button">
          <FilterIcon />
          {t('positions.filters')}
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
              <ExchangeMark id={p.long.exchange} />
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
              <ExchangeMark id={p.short.exchange} />
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
