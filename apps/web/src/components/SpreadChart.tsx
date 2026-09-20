/**
 * График истории спреда по монете: 1 ч / 24 ч / 7 д / 30 д.
 *
 * Простой SVG без библиотек: линия по close на шкале времени, заливка под
 * ней, подписи минимума и максимума, ось времени. Обновляется каждые 5 с —
 * правый край живёт вместе со скринером. Палец или курсор на графике
 * показывает точку: дата, время, спред, разброс внутри свечи и пара бирж.
 * Реконструированные (по свечам бирж) участки рисуются пунктиром — это
 * приближение, а не измерение.
 */
import { EXCHANGES, formatPct, type ExchangeId } from '@cs/shared';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ChartIcon } from '../icons';
import { api, type HistoryResponse } from '../lib/api';

type Range = '1h' | '24h' | '7d' | '30d';
type Tf = '1m' | '5m' | '15m' | '1h';
export type ChartPair = { exA: ExchangeId; exB: ExchangeId };

const RANGE: Record<Range, { tf: Tf; spanMs: number }> = {
  '1h': { tf: '1m', spanMs: 3_600_000 },
  '24h': { tf: '5m', spanMs: 86_400_000 },
  '7d': { tf: '1h', spanMs: 7 * 86_400_000 },
  '30d': { tf: '1h', spanMs: 30 * 86_400_000 },
};
/** По конкретной паре свечи крупнее (15m/1h), и часового диапазона нет. */
const PAIR_RANGE: Record<Exclude<Range, '1h'>, { tf: Tf; spanMs: number }> = {
  '24h': { tf: '15m', spanMs: 86_400_000 },
  '7d': { tf: '1h', spanMs: 7 * 86_400_000 },
  '30d': { tf: '1h', spanMs: 30 * 86_400_000 },
};
const TF_MS: Record<Tf, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };

function samePair(a: ChartPair | null, b: ChartPair | null): boolean {
  if (!a || !b) return a === b;
  return (a.exA === b.exA && a.exB === b.exB) || (a.exA === b.exB && a.exB === b.exA);
}

const REFRESH_MS = 5000;
const WIDTH = 340;
const HEIGHT = 120;
const PAD_X = 6;
const PAD_Y = 8;

