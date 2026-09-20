/**
 * Полноэкранный график спреда: canvas, который можно таскать и
 * масштабировать — влево-вправо по времени, вверх-вниз по шкале.
 *
 * Свечи рисуются вертикальной чертой low–high (зелёная, если закрытие выше
 * открытия, иначе красная), закрытия соединены линией. Всегда видна линия
 * 0 %, справа — шкала и метка текущего значения. Кнопка «→» возвращает к
 * началу графика (последней свече) и снимает ручной масштаб по вертикали.
 */
import { EXCHANGES, formatPct, type ExchangeId } from '@cs/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChevronRightIcon } from '../icons';
import { api, type HistoryCandle } from '../lib/api';
import { haptic } from '../lib/telegram';

export type ChartPair = { exA: ExchangeId; exB: ExchangeId };

type Tf = '1m' | '5m' | '15m' | '1h' | '1d';
const TF_MS: Record<Tf, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};
/** Сколько истории грузим на каждый таймфрейм. */
const SPAN_MS: Record<Tf, number> = {
  '1m': 24 * 3_600_000,
  '5m': 7 * 86_400_000,
  '15m': 2 * 86_400_000,
  '1h': 180 * 86_400_000,
  '1d': 180 * 86_400_000,
};
const REFRESH_MS = 5000;
const AXIS_W = 52;
const AXIS_H = 22;
const MIN_PX = 1.5;
const MAX_PX = 80;

interface View {
  /** Индекс свечи у правого края области (дробный). */
  right: number;
  /** Пикселей на свечу. */
  px: number;
  /** Ручная шкала Y; null — подстраивается под видимые свечи. */
  y: { min: number; max: number } | null;
}

