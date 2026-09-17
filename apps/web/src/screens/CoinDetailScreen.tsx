/**
 * Экран одной монеты: где какая цена и что из этого получается.
 *
 * Главная ценность — не средняя цена, а разброс между биржами: видно, где
 * дешевле всего купить, где дороже всего продать, и сколько от этой разницы
 * останется после комиссий и фандинга.
 */
import {
  exchange,
  formatClock,
  formatPct,
  formatPrice,
  formatSignedPct,
  priceDecimals,
  type CoinDetail,
  type VenueQuote,
} from '@cs/shared';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { CoinIcon } from '../components/CoinIcon';
import { ExchangeLogo } from '../components/ExchangeLogo';
import { FundingHistory } from '../components/FundingHistory';
import { SpreadChart } from '../components/SpreadChart';
import { InfoRow, Section } from '../components/Form';
import { ArrowDownIcon, ArrowUpIcon, BellIcon, ClockIcon } from '../icons';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';

export function CoinDetailScreen({
  base,
  onAlert,
}: {
  base: string;
  onAlert?: (base: string) => void;
}) {
  const { t } = useTranslation();
  const fetcher = useCallback(() => api.coin(base), [base]);
  const { data, error } = usePolling<CoinDetail>(fetcher, 1000);

  if (error) return <div className="card empty">{t('app.loadError')}</div>;
  if (!data) return <div className="empty">{t('app.loading')}</div>;

  const decimals = priceDecimals(data.quotes[0]?.price ?? 1);
  const cheapest = data.quotes[0];
  const dearest = data.quotes[data.quotes.length - 1];

  return (
    <div className="stack">
      <section className="card coin-head">
        <CoinIcon base={data.base} size={40} />
        <div className="coin-head__text">
          <div className="coin-head__ticker">{data.base}/USDT</div>
          <div className="coin-head__name">{data.name}</div>
        </div>
        <div className="coin-head__spread">
          <div className="coin-head__spread-value num">{formatPct(data.best.spreadPct)}</div>
          <div className="coin-head__spread-label">{t('screener.colSpread')}</div>
        </div>
      </section>

      <button className="btn-ghost coin-alert" type="button" onClick={() => onAlert?.(data.base)}>
        <BellIcon size={15} />
        {t('alerts.tileFull', { base: data.base })}
      </button>

      <SpreadChart base={data.base} />

      <Section title={t('coin.bestPair')} hint={t('coin.bestPairHint')}>
        <InfoRow
          label={t('coin.buyOn')}
          value={`${exchange(data.best.longExchange).name} · ${formatPrice(cheapest?.ask ?? 0, decimals)}`}
          tone="green"
        />
        <InfoRow
          label={t('coin.sellOn')}
          value={`${exchange(data.best.shortExchange).name} · ${formatPrice(dearest?.bid ?? 0, decimals)}`}
          tone="red"
        />
        <InfoRow label={t('coin.grossSpread')} value={formatPct(data.best.spreadPct)} />
        <InfoRow label={t('pd.fees')} value={`−${formatPct(data.best.feesPct)}`} tone="dim" />
        <InfoRow
          label={t('coin.fundingDiff')}
          value={formatSignedPct(data.best.fundingPct, 4)}
          tone={data.best.fundingPct >= 0 ? 'green' : 'red'}
        />
        <InfoRow
          label={t('coin.netProfit')}
          value={formatSignedPct(data.best.netPct)}
          tone={data.best.netPct > 0 ? 'green' : 'red'}
        />
      </Section>

      <FundingHistory base={data.base} />

      <div className="section-label">{t('coin.pricesByVenue')}</div>
      <section className="card list">
        {data.quotes.map((q, i) => (
          <VenueRow
            key={q.exchange}
            quote={q}
            decimals={decimals}
            cheapest={i === 0}
            dearest={i === data.quotes.length - 1}
          />
        ))}
      </section>

      <section className="card notice">
        <ClockIcon className="notice__icon" />
        <span>
          {t('coin.updatedAt', { time: formatClock(data.updatedAt) })} · {t('coin.fundingNote')}
        </span>
      </section>
    </div>
  );
}

function VenueRow({
  quote,
  decimals,
  cheapest,
  dearest,
}: {
  quote: VenueQuote;
  decimals: number;
  cheapest: boolean;
  dearest: boolean;
}) {
  const { t } = useTranslation();
  const meta = exchange(quote.exchange);

  return (
    <div className="list__item venue-row">
      <span>
        <span className="list__title venue-row__name">
          <ExchangeLogo id={quote.exchange} size={16} />
          <span>{meta.name}</span>
          {cheapest && (
            <span className="badge badge--long" style={{ marginTop: 0 }}>
              <ArrowUpIcon size={9} />
              {t('coin.cheapest')}
            </span>
          )}
          {dearest && (
            <span className="badge badge--short" style={{ marginTop: 0 }}>
              <ArrowDownIcon size={9} />
              {t('coin.dearest')}
            </span>
          )}
        </span>
        <span className="list__sub num">
          bid {formatPrice(quote.bid, decimals)} · ask {formatPrice(quote.ask, decimals)}
        </span>
      </span>
      <span />
      <span className="venue-row__right">
        <span className="venue-row__price num">{formatPrice(quote.price, decimals)}</span>
        <span
          className="venue-row__funding num"
          style={{ color: quote.fundingPct >= 0 ? 'var(--green)' : 'var(--red)' }}
        >
          {t('coin.funding')} {formatSignedPct(quote.fundingPct, 4)}
        </span>
      </span>
    </div>
  );
}
