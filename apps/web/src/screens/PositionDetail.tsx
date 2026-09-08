/**
 * Подэкраны карточки позиции: «Детали» и «Изменить».
 *
 * «Детали» показывают всё, что скрыто в компактной карточке, — включая
 * комиссии round-trip и то, сколько от валового результата останется после
 * закрытия. «Изменить» правит только то, что вообще можно менять у уже
 * открытой позиции: целевой спред и ручной стоп (ТЗ §4.3).
 */
import {
  exchange,
  formatDate,
  formatPct,
  formatPrice,
  formatSignedPct,
  formatSignedUsdt,
  formatUsdt,
  priceDecimals,
} from '@cs/shared';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { InfoRow, NumberRow, Section } from '../components/Form';
import { ExchangeMark } from '../components/ExchangeMark';
import { ClockIcon, ShieldIcon } from '../icons';
import { api, type PositionDetail as Detail } from '../lib/api';
import { usePolling } from '../lib/usePolling';

export type PositionView = 'details' | 'edit';

export function PositionDetailScreen({ id, view }: { id: string; view: PositionView }) {
  const { t } = useTranslation();
  const fetcher = useCallback(() => api.position(id), [id]);
  // Детали обновляются раз в секунду, форма правки — реже: незачем
  // перетирать поле, пока пользователь в нём печатает.
  const { data, refresh } = usePolling<Detail>(fetcher, view === 'details' ? 1000 : 15_000);

  if (!data) return <div className="empty">{t('app.loading')}</div>;

  return view === 'details' ? (
    <DetailsView detail={data} />
  ) : (
    <EditView detail={data} onSaved={refresh} />
  );
}

function DetailsView({ detail }: { detail: Detail }) {
  const { t } = useTranslation();
  const p = detail.position;
  const decimals = priceDecimals(p.long.entryPrice);
  const closed = p.status === 'closed';

  const grossUsdt = p.pnlUsdt;
  const netUsdt = grossUsdt - detail.feesUsdt;

  return (
    <div className="stack">
      <Section title={t('pd.instrument')}>
        <InfoRow label={t('pd.symbol')} value={`${p.base}/USDT`} />
        <InfoRow
          label={t('pd.status')}
          value={t(closed ? 'pd.statusClosed' : 'pd.statusOpen')}
          tone={closed ? 'dim' : 'green'}
        />
        <InfoRow label={t('pd.mode')} value={t(`positions.mode${cap(p.executionMode)}`)} />
        <InfoRow label={t('positions.leverage')} value={`${p.leverage}x`} />
      </Section>

      <Section title={t('pd.legs')}>
        <LegRow
          label="LONG"
          exchangeId={p.long.exchange}
          price={formatPrice(p.long.entryPrice, decimals)}
          amount={`${formatPrice(p.long.amount, 4)} ${p.base}`}
          notional={`${formatUsdt(p.long.notional)} USDT`}
          tone="green"
        />
        <LegRow
          label="SHORT"
          exchangeId={p.short.exchange}
          price={formatPrice(p.short.entryPrice, decimals)}
          amount={`${formatPrice(p.short.amount, 4)} ${p.base}`}
          notional={`${formatUsdt(p.short.notional)} USDT`}
          tone="red"
        />
      </Section>

      <Section title={t('pd.spread')} hint={t('pd.spreadHint')}>
        <InfoRow label={t('positions.avgSpread')} value={formatPct(p.entrySpreadPct)} />
        <InfoRow
          label={t(closed ? 'pd.exitSpread' : 'positions.currentSpread')}
          value={formatPct(p.currentSpreadPct)}
          tone={p.currentSpreadPct < p.entrySpreadPct ? 'green' : 'red'}
        />
        <InfoRow
          label={t('pd.targetSpread')}
          value={detail.targetSpreadPct === null ? '—' : formatPct(detail.targetSpreadPct)}
        />
        <InfoRow
          label={t('pd.stopSpread')}
          value={detail.stopSpreadPct === null ? '—' : formatPct(detail.stopSpreadPct)}
        />
      </Section>

      <Section title={t('pd.result')} hint={t('pd.resultHint')}>
        <InfoRow
          label={t('pd.gross')}
          value={`${formatSignedUsdt(grossUsdt)} USDT`}
          tone={grossUsdt >= 0 ? 'green' : 'red'}
        />
        <InfoRow label={t('pd.fees')} value={`−${formatUsdt(detail.feesUsdt)} USDT`} tone="dim" />
        <InfoRow
          label={t('pd.net')}
          value={`${formatSignedUsdt(netUsdt)} USDT`}
          tone={netUsdt >= 0 ? 'green' : 'red'}
        />
        <InfoRow label={t('pd.pnlPct')} value={formatSignedPct(p.pnlPct)} />
      </Section>

      <Section title={t('pd.timing')}>
        <InfoRow
          label={t('positions.openedAt')}
          value={`${clock(p.openedAt)} · ${formatDate(p.openedAt)}`}
        />
        {p.closedAt && (
          <InfoRow
            label={t('pd.closedAt')}
            value={`${clock(p.closedAt)} · ${formatDate(p.closedAt)}`}
          />
        )}
        <InfoRow label={t('pd.held')} value={heldFor(p.openedAt, p.closedAt, t)} />
        {!closed && (
          <InfoRow
            label={t('pd.holdTimeout')}
            value={`${detail.holdTimeoutMinutes} ${t('sd.unitMin')}`}
          />
        )}
        {detail.closeReason && (
          <InfoRow label={t('pd.closeReason')} value={t(`pd.reason_${detail.closeReason}`)} />
        )}
      </Section>

      {!closed && (
        <section className="card notice">
          <ClockIcon className="notice__icon" />
          <span>{t('pd.autoCloseNote')}</span>
        </section>
      )}
    </div>
  );
}

