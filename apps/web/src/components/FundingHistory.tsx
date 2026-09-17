/**
 * Накопленный фандинг по монете за период — отдельно для лонга и шорта на
 * каждой бирже. Сумма ставок за период: лонг её платит, шорт получает.
 */
import { EXCHANGES, formatSignedPct } from '@cs/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, type FundingPeriod, type FundingResponse } from '../lib/api';
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
        {data?.venues.map((v) => (
          <div className="list__item" key={v.exchange}>
            <span>
              <span className="list__title venue-row__name">
                <ExchangeLogo id={v.exchange} size={14} /> {name(v.exchange)}
              </span>
              <span className="list__sub">
                {t('funding.payouts', { count: v.payouts })} · {t('funding.avg')}{' '}
                {formatSignedPct(v.avgRatePct, 4)}
              </span>
            </span>
            <span />
            <span className="funding-cell num">
              <span style={{ color: v.longPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {t('funding.long')} {formatSignedPct(v.longPct, 2)}
              </span>
              <span style={{ color: v.shortPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {t('funding.short')} {formatSignedPct(v.shortPct, 2)}
              </span>
            </span>
          </div>
        ))}
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