export function SpreadChart({
  base,
  pairs = [],
  currentPair = null,
  onOpenFull,
}: {
  base: string;
  /** Сверенные пары монеты — для сравнения бирж. */
  pairs?: ChartPair[];
  /** Пара из таблицы (лучшая сейчас) — открывается первой. */
  currentPair?: ChartPair | null;
  /** Открыть полноэкранный график с той же парой. */
  onOpenFull?: (pair: ChartPair | null) => void;
}) {
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>('24h');
  // null — «лучшая пара монеты» (история по монете), иначе — конкретная пара.
  const [pair, setPair] = useState<ChartPair | null>(currentPair);
  const [pairTouched, setPairTouched] = useState(false);
  useEffect(() => {
    // Пока пользователь не выбирал сам, следуем за парой из таблицы.
    if (!pairTouched && currentPair && !samePair(pair, currentPair)) setPair(currentPair);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPair?.exA, currentPair?.exB]);
  const effectiveRange: Range = pair && range === '1h' ? '24h' : range;
  const pairKeyStr = pair ? `${pair.exA}|${pair.exB}` : '';
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    setHover(null);
    const { tf, spanMs } = pair
      ? PAIR_RANGE[effectiveRange as Exclude<Range, '1h'>]
      : RANGE[effectiveRange];
    const load = () => {
      if (document.hidden) return;
      const to = Date.now();
      api
        .history(base, tf, to - spanMs, to, pair ?? undefined)
        .then((r) => {
          if (!alive) return;
          setData(r);
          setError(false);
        })
        .catch(() => alive && setError(true));
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, effectiveRange, pairKeyStr]);

  const candles = data?.candles ?? [];
  const exName = (id: string) => EXCHANGES.find((e) => e.id === id)?.name ?? id;

  let body: ReactNode;
  if (error && !data) {
    body = <div className="chart__empty">{t('chart.unavailable')}</div>;
  } else if (!data) {
    body = <div className="chart__empty">{t('app.loading')}</div>;
  } else if (candles.length < 2) {
    body = <div className="chart__empty">{t('chart.noData')}</div>;
  } else {
    const from = data.from;
    const to = data.to;
    // Шкала — по 98-му процентилю: один всплеск от замершей котировки не
    // должен сплющивать весь график. Что выше — прижимается к верхнему краю.
    const closes = candles.map((c) => c.close).sort((a, b) => a - b);
    const lo = closes[0]!;
    const realHi = closes[closes.length - 1]!;
    const p98 = closes[Math.min(closes.length - 1, Math.floor(closes.length * 0.98))]!;
    const hi = realHi > p98 * 1.5 ? p98 * 1.5 : realHi;
    const clipped = hi < realHi;
    const span = hi - lo || Math.abs(hi) || 1;
    const x = (ts: number) => PAD_X + ((ts - from) / (to - from)) * (WIDTH - PAD_X * 2);
    const y = (v: number) =>
      HEIGHT - PAD_Y - ((Math.min(v, hi) - lo) / span) * (HEIGHT - PAD_Y * 2);

    const pts = candles.map((c) => ({ x: x(c.ts), y: y(c.close), c }));
    const tfMs =
      TF_MS[(pair ? PAIR_RANGE[effectiveRange as Exclude<Range, '1h'>] : RANGE[effectiveRange]).tf];
    // Дыра в данных (процесс не работал) — разрыв, а не прямая через полночь.
    // Участки, восстановленные по часовым свечам, идут с часовым шагом —
    // для них допустимый промежуток шире.
    const isGap = (i: number) => {
      if (i === 0) return false;
      const a = pts[i - 1]!.c;
      const b = pts[i]!.c;
      const step =
        a.source === 'reconstructed' || b.source === 'reconstructed'
          ? Math.max(tfMs, 3_600_000)
          : tfMs;
      return b.ts - a.ts > step * 3;
    };

    // Заливка — по непрерывным кускам, линия — ещё и по источнику: живые —
    // сплошные, реконструированные по свечам — пунктир.
    const areas: string[] = [];
    const segments: { source: string; points: string[] }[] = [];
    let run: typeof pts = [];
    const flushArea = () => {
      if (run.length === 0) return;
      areas.push(
        `${run[0]!.x.toFixed(1)},${HEIGHT} ` +
          run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') +
          ` ${run[run.length - 1]!.x.toFixed(1)},${HEIGHT}`,
      );
      run = [];
    };
    pts.forEach((p, i) => {
      const gap = isGap(i);
      if (gap) flushArea();
      run.push(p);
      const pt = `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      const last = segments[segments.length - 1];
      if (last && last.source === p.c.source && !gap) last.points.push(pt);
      else {
        if (last && !gap) last.points.push(pt);
        segments.push({ source: p.c.source, points: [pt] });
      }
    });
    flushArea();

    const onPointer = (e: PointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * WIDTH;
      let best = 0;
      let dist = Infinity;
      pts.forEach((p, i) => {
        const d = Math.abs(p.x - px);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      setHover(best);
    };

    const h = hover !== null && hover < pts.length ? pts[hover]! : null;
    const tipLeftPct = h ? Math.min(Math.max((h.x / WIDTH) * 100, 22), 78) : 0;
    const ticks = timeTicks(from, to, effectiveRange);

    body = (
      <>
        <div className="chart__plot">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="chart__svg"
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={() => setHover(null)}
          >
            {areas.map((a, i) => (
              <polygon key={i} points={a} fill="var(--green)" opacity={0.1} />
            ))}
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
            {h && (
              <>
                <line
                  x1={h.x}
                  x2={h.x}
                  y1={0}
                  y2={HEIGHT}
                  stroke="var(--text-mute)"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
                <circle
                  cx={h.x}
                  cy={h.y}
                  r={3.5}
                  fill="var(--green)"
                  stroke="var(--bg)"
                  strokeWidth={1.5}
                />
              </>
            )}
          </svg>
          {h && (
            <div className="chart__tip num" style={{ left: `${tipLeftPct}%` }}>
              <div className="chart__tip-time">{fmtStamp(h.c.ts, effectiveRange)}</div>
              <div className="chart__tip-main">{formatPct(h.c.close)}</div>
              <div className="chart__tip-sub">
                {formatPct(h.c.low)} – {formatPct(h.c.high)}
              </div>
              <div className="chart__tip-sub">
                {exName(h.c.exA)} → {exName(h.c.exB)}
                {h.c.source === 'reconstructed' ? ' ≈' : ''}
              </div>
            </div>
          )}
        </div>
        <div className="chart__axis num">
          {ticks.map((tk) => (
            <span key={tk.ts} style={{ left: `${(x(tk.ts) / WIDTH) * 100}%` }}>
              {tk.label}
            </span>
          ))}
        </div>
        <div className="chart__legend num">
          <span>
            {t('chart.min')} {formatPct(lo)}
          </span>
          <span>
            {t('chart.max')} {formatPct(realHi)}
            {clipped ? ' ↑' : ''}
          </span>
          <span>
            {t('chart.last')} {formatPct(candles[candles.length - 1]!.close)}
          </span>
        </div>
        {candles.some((c) => c.source === 'reconstructed') && (
          <div className="chart__note">{t('chart.reconstructed')}</div>
        )}
      </>
    );
  }

  return (
    <section className="card chart">
      <div className="chart__head">
        <span className="chart__title">{t('chart.title')}</span>
        <div className="segmented segmented--mini">
          {(pair ? (['24h', '7d', '30d'] as Range[]) : (['1h', '24h', '7d', '30d'] as Range[])).map(
            (r) => (
              <button
                key={r}
                type="button"
                className={`segmented__item${effectiveRange === r ? ' segmented__item--active' : ''}`}
                onClick={() => setRange(r)}
              >
                {t(`chart.range_${r}`)}
              </button>
            ),
          )}
        </div>
      </div>
      {pairs.length > 0 && (
        <div className="chart__pairs">
          <button
            type="button"
            className={`chip-mini chip-mini--tap${pair === null ? ' chip-mini--on' : ''}`}
            onClick={() => {
              setPairTouched(true);
              setPair(null);
            }}
          >
            {t('chart.bestPair')}
          </button>
          {pairs.map((p) => (
            <button
              key={`${p.exA}|${p.exB}`}
              type="button"
              className={`chip-mini chip-mini--tap${samePair(pair, p) ? ' chip-mini--on' : ''}`}
              onClick={() => {
                setPairTouched(true);
                setPair(p);
              }}
            >
              {exName(p.exA)} ↔ {exName(p.exB)}
            </button>
          ))}
        </div>
      )}
      {body}
      {onOpenFull && (
        <button type="button" className="btn-ghost chart__open" onClick={() => onOpenFull(pair)}>
          <ChartIcon size={15} />
          {t('chart.openFull')}
        </button>
      )}
    </section>
  );
}

/** Подписи оси времени: 4–5 круглых отметок внутри диапазона. */
function timeTicks(from: number, to: number, range: Range): { ts: number; label: string }[] {
  const step =
    range === '1h'
      ? 15 * 60_000
      : range === '24h'
        ? 6 * 3_600_000
        : range === '7d'
          ? 86_400_000
          : 7 * 86_400_000;
  const out: { ts: number; label: string }[] = [];
  const offset = new Date().getTimezoneOffset() * 60_000;
  // Круглые отметки — в местном времени, чтобы «00:00» стоял на полуночи.
  let ts = Math.ceil((from - offset) / step) * step + offset;
  for (; ts <= to; ts += step) {
    // Крайние подписи налезают на рамку — их пропускаем.
    if (ts - from < (to - from) * 0.06 || to - ts < (to - from) * 0.06) continue;
    out.push({ ts, label: range === '1h' || range === '24h' ? fmtTime(ts) : fmtDay(ts) });
  }
  return out;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function fmtStamp(ts: number, range: Range): string {
  const d = new Date(ts);
  const day = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const time = fmtTime(ts);
  return range === '1h' ? time : `${day} ${time}`;
}
