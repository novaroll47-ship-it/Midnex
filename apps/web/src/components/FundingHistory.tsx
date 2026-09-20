/**
 * Фандинг по монете за период.
 *
 * Два блока. «Лучшая связка» — сколько заработала бы пара лонг/шорт за
 * период на одном фандинге: столбики по дням (или выплатам / неделям) и
 * итог. «По биржам» — накопленная ставка на каждой бирже одной полосой:
 * вправо (зелёным) — шорт получает, влево (красным) — шорт платит; так
 * сразу видно, где стоит держать шорт, а где лонг.
 */
import { EXCHANGES, formatSignedPct, type ExchangeId } from '@cs/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, type FundingBucket, type FundingPeriod, type FundingResponse } from '../lib/api';
import { ExchangeLogo } from './ExchangeLogo';

const PERIODS: FundingPeriod[] = ['1d', '7d', '30d', '180d'];

export function FundingHistory({ base }: { base: string }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<FundingPeriod>('7d');
  const [data, setData] = useState<FundingResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    api
      .coinFunding(base, period)
      .then((r) => alive && setData(r))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [base, period]);

  const name = (id: string) => EXCHANGES.find((e) => e.id === id)?.name ?? id;
  const venues = data ? [...data.venues].sort((a, b) => b.shortPct - a.shortPct) : [];
  const maxAbs = Math.max(0.0001, ...venues.map((v) => Math.abs(v.shortPct)));

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

      {error && (
        <section className="card">
          <div className="empty">{t('chart.unavailable')}</div>
        </section>
      )}
      {!error && !data && (
        <section className="card">
          <div className="empty">{t('app.loading')}</div>
        </section>
      )}
      {data && data.venues.length === 0 && (
        <section className="card">
          <div className="empty">{t('funding.noData')}</div>
        </section>
      )}

      {data?.best && (
        <PairCard
          longEx={data.best.longExchange}
          shortEx={data.best.shortExchange}
          netPct={data.best.netPct}
          bucket={data.breakdown.bucket}
          rows={data.breakdown.rows}
        />
      )}

      {venues.length > 0 && (
        <section className="card funding-cmp">
          <div className="funding-cmp__title">{t('funding.byVenue')}</div>
          <div className="funding-cmp__hint">{t('funding.byVenueHint')}</div>
          {venues.map((v) => {
            const pct = (Math.abs(v.shortPct) / maxAbs) * 50;
            const pos = v.shortPct >= 0;
            return (
              <div className="funding-cmp__row" key={v.exchange}>
                <span className="funding-cmp__name venue-row__name">
                  <ExchangeLogo id={v.exchange} size={13} /> {name(v.exchange)}
                </span>
                <span className="funding-cmp__track" aria-hidden="true">
                  <span
                    className={`funding-cmp__bar${pos ? ' funding-cmp__bar--pos' : ' funding-cmp__bar--neg'}`}
                    style={
                      pos ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }
                    }
                  />
                </span>
                <span className={`funding-cmp__value num${pos ? ' pos' : ' neg'}`}>
                  {formatSignedPct(v.shortPct, 2)}
                </span>
              </div>
            );
          })}
          <div className="funding-cmp__legend">
            <span className="neg">{t('funding.legendNeg')}</span>
            <span className="pos">{t('funding.legendPos')}</span>
          </div>
        </section>
      )}
    </>
  );
}

/** Лучшая связка: столбики чистого фандинга (шорт получает − лонг платит) по корзинам. */
function PairCard({
  longEx,
  shortEx,
  netPct,
  bucket,
  rows,
}: {
  longEx: ExchangeId;
  shortEx: ExchangeId;
  netPct: number;
  bucket: FundingBucket;
  rows: FundingResponse['breakdown']['rows'];
}) {
  const { t } = useTranslation();
  const name = (id: string) => EXCHANGES.find((e) => e.id === id)?.name ?? id;
  const points = rows
    .map((r) => {
      const s = r.rates[shortEx];
      const l = r.rates[longEx];
      if (s === undefined && l === undefined) return null;
      return { ts: r.ts, net: (s ?? 0) - (l ?? 0) };
    })
    .filter((p): p is { ts: number; net: number } => p !== null);
  const max = Math.max(...points.map((p) => Math.abs(p.net)), 1e-6);
  const W = 340;
  const H = 64;
  const mid = H / 2;
  const slot = points.length ? W / points.length : W;
  const barW = Math.max(2, Math.min(14, slot * 0.7));
  const table = [...points].reverse().slice(0, 8);

  return (
    <section className="card funding-pair">
      <div className="funding-pair__head">
        <div>
          <div className="funding-pair__title">{t('funding.bestPair')}</div>
          <div className="funding-pair__legs">
            <span className="funding-pair__leg">
              <em className="coin-card__side coin-card__side--long">{t('funding.long')}</em>{' '}
              <ExchangeLogo id={longEx} size={12} /> {name(longEx)}
            </span>
            <span className="coin-card__arrow">→</span>
            <span className="funding-pair__leg">
              <em className="coin-card__side coin-card__side--short">{t('funding.short')}</em>{' '}
              <ExchangeLogo id={shortEx} size={12} /> {name(shortEx)}
            </span>
          </div>
        </div>
        <div className={`funding-pair__net num${netPct >= 0 ? ' pos' : ' neg'}`}>
          {formatSignedPct(netPct, 2)}
          <small>{t('funding.perPeriod')}</small>
        </div>
      </div>

      {points.length > 0 && (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="funding-break__svg" aria-hidden="true">
            <line x1={0} x2={W} y1={mid} y2={mid} stroke="var(--border-strong)" strokeWidth={1} />
            {points.map((p, i) => {
              const h = Math.max(1, (Math.abs(p.net) / max) * (mid - 3));
              const x = slot * i + (slot - barW) / 2;
              return (
                <rect
                  key={p.ts}
                  x={x}
                  y={p.net >= 0 ? mid - h : mid}
                  width={barW}
                  height={h}
                  rx={1.5}
                  fill={
                    p.net >= 0 ? 'var(--positive, var(--green))' : 'var(--negative, var(--red))'
                  }
                  opacity={0.9}
                />
              );
            })}
          </svg>
          <div className="funding-break__caption">
            {t(`funding.bucket_${bucket}`)} · {t('funding.netHint')}
          </div>
          <div className="funding-break__table num">
            {table.map((p) => (
              <div className="funding-break__row" key={p.ts}>
                <span>{fmtBucket(p.ts, bucket)}</span>
                <span className={p.net >= 0 ? 'pos' : 'neg'}>{formatSignedPct(p.net, 4)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
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
