/**
 * Блок «Ликвидность» на экране монеты: спред и прибыль на объёме
 * пользователя, рекомендуемый объём и прибыль на нём, кривая «объём →
 * прибыль» по сетке, какая нога ограничивает. Всё — по текущему стакану,
 * без экстраполяции: если видимых уровней не хватает, так и пишем.
 */
import { EXCHANGES, formatSignedPct, type ExchangeId, type LiquidityDetail } from '@cs/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';

export function LiquidityBlock({
  base,
  defaultVolume,
  venues,
}: {
  base: string;
  /** «Мой объём по умолчанию» из настроек, USDT. */
  defaultVolume: number;
  /** Биржи для расчёта — как в шапке монеты. */
  venues?: string;
}) {
  const { t } = useTranslation();
  // Объём в деталях — временный, на время просмотра; настройку не трогает.
  const [draft, setDraft] = useState(String(defaultVolume));
  const [volume, setVolume] = useState(defaultVolume);
  useEffect(() => {
    const v = Number(draft.replace(',', '.'));
    if (Number.isFinite(v) && v >= 10) setVolume(v);
  }, [draft]);

  const fetcher = useCallback(() => api.coinLiquidity(base, volume, venues), [base, volume, venues]);
  const { data, error } = usePolling<LiquidityDetail>(fetcher, 2000);
  const name = (id: ExchangeId) => EXCHANGES.find((e) => e.id === id)?.name ?? id;

  const usd = (v: number) =>
    v >= 1000 ? `$${Math.round(v).toLocaleString('ru-RU')}` : `$${v.toFixed(v >= 100 ? 0 : 2)}`;

  const chart = useMemo(() => {
    if (!data) return null;
    const pts = data.curve.filter((c) => c.volumeUsdt <= Math.max(data.availableUsdt * 1.5, data.recommended.volumeUsdt * 2, 500));
    if (pts.length < 2) return null;
    const W = 340;
    const H = 90;
    const padL = 6;
    const padR = 6;
    const maxV = pts[pts.length - 1]!.volumeUsdt;
    const minV = pts[0]!.volumeUsdt;
    const hi = Math.max(0.01, ...pts.map((p) => p.profitUsdt));
    // Ниже нуля кривая уходит в минус тысячами — обрезаем, иначе прибыль
    // сплющится в линию у верхнего края.
    const lo = Math.max(Math.min(0, ...pts.map((p) => p.profitUsdt)), -hi * 0.35);
    // Ось объёма — логарифмическая: сетка 100…50 000 иначе сжимается в угол.
    const x = (v: number) => padL + ((Math.log(v) - Math.log(minV)) / (Math.log(maxV) - Math.log(minV))) * (W - padL - padR);
    const y = (p: number) => 8 + (1 - (Math.max(lo, p) - lo) / (hi - lo)) * (H - 16);
    const line = pts.map((p) => `${x(p.volumeUsdt).toFixed(1)},${y(p.profitUsdt).toFixed(1)}`).join(' ');
    const rec = data.recommended.volumeUsdt;
    const recX = rec >= minV && rec <= maxV ? x(rec) : null;
    const yourX = volume >= minV && volume <= maxV ? x(volume) : null;
    return { W, H, line, y0: y(0), recX, recY: recX !== null ? y(data.recommended.profitUsdt) : 0, yourX, yourY: yourX !== null ? y(data.yours.profitUsdt) : 0, pts, x, y };
  }, [data, volume]);

  return (
    <>
      <div className="section-label">{t('liq.title')}</div>
      <section className="card liq">
        <label className="liq__volume">
          <span>
            <span className="liq__volume-title">{t('liq.yourVolume')}</span>
            <span className="liq__volume-sub">{t('liq.yourVolumeSub')}</span>
          </span>
          <span className="num-field">
            <input
              className="num-field__input num"
              inputMode="numeric"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <span className="num-field__unit">USDT</span>
          </span>
        </label>

        {error && !data && <div className="empty">{t('liq.unavailable')}</div>}
        {!error && !data && <div className="empty">{t('liq.waiting')}</div>}

        {data && (
          <>
            <div className="liq__grid num">
              <div className="liq__cell">
                <div className="liq__cell-label">
                  {t('liq.onYourVolume', { volume: usd(data.yours.fullyFilled ? data.yours.requestedUsdt : data.yours.volumeUsdt) })}
                </div>
                <div className={`liq__cell-value ${data.yours.netPct > 0 ? 'tone-pos' : 'tone-neg'}`}>
                  {formatSignedPct(data.yours.netPct)}
                </div>
                <div className="liq__cell-sub">
                  {t('liq.profit')} <b className={data.yours.profitUsdt >= 0 ? 'tone-pos' : 'tone-neg'}>{usd(data.yours.profitUsdt)}</b>
                  {!data.yours.fullyFilled && (
                    <span className="liq__warn"> · {t('liq.onlyFits', { volume: usd(data.yours.volumeUsdt) })}</span>
                  )}
                </div>
              </div>
              <div className="liq__cell">
                <div className="liq__cell-label">{t('liq.atBest')}</div>
                <div className={`liq__cell-value ${data.topNetPct > 0 ? 'tone-pos' : 'tone-neg'}`}>
                  {formatSignedPct(data.topNetPct)}
                </div>
                <div className="liq__cell-sub">{t('liq.grossTop', { value: formatSignedPct(data.topGrossPct) })}</div>
              </div>
            </div>

            <div className="liq__rec num">
              <div>
                <div className="liq__cell-label">{t('liq.recommended')}</div>
                <div className="liq__rec-value">
                  {data.recommended.volumeUsdt > 0 ? usd(data.recommended.volumeUsdt) : '—'}
                </div>
              </div>
              <div className="liq__rec-right">
                {data.recommended.volumeUsdt > 0 ? (
                  <>
                    <div className="tone-pos liq__rec-profit">+{usd(data.recommended.profitUsdt)}</div>
                    <div className="liq__cell-sub">
                      {t('liq.netAt', { value: formatSignedPct(data.recommended.netPct) })}
                      {data.recommended.liquidityCapped && ` · ${t('liq.cappedLiquidity')}`}
                      {data.recommended.thresholdCapped && ` · ${t('liq.cappedThreshold', { pct: data.minNetPct })}`}
                    </div>
                  </>
                ) : (
                  <div className="liq__cell-sub tone-neg">{t('liq.noSpreadInBook', { value: formatSignedPct(data.curve[0]?.netPct ?? 0) })}</div>
                )}
              </div>
            </div>

            {chart && (
              <div className="liq__chart">
                <svg viewBox={`0 0 ${chart.W} ${chart.H}`} className="liq__svg" aria-hidden="true">
                  <line x1={0} x2={chart.W} y1={chart.y0} y2={chart.y0} stroke="var(--border-strong)" strokeWidth={1} />
                  <polyline points={chart.line} fill="none" stroke="var(--brand)" strokeWidth={2} strokeLinejoin="round" />
                  {chart.pts.map((p) => (
                    <circle key={p.volumeUsdt} cx={chart.x(p.volumeUsdt)} cy={chart.y(p.profitUsdt)} r={2.2} fill="var(--brand)" />
                  ))}
                  {chart.recX !== null && (
                    <>
                      <line x1={chart.recX} x2={chart.recX} y1={4} y2={chart.H - 4} stroke="var(--positive)" strokeDasharray="3 3" />
                      <circle cx={chart.recX} cy={chart.recY} r={4} fill="var(--positive)" stroke="var(--bg)" strokeWidth={1.5} />
                    </>
                  )}
                  {chart.yourX !== null && (
                    <circle cx={chart.yourX} cy={chart.yourY} r={4} fill="var(--amber)" stroke="var(--bg)" strokeWidth={1.5} />
                  )}
                </svg>
                <div className="liq__axis num">
                  {chart.pts.map((p) => (
                    <span key={p.volumeUsdt} style={{ left: `${(chart.x(p.volumeUsdt) / chart.W) * 100}%` }}>
                      {p.volumeUsdt >= 1000 ? `${p.volumeUsdt / 1000}k` : p.volumeUsdt}
                    </span>
                  ))}
                </div>
                <div className="liq__legend">
                  <span><i className="liq__dot liq__dot--rec" /> {t('liq.legendRec')}</span>
                  <span><i className="liq__dot liq__dot--you" /> {t('liq.legendYou')}</span>
                </div>
              </div>
            )}

            <div className="liq__foot">
              <div>
                {t('liq.available', { volume: usd(data.availableUsdt) })}
                {data.availableLimitingLeg && (
                  <>
                    {' · '}
                    {t('liq.limiting', {
                      exchange: name(data.availableLimitingLeg === 'long' ? data.longExchange : data.shortExchange),
                      side: t(data.availableLimitingLeg === 'long' ? 'liq.sideLong' : 'liq.sideShort'),
                    })}
                  </>
                )}
              </div>
              <div>
                {t('liq.pair', { long: name(data.longExchange), short: name(data.shortExchange) })} ·{' '}
                {data.deep ? t('liq.deepBook', { n: Math.min(data.levels.long, data.levels.short) }) : t('liq.shallowBook')} ·{' '}
                {t('liq.age', { s: Math.round(data.bookAgeMs / 1000) })}
              </div>
              <div className="liq__note">{t('liq.note')}</div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