function EditView({ detail, onSaved }: { detail: Detail; onSaved: () => void }) {
  const { t } = useTranslation();
  const p = detail.position;
  const [error, setError] = useState<string | null>(null);

  if (p.status === 'closed') {
    return (
      <div className="stack">
        <section className="card notice notice--warn">
          <ShieldIcon className="notice__icon" />
          <span>{t('pd.cannotEditClosed')}</span>
        </section>
      </div>
    );
  }

  function save(body: { targetSpreadPct?: number | null; stopSpreadPct?: number | null }) {
    api
      .adjustPosition(p.id, body)
      .then(() => {
        setError(null);
        onSaved();
      })
      .catch(() => setError(t('pd.saveFailed')));
  }

  return (
    <div className="stack">
      <Section title={t('pd.exitConditions')} hint={t('pd.exitConditionsHint')}>
        <NumberRow
          title={t('pd.targetSpread')}
          sub={t('pd.targetSpreadSub')}
          value={detail.targetSpreadPct ?? 0}
          unit="%"
          min={0}
          max={50}
          step={0.05}
          onCommit={(targetSpreadPct) => save({ targetSpreadPct })}
        />
        <NumberRow
          title={t('pd.stopSpread')}
          sub={t('pd.stopSpreadSub')}
          value={detail.stopSpreadPct ?? 0}
          unit="%"
          min={0}
          max={50}
          step={0.05}
          onCommit={(stopSpreadPct) => save({ stopSpreadPct })}
        />
      </Section>

      <Section title={t('pd.current')}>
        <InfoRow label={t('positions.avgSpread')} value={formatPct(p.entrySpreadPct)} />
        <InfoRow label={t('positions.currentSpread')} value={formatPct(p.currentSpreadPct)} />
        <InfoRow
          label={t('pd.unrealized')}
          value={`${formatSignedUsdt(p.pnlUsdt)} USDT`}
          tone={p.pnlUsdt >= 0 ? 'green' : 'red'}
        />
      </Section>

      {error && (
        <section className="card notice notice--warn">
          <ShieldIcon className="notice__icon" />
          <span>{error}</span>
        </section>
      )}

      <p className="hint">{t('pd.editNotAvailable')}</p>
    </div>
  );
}

function LegRow({
  label,
  exchangeId,
  price,
  amount,
  notional,
  tone,
}: {
  label: string;
  exchangeId: Parameters<typeof exchange>[0];
  price: string;
  amount: string;
  notional: string;
  tone: 'green' | 'red';
}) {
  const meta = exchange(exchangeId);
  return (
    <div className="list__item">
      <span>
        <span className="list__title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <ExchangeMark id={exchangeId} />
          {meta.name}
          <span
            className={`badge badge--${tone === 'green' ? 'long' : 'short'}`}
            style={{ marginTop: 0 }}
          >
            {label}
          </span>
        </span>
        <span className="list__sub">
          {amount} · {notional}
        </span>
      </span>
      <span />
      <span className="list__meta num">{price}</span>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function heldFor(from: number, to: number | undefined, t: (k: string) => string): string {
  const minutes = Math.max(0, Math.round(((to ?? Date.now()) - from) / 60_000));
  if (minutes < 60) return `${minutes} ${t('sd.unitMin')}`;
  return `${Math.floor(minutes / 60)} ${t('pd.unitHour')} ${minutes % 60} ${t('sd.unitMin')}`;
}