export function FullChartScreen({ base, pair }: { base: string; pair: ChartPair | null }) {
  const { t } = useTranslation();
  const [tf, setTf] = useState<Tf>(pair ? '15m' : '5m');
  const [candles, setCandles] = useState<HistoryCandle[]>([]);
  const [error, setError] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 360, h: 400 });
  const viewRef = useRef<View>({ right: 0, px: 6, y: null });
  const [, force] = useState(0);
  const redraw = useCallback(() => force((n) => n + 1), []);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const followRef = useRef(true);

  const tfs: Tf[] = pair ? ['15m', '1h', '1d'] : ['1m', '5m', '1h', '1d'];
  const exName = (id: string) => EXCHANGES.find((e) => e.id === id)?.name ?? id;

  // Данные: по паре — свои таймфреймы; «1 д» собираем из часовых.
  useEffect(() => {
    let alive = true;
    setCandles([]);
    setError(false);
    followRef.current = true;
    viewRef.current = { right: 0, px: 9, y: null };
    const srcTf = tf === '1d' ? '1h' : tf;
    const load = () => {
      if (document.hidden) return;
      const to = Date.now();
      api
        .history(base, srcTf, to - SPAN_MS[tf], to, pair ?? undefined)
        .then((r) => {
          if (!alive) return;
          const rows = tf === '1d' ? aggregateDaily(r.candles) : r.candles;
          setCandles(rows);
          setError(false);
          if (followRef.current) viewRef.current.right = rows.length - 1;
        })
        .catch(() => alive && setError(true));
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base, tf, pair]);

  // Размер под контейнер.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: Math.max(200, Math.floor(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = size.w - AXIS_W;
  const plotH = size.h - AXIS_H;

  const visible = useMemo(() => {
    const v = viewRef.current;
    const count = plotW / v.px;
    const last = Math.min(candles.length - 1, Math.ceil(v.right));
    const first = Math.max(0, Math.floor(v.right - count));
    return { first, last, count };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, plotW, viewRef.current.right, viewRef.current.px]);

  // Шкала Y: авто по видимым свечам (с запасом), либо ручная.
  const yRange = useMemo(() => {
    const v = viewRef.current;
    if (v.y) return v.y;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = visible.first; i <= visible.last; i++) {
      const c = candles[i];
      if (!c) continue;
      lo = Math.min(lo, c.low, 0);
      hi = Math.max(hi, c.high, 0);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: -1, max: 3 };
    const pad = Math.max((hi - lo) * 0.12, 0.05);
    return { min: lo - pad, max: hi + pad };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, visible, viewRef.current.y]);

  // ---------------------------------------------------------------- отрисовка
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const colText = css.getPropertyValue('--text-mute').trim() || '#6e6e71';
    const colGrid = 'rgba(128,128,128,0.14)';
    const colPos = css.getPropertyValue('--positive').trim() || '#4ade80';
    const colNeg = css.getPropertyValue('--negative').trim() || '#f87171';
    const colBrand = css.getPropertyValue('--brand').trim() || colPos;
    const bg = css.getPropertyValue('--surface').trim() || '#141414';

    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size.w, size.h);

    const v = viewRef.current;
    const { min, max } = yRange;
    const yOf = (val: number) => plotH - ((val - min) / (max - min)) * plotH;
    const xOf = (i: number) => plotW - (v.right - i) * v.px - v.px / 2;

    // Сетка и шкала Y.
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const step = niceStep((max - min) / 5);
    for (let val = Math.ceil(min / step) * step; val <= max; val += step) {
      const y = yOf(val);
      ctx.strokeStyle = colGrid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.fillStyle = colText;
      ctx.textAlign = 'left';
      ctx.fillText(`${trimNum(val)}%`, plotW + 6, y);
    }
    // Ноль — всегда, ярче.
    if (min < 0 && max > 0) {
      const y0 = yOf(0);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(plotW, y0);
      ctx.stroke();
      pill(ctx, plotW + 4, y0, '0%', 'rgba(255,255,255,0.9)', '#111');
    }

    // Сетка и подписи X.
    const stepIdx = Math.max(1, Math.round((tf === '1h' ? 120 : 80) / v.px));
    ctx.textAlign = 'center';
    for (let i = visible.first; i <= visible.last; i++) {
      const c = candles[i];
      if (!c || i % stepIdx !== 0) continue;
      const x = xOf(i);
      ctx.strokeStyle = colGrid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.fillStyle = colText;
      ctx.fillText(fmtAxis(c.ts, tf), x, plotH + AXIS_H / 2);
    }

    // Свечи: тело open–close, тени low–high; при мелком масштабе (тело
    // уже 3px) — только тонкая черта, иначе получается частокол.
    const bodyW = Math.max(1, Math.floor(v.px * 0.62));
    const thin = bodyW < 3;
    const wick = thin ? 1 : Math.max(1, Math.min(1.5, v.px * 0.12));
    for (let i = visible.first; i <= visible.last; i++) {
      const c = candles[i];
      if (!c) continue;
      const x = xOf(i);
      const up = c.close >= c.open;
      const col = up ? colPos : colNeg;
      ctx.globalAlpha = c.source === 'reconstructed' ? 0.5 : 1;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = wick;
      ctx.beginPath();
      ctx.moveTo(x, yOf(c.high));
      ctx.lineTo(x, yOf(c.low));
      ctx.stroke();
      if (!thin) {
        const yo = yOf(c.open);
        const yc = yOf(c.close);
        const top = Math.min(yo, yc);
        const h = Math.max(1.5, Math.abs(yo - yc));
        ctx.fillRect(x - bodyW / 2, top, bodyW, h);
      }
      ctx.globalAlpha = 1;
    }

    // Текущее значение: пунктир и метка.
    const lastC = candles[candles.length - 1];
    if (lastC) {
      const y = yOf(lastC.close);
      if (y >= 0 && y <= plotH) {
        ctx.strokeStyle = colBrand;
        ctx.setLineDash([2, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        pill(ctx, plotW + 4, y, formatPct(lastC.close), colBrand, '#06130c');
      }
    }

    // Перекрестие.
    if (hover) {
      const i = Math.round(v.right - (plotW - hover.x) / v.px);
      const c = candles[i];
      if (c) {
        const x = xOf(i);
        ctx.strokeStyle = 'rgba(160,160,160,0.6)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, plotH);
        ctx.moveTo(0, hover.y);
        ctx.lineTo(plotW, hover.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const valAtY = min + ((plotH - hover.y) / plotH) * (max - min);
        pill(ctx, plotW + 4, hover.y, `${trimNum(valAtY)}%`, 'rgba(120,120,120,0.9)', '#fff');
        const label = `${fmtFull(c.ts)}  ${formatPct(c.close)}  [${trimNum(c.low)}…${trimNum(c.high)}]  ${exName(c.exA)}→${exName(c.exB)}`;
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = 'rgba(20,20,20,0.85)';
        roundRect(ctx, 8, 8, Math.min(tw, plotW - 16), 22, 6);
        ctx.fill();
        ctx.fillStyle = '#e5e5e5';
        ctx.fillText(label, 14, 19, plotW - 28);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, size, yRange, visible, hover, tf, viewRef.current.right, viewRef.current.px]);

  // ---------------------------------------------------------------- жесты
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let last: { x: number; y: number } | null = null;
    let pinch: { dist: number; px: number; dy: number; y: { min: number; max: number } } | null =
      null;

    const pos = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const clampRight = () => {
      const v = viewRef.current;
      const count = plotW / v.px;
      v.right = Math.min(candles.length - 1 + count * 0.3, Math.max(count * 0.5, v.right));
      followRef.current = v.right >= candles.length - 1;
    };

    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, pos(e));
      last = pos(e);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const v = viewRef.current;
        pinch = {
          dist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
          px: v.px,
          dy: Math.abs(a!.y - b!.y),
          y: v.y ?? yRange,
        };
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = pos(e);
      if (!pointers.has(e.pointerId)) {
        setHover(p);
        return;
      }
      pointers.set(e.pointerId, p);
      const v = viewRef.current;
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const dx = Math.abs(a!.x - b!.x);
        const dy = Math.abs(a!.y - b!.y);
        if (dx >= dy) {
          v.px = Math.min(MAX_PX, Math.max(MIN_PX, (pinch.px * dist) / pinch.dist));
        } else {
          const k = pinch.dy / Math.max(1, dy);
          const mid = (pinch.y.min + pinch.y.max) / 2;
          const half = ((pinch.y.max - pinch.y.min) / 2) * k;
          v.y = { min: mid - half, max: mid + half };
        }
        clampRight();
        redraw();
        return;
      }
      if (last) {
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        v.right -= dx / v.px;
        if (Math.abs(dy) > 0) {
          const range = v.y ?? yRange;
          const shift = (dy / plotH) * (range.max - range.min);
          v.y = { min: range.min + shift, max: range.max + shift };
        }
        clampRight();
        last = p;
        setHover(null);
        redraw();
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      last = pointers.size ? [...pointers.values()][0]! : null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const p = { x: e.offsetX, y: e.offsetY };
      if (e.shiftKey || e.ctrlKey) {
        const range = v.y ?? yRange;
        const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        const at = range.min + ((plotH - p.y) / plotH) * (range.max - range.min);
        v.y = { min: at - (at - range.min) * k, max: at + (range.max - at) * k };
      } else {
        const idxAt = v.right - (plotW - p.x) / v.px;
        const k = e.deltaY > 0 ? 1 / 1.15 : 1.15;
        v.px = Math.min(MAX_PX, Math.max(MIN_PX, v.px * k));
        v.right = idxAt + (plotW - p.x) / v.px;
        clampRight();
      }
      redraw();
    };
    const onLeave = () => setHover(null);
    const onDbl = () => {
      const v = viewRef.current;
      v.y = null;
      v.right = candles.length - 1;
      followRef.current = true;
      redraw();
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDbl);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDbl);
    };
  }, [candles.length, plotW, plotH, yRange, redraw]);

  const jumpToNow = () => {
    haptic('tap');
    const v = viewRef.current;
    v.right = candles.length - 1;
    v.y = null;
    followRef.current = true;
    redraw();
  };

  const last = candles[candles.length - 1];
  const stats = useMemo(() => {
    if (candles.length === 0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    for (const c of candles) {
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
      sum += c.close;
    }
    return { lo, hi, avg: sum / candles.length };
  }, [candles]);

  return (
    <div className="fullchart">
      <div className="fullchart__bar">
        <div className="segmented segmented--mini">
          {tfs.map((k) => (
            <button
              key={k}
              type="button"
              className={`segmented__item${tf === k ? ' segmented__item--active' : ''}`}
              onClick={() => setTf(k)}
            >
              {t(`fullchart.tf_${k}`)}
            </button>
          ))}
        </div>
        <span className="fullchart__pair">
          {pair ? `${exName(pair.exA)} ↔ ${exName(pair.exB)}` : t('chart.bestPair')}
        </span>
        <button
          type="button"
          className="icon-btn-round fullchart__jump"
          aria-label={t('fullchart.toNow')}
          onClick={jumpToNow}
        >
          <ChevronRightIcon size={18} />
        </button>
      </div>

      <div className="fullchart__plot" ref={wrapRef}>
        <canvas ref={canvasRef} style={{ width: size.w, height: size.h, touchAction: 'none' }} />
        {last && <div className="fullchart__now num">{formatPct(last.close)}</div>}
        {error && <div className="fullchart__empty">{t('chart.unavailable')}</div>}
        {!error && candles.length === 0 && (
          <div className="fullchart__empty">{t('app.loading')}</div>
        )}
      </div>

      <div className="fullchart__foot num">
        {stats && (
          <>
            {t('fullchart.points', { count: candles.length })} · {t('chart.last')}{' '}
            {formatPct(last!.close)} · {t('fullchart.avg')} {formatPct(stats.avg)} ·{' '}
            {t('fullchart.peaks')} {trimNum(stats.lo)}…{trimNum(stats.hi)}%
          </>
        )}
      </div>
      <p className="hint">{t('fullchart.hint')}</p>
    </div>
  );
}

/** Из часовых свечей — дневные (по местным суткам). */
function aggregateDaily(rows: HistoryCandle[]): HistoryCandle[] {
  const out = new Map<number, HistoryCandle>();
  for (const c of rows) {
    const d = new Date(c.ts);
    const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const cur = out.get(key);
    if (!cur) out.set(key, { ...c, ts: key });
    else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.samples += c.samples;
      if (c.source === 'live') cur.source = 'live';
    }
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const m = raw / p;
  const n = m >= 5 ? 5 : m >= 2 ? 2 : 1;
  return n * p;
}

function trimNum(v: number): string {
  const a = Math.abs(v);
  const d = a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return v.toFixed(d).replace(/\.?0+$/, '');
}

function fmtAxis(ts: number, tf: Tf): string {
  const d = new Date(ts);
  if (tf === '1d' || tf === '1h') {
    return (
      d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) +
      (tf === '1h' ? ` ${d.getHours()}:00` : '')
    );
  }
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function fmtFull(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

function pill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  bg: string,
  fg: string,
): void {
  ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = bg;
  roundRect(ctx, x, y - 9, w, 18, 5);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.fillText(text, x + 5, y + 0.5);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
