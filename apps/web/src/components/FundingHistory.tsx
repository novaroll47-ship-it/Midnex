/**
 * Накопленный фандинг по монете за период — отдельно для лонга и шорта на
 * каждой бирже. Сумма ставок за период: лонг её платит, шорт получает.
 *
 * Строка биржи раскрывается в разбивку по времени: сутки — по выплатам,
 * неделя и месяц — по дням, полгода — по неделям. Столбики показывают знак и
 * величину ставки, таблица под ними — точные значения.
 */
import { EXCHANGES, formatSignedPct, type ExchangeId } from '@cs/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChevronDownIcon } from '../icons';
import { api, type FundingBucket, type FundingPeriod, type FundingResponse } from '../lib/api';
import { haptic } from '../lib/telegram';
import { ExchangeLogo } from './ExchangeLogo';

const PERIODS: FundingPeriod[] = ['1d', '7d', '30d', '180d'];

export function FundingHistory({ base }: { base: string }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<FundingPeriod>('7d');
  const [data, setData] = useState<FundingResponse | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<ExchangeId | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    api
      .coinFunding(base, period)
      .then((r) => {
        if (!alive) return;
        setData(r);
        // Первой раскрываем биржу, где шорт получает больше всего.
        const top = [...r.venues].sort((a, b) => b.shortPct - a.shortPct)[0];
        setOpen((cur) =>
          cur && r.venues.some((v) => v.exchange === cur) ? cur : (top?.exchange ?? null),
        );
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [base, period]);

  const name = (id: string) => EXCHANGES.find((e) => e.id === id)?.name ?? id;
  const venues = data ? [...data.venues].sort((a, b) => b.shortPct - a.shortPct) : [];

  return (
    <>
      <div className="chart__head" style={{ padding: '4px 2px 0' }}>
        <span className="section-label" style={{ margin: 0 }}>
          {t('funding.title')}
        </span>
        <div className="segmented segmented--mini">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              className={`segmented__item${period === p ? ' segmented__item--active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {t(`funding.period_${p}`)}
            </button>
          ))}
        </div>
      </div>
      <section className="card list">
        {error && <div className="empty">{t('chart.unavailable')}</div>}
        {!error && !data && <div className="empty">{t('app.loading')}</div>}
        {data && data.venues.length === 0 && <div className="empty">{t('funding.noData')}</div>}
        {venues.map((v) => {
          const expanded = open === v.exchange;
          return (
            <div
              key={v.exchange}
              className={`funding-venue${expanded ? ' funding-venue--open' : ''}`}
            >
              <button
                type="button"
                className="list__item"
                aria-expanded={expanded}
                onClick={() => {
                  haptic('tap');
                  setOpen(expanded ? null : v.exchange);
                }}
              >
                <span>
                  <span className="list__title venue-row__name">
                    <ExchangeLogo id={v.exchange} size={14} /> {name(v.exchange)}
                  </span>
                  <span className="list__sub">
                    {t('funding.payouts', { count: v.payouts })} · {t('funding.avg')}{' '}
                    {formatSignedPct(v.avgRatePct, 4)}
                  </span>
                </span>
                <span className="funding-cell num">
                  <span style={{ color: v.longPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {t('funding.long')} {formatSignedPct(v.longPct, 2)}
                  </span>
                  <span style={{ color: v.shortPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {t('funding.short')} {formatSignedPct(v.shortPct, 2)}
                  </span>
                </span>
                <ChevronDownIcon
                  size={14}
                  className={`funding-venue__chevron${expanded ? ' funding-venue__chevron--open' : ''}`}
                />
              </button>
              {expanded && data && (
                <Breakdown
                  exchange={v.exchange}
                  bucket={data.breakdown.bucket}
                  rows={data.breakdown.rows}
                />
              )}
            </div>
          );
        })}
      </section>
      {data?.best && (
        <p className="hint">
          {t('funding.bestHint', {
            long: name(data.best.longExchange),
            short: name(data.best.shortExchange),
            net: formatSignedPct(data.best.netPct, 2),
          })}
        </p>
      )}
    </>
  );
}

/** Столбики и таблица ставок одной биржи по корзинам времени. */
function Breakdown({
  exchange,
  bucket,
  rows,
}: {
  exchange: ExchangeId;
  bucket: FundingBucket;
  rows: FundingResponse['breakdown']['rows'];
}) {
  const { t } = useTranslation();
  const points = rows
    .filter((r) => r.rates[exchange] !== undefined)
    .map((r) => ({ ts: r.ts, rate: r.rates[exchange]! }));
  if (points.length === 0) return <div className="funding-break__empty">{t('funding.noData')}</div>;

  const max = Math.max(...points.map((p) => Math.abs(p.rate)), 1e-6);
  const W = 340;
  const H = 56;
  const mid = H / 2;
  const slot = W / points.length;
  const barW = Math.max(1.5, Math.min(10, slot * 0.7));
  // Таблица — свежие сверху; столбики — слева направо по времени.
  const table = [...points].reverse();

  return (
    <div className="funding-break">
      <svg viewBox={`0 0 ${W} ${H}`} className="funding-break__svg" aria-hidden="true">
        <line x1={0} x2={W} y1={mid} y2={mid} stroke="var(--border)" strokeWidth={1} />
        {points.map((p, i) => {
          const h = Math.max(1, (Math.abs(p.rate) / max) * (mid - 3));
          const x = slot * i + (slot - barW) / 2;
          return (
            <rect
              key={p.ts}
              x={x}
              y={p.rate >= 0 ? mid - h : mid}
              width={barW}
              height={h}
              rx={1}
              fill={p.rate >= 0 ? 'var(--green)' : 'var(--red)'}
              opacity={0.85}
            />
          );
        })}
      </svg>
      <div className="funding-break__caption">{t(`funding.bucket_${bucket}`)}</div>
      <div className="funding-break__table num">
        {table.map((p) => (
          <div className="funding-break__row" key={p.ts}>
            <span>{fmtBucket(p.ts, bucket)}</span>
            <span style={{ color: p.rate >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {formatSignedPct(p.rate, 4)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtBucket(ts: number, bucket: FundingBucket): string {
  const d = new Date(ts);
  const day = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  if (bucket === 'payout') {
    return `${day} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (bucket === 'week') {
    const end = new Date(ts + 6 * 86_400_000).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
    });
    return `${day} – ${end}`;
  }
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', weekday: 'short' });
}
