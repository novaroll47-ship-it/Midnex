/**
 * График истории спреда по монете: 1 ч / 24 ч / 7 д.
 *
 * Простой SVG без библиотек: линия по close, тень high–low, подписи
 * минимума и максимума. Реконструированные (по свечам бирж) участки
 * рисуются пунктиром — это приближение, а не измерение.
 */
import { formatPct } from '@cs/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { api, type HistoryResponse } from '../lib/api';

type Range = '1h' | '24h' | '7d';

const RANGE: Record<Range, { tf: '1m' | '5m' | '1h'; spanMs: number }> = {
  '1h': { tf: '1m', spanMs: 3_600_000 },
  '24h': { tf: '5m', spanMs: 86_400_000 },
  '7d': { tf: '1h', spanMs: 7 * 86_400_000 },
};

export function SpreadChart({ base }: { base: string }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>('24h');
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    const { tf, spanMs } = RANGE[range];
    const to = Date.now();
    api
      .history(base, tf, to - spanMs, to)
      .then((r) => alive && setData(r))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [base, range]);

  const candles = data?.candles ?? [];
  const width = 340;
  const height = 120;
  const pad = 6;

  let body: ReactNode;
  if (error) {
    body = <div className="chart__empty">{t('chart.unavailable')}</div>;
  } else if (!data) {
    body = <div className="chart__empty">{t('app.loading')}</div>;
  } else if (candles.length < 2) {
    body = <div className="chart__empty">{t('chart.noData')}</div>;
  } else {
    const lo = Math.min(...candles.map((c) => c.low));
    const hi = Math.max(...candles.map((c) => c.high));
    const span = hi - lo || 1;
    const x = (i: number) => pad + (i / (candles.length - 1)) * (width - pad * 2);
    const y = (v: number) => height - pad - ((v - lo) / span) * (height - pad * 2);

    const area =
      candles.map((c, i) => `${x(i).toFixed(1)},${y(c.high).toFixed(1)}`).join(' ') +
      ' ' +
      [...candles]
        .reverse()
        .map((c, i) => `${x(candles.length - 1 - i).toFixed(1)},${y(c.low).toFixed(1)}`)
        .join(' ');

    // Линию режем на отрезки по источнику: живые — сплошные, свечи — пунктир.
    const segments: { source: string; points: string[] }[] = [];
    candles.forEach((c, i) => {
      const pt = `${x(i).toFixed(1)},${y(c.close).toFixed(1)}`;
      const last = segments[segments.length - 1];
      if (last && last.source === c.source) last.points.push(pt);
      else {
        if (last) last.points.push(pt);
        segments.push({ source: c.source, points: [pt] });
      }
    });

    body = (
      <>
        <svg viewBox={`0 0 ${width} ${height}`} className="chart__svg" aria-hidden="true">
          <polygon points={area} fill="var(--green)" opacity={0.12} />
          {segments.map((s, i) => (
            <polyline
              key={i}
              points={s.points.join(' ')}
              fill="none"
              stroke="var(--green)"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={s.source === 'reconstructed' ? '4 4' : undefined}
            />
          ))}
        </svg>
        <div className="chart__legend num">
          <span>
            {t('chart.min')} {formatPct(lo)}
          </span>
          <span>
            {t('chart.max')} {formatPct(hi)}
          </span>
          <span>
            {t('chart.last')} {formatPct(candles[candles.length - 1]!.close)}
          </span>
        </div>
      </>
    );
  }

  return (
    <section className="card chart">
      <div className="chart__head">
        <span className="chart__title">{t('chart.title')}</span>
        <div className="segmented segmented--mini">
          {(['1h', '24h', '7d'] as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`segmented__item${range === r ? ' segmented__item--active' : ''}`}
              onClick={() => setRange(r)}
            >
              {t(`chart.range_${r}`)}
            </button>
          ))}
        </div>
      </div>
      {body}
    </section>
  );
}
