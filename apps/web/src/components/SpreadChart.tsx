/**
 * Живой график спреда на экране монеты.
 *
 * Canvas без библиотек. Таймфреймы 1с · 1м · 15м · 1ч · 1д: на «1с» —
 * линия по посекундному буферу сервера, на остальных — свечи. Ось X —
 * по времени (дыры в данных видны как пустое место), ось Y — симметрична
 * относительно нуля, пока пользователь не сдвинул или не растянул её сам
 * («⟲» возвращает автоподбор). Тянуть можно в любую сторону, колесо —
 * масштаб по времени (Shift/Ctrl — по вертикали), два пальца — щипок.
 * Правый край следует за живыми данными, пока его не увели в прошлое;
 * «→» возвращает к текущему моменту. Прокрутка влево до начала
 * загруженного — догружает историю.
 */
import { EXCHANGES, formatPct, type ExchangeId } from '@cs/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChevronRightIcon } from '../icons';
import { api, type HistoryCandle, type HistoryResponse, type HistoryTf } from '../lib/api';
import { haptic } from '../lib/telegram';

export type ChartPair = { exA: ExchangeId; exB: ExchangeId };

type Tf = Exclude<HistoryTf, '5m'>;
const TFS: Tf[] = ['1s', '1m', '15m', '1h', '1d'];
const TF_MS: Record<Tf, number> = {
  '1s': 1000,
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};
/** Сколько истории грузим сразу и по одному «шагу назад». */
const CHUNK_MS: Record<Tf, number> = {
  '1s': 15 * 60_000,
  '1m': 6 * 3_600_000,
  '15m': 3 * 86_400_000,
  '1h': 14 * 86_400_000,
  '1d': 180 * 86_400_000,
};
/** Глубже этого истории не бывает (буфер «1с» — 8 часов). */
const MAX_BACK_MS: Record<Tf, number> = {
  '1s': 8 * 3_600_000,
  '1m': 40 * 86_400_000,
  '15m': 400 * 86_400_000,
  '1h': 400 * 86_400_000,
  '1d': 730 * 86_400_000,
};
/** Сколько баров видно при открытии. */
const INITIAL_BARS: Record<Tf, number> = { '1s': 300, '1m': 45, '15m': 45, '1h': 45, '1d': 40 };
const REFRESH_MS: Record<Tf, number> = { '1s': 1000, '1m': 5000, '15m': 5000, '1h': 5000, '1d': 5000 };

const HEIGHT = 300;
const AXIS_W = 54;
const AXIS_H = 20;
const MAX_PX = 80;

interface View {
  /** Время у правого края области, мс. */
  rightTs: number;
  /** Пикселей на бар. */
  px: number;
  /** Ручная шкала Y; null — симметрично вокруг нуля по видимым данным. */
  y: { min: number; max: number } | null;
}

function samePair(a: ChartPair | null, b: ChartPair | null): boolean {
  if (!a || !b) return a === b;
  return (a.exA === b.exA && a.exB === b.exB) || (a.exA === b.exB && a.exB === b.exA);
}

/** Посекундную серию разворачиваем в точки того же вида, что и свечи. */
function toPoints(r: HistoryResponse): HistoryCandle[] {
  if (r.tf !== '1s') return r.candles;
  const s = r.series;
  if (!s) return [];
  const out: HistoryCandle[] = [];
  for (let i = 0; i < s.values.length; i++) {
    const v = s.values[i];
    if (v === null || v === undefined) continue;
    const idx = s.pairIdx?.[i];
    const p = idx !== null && idx !== undefined ? s.pairs?.[idx] : undefined;
    out.push({
      ts: s.ts0 + i * s.stepMs,
      base: r.base,
      exA: p?.exA ?? r.exA ?? EXCHANGES[0]!.id,
      exB: p?.exB ?? r.exB ?? EXCHANGES[0]!.id,
      open: v,
      high: v,
      low: v,
      close: v,
      samples: 1,
      source: 'live',
    });
  }
  return out;
}

export function SpreadChart({
  base,
  pairs = [],
  currentPair = null,
}: {
  base: string;
  /** Сверенные пары монеты — для сравнения бирж. */
  pairs?: ChartPair[];
  /** Пара из таблицы (лучшая сейчас) — открывается первой. */
  currentPair?: ChartPair | null;
}) {
  const { t } = useTranslation();
  const [tfState, setTf] = useState<Tf>('1m');
  // null — «лучшая пара монеты» (история по монете), иначе — конкретная пара.
  const [pair, setPair] = useState<ChartPair | null>(currentPair);
  const [pairTouched, setPairTouched] = useState(false);
  useEffect(() => {
    // Пока пользователь не выбирал сам, следуем за парой из таблицы.
    if (!pairTouched && currentPair && !samePair(pair, currentPair)) setPair(currentPair);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPair?.exA, currentPair?.exB]);
  // Без списка сверенных пар (например, монета с одной парой) — история по монете.
  const effPair = pairs.length > 0 ? pair : null;
  const pairKeyStr = effPair ? `${effPair.exA}|${effPair.exB}` : '';
  // По паре бирж минутных свечей нет — только 1с, 15м, 1ч, 1д.
  const tfs = effPair ? TFS.filter((k) => k !== '1m') : TFS;
  const tf: Tf = effPair && tfState === '1m' ? '15m' : tfState;
  const exName = (id: string) => EXCHANGES.find((e) => e.id === id)?.name ?? id;

  const [points, setPoints] = useState<HistoryCandle[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const storeRef = useRef(new Map<number, HistoryCandle>());
  const loadedFromRef = useRef<number | null>(null);
  const olderRef = useRef<{ busy: boolean; exhausted: boolean }>({ busy: false, exhausted: false });

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(340);
  const viewRef = useRef<View>({ rightTs: Date.now(), px: 6, y: null });
  const followRef = useRef(true);
  const [, force] = useState(0);
  const redraw = useCallback(() => force((n) => n + 1), []);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [manualY, setManualY] = useState(false);

  const tfMs = TF_MS[tf];
  const plotW = Math.max(60, width - AXIS_W);
  const plotH = HEIGHT - AXIS_H;

  // Размер под контейнер.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.getBoundingClientRect().width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const merge = useCallback((rows: HistoryCandle[]) => {
    const store = storeRef.current;
    for (const c of rows) store.set(c.ts, c);
    const arr = [...store.values()].sort((a, b) => a.ts - b.ts);
    setPoints(arr);
    return arr;
  }, []);

  // Данные: сброс при смене монеты/таймфрейма/пары, первая загрузка, живой хвост.
  useEffect(() => {
    let alive = true;
    storeRef.current = new Map();
    loadedFromRef.current = null;
    olderRef.current = { busy: false, exhausted: false };
    setPoints([]);
    setStatus('loading');
    setHover(null);
    followRef.current = true;
    setManualY(false);
    viewRef.current = {
      rightTs: Date.now(),
      px: Math.min(MAX_PX, Math.max(minPx(tf), plotW / INITIAL_BARS[tf])),
      y: null,
    };

    const load = () => {
      if (document.hidden) return;
      const to = Date.now();
      const store = storeRef.current;
      let lastTs = -1;
      for (const ts of store.keys()) if (ts > lastTs) lastTs = ts;
      const initial = loadedFromRef.current === null;
      const from = initial ? to - CHUNK_MS[tf] : Math.max(lastTs - 2 * tfMs, to - CHUNK_MS[tf]);
      api
        .history(base, tf, from, to, effPair ?? undefined)
        .then((r) => {
          if (!alive) return;
          if (initial) loadedFromRef.current = from;
          const arr = merge(toPoints(r));
          setStatus('ok');
          const v = viewRef.current;
          if (followRef.current && arr.length > 0) v.rightTs = arr[arr.length - 1]!.ts + 3 * tfMs;
        })
        .catch(() => alive && storeRef.current.size === 0 && setStatus('error'));
    };
    load();
    const timer = setInterval(load, REFRESH_MS[tf]);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, tf, pairKeyStr]);

  /** Догрузить кусок истории левее загруженного (когда докрутили до края). */
  const loadOlder = useCallback(() => {
    const st = olderRef.current;
    const from0 = loadedFromRef.current;
    if (st.busy || st.exhausted || from0 === null) return;
    const to = from0;
    const from = Math.max(to - CHUNK_MS[tf], Date.now() - MAX_BACK_MS[tf]);
    if (to - from < tfMs) {
      st.exhausted = true;
      return;
    }
    st.busy = true;
    api
      .history(base, tf, from, to, effPair ?? undefined)
      .then((r) => {
        loadedFromRef.current = from;
        const rows = toPoints(r);
        if (rows.length === 0 && from <= Date.now() - MAX_BACK_MS[tf] + tfMs) st.exhausted = true;
        merge(rows);
      })
      .catch(() => {})
      .finally(() => {
        st.busy = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, tf, pairKeyStr, merge]);

  // ---------------------------------------------------------------- геометрия
  const v = viewRef.current;
  const spanMs = (plotW / v.px) * tfMs;
  const leftTs = v.rightTs - spanMs;

  const visible = useMemo(() => {
    const first = lowerBound(points, leftTs - tfMs);
    let last = lowerBound(points, v.rightTs) - 1;
    if (last >= points.length) last = points.length - 1;
    return { first, last };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, leftTs, v.rightTs, tfMs]);

  // Шкала Y: симметрично вокруг нуля по видимым точкам, либо ручная.
  const yRange = useMemo(() => {
    if (v.y) return v.y;
    let m = 0;
    for (let i = visible.first; i <= visible.last; i++) {
      const c = points[i];
      if (!c) continue;
      m = Math.max(m, Math.abs(c.low), Math.abs(c.high));
    }
    if (m === 0) {
      const last = points[points.length - 1];
      m = last ? Math.max(Math.abs(last.low), Math.abs(last.high)) : 0;
    }
    const half = Math.max(m * 1.15, 0.05);
    return { min: -half, max: half };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, visible, v.y]);

  // ---------------------------------------------------------------- отрисовка
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const colText = css.getPropertyValue('--text-mute').trim() || '#6e6e71';
    const colGrid = 'rgba(128,128,128,0.14)';
    const colPos = css.getPropertyValue('--positive').trim() || '#4ade80';
    const colNeg = css.getPropertyValue('--negative').trim() || '#f87171';
    const colBrand = css.getPropertyValue('--brand').trim() || colPos;
    const colLine = css.getPropertyValue('--green').trim() || colBrand;
    const isLight = css.getPropertyValue('color-scheme').trim() === 'light';
    const colZero = isLight ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.7)';

    ctx.clearRect(0, 0, width, HEIGHT);
    const { min, max } = yRange;
    const yOf = (val: number) => plotH - ((val - min) / (max - min)) * plotH;
    const xOf = (ts: number) => plotW - ((v.rightTs - ts) / tfMs) * v.px;
    const mono = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

    // Сетка и шкала Y.
    ctx.font = mono;
    ctx.textBaseline = 'middle';
    const step = niceStep((max - min) / 5);
    for (let val = Math.ceil(min / step) * step; val <= max; val += step) {
      const y = yOf(val);
      if (Math.abs(val) < step / 2) continue; // ноль рисуем отдельно
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
      ctx.strokeStyle = colZero;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(plotW, y0);
      ctx.stroke();
      pill(ctx, plotW + 4, y0, '0%', colZero, isLight ? '#fff' : '#111');
    }

    // Подписи X: круглые отметки времени, не чаще одной на ~80px.
    const labelStep = niceTimeStep((80 / v.px) * tfMs);
    const tzShift = new Date().getTimezoneOffset() * 60_000;
    ctx.textAlign = 'center';
    const firstLabel = Math.ceil((leftTs - tzShift) / labelStep) * labelStep + tzShift;
    for (let ts = firstLabel; ts <= v.rightTs; ts += labelStep) {
      const x = xOf(ts);
      if (x < 0 || x > plotW) continue;
      ctx.strokeStyle = colGrid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.fillStyle = colText;
      ctx.font = mono;
      ctx.fillText(fmtAxis(ts, labelStep), x, plotH + AXIS_H / 2 + 1);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();

    if (tf === '1s') {
      // Линия с заливкой до нуля; разрыв там, где данных не было дольше
      // нескольких секунд (одиночные пропуски тика — не дыра).
      const GAP_MS = 5000;
      const y0 = yOf(Math.max(min, Math.min(max, 0)));
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      let run: { x: number; y: number }[] = [];
      const flush = () => {
        if (run.length === 0) return;
        ctx.fillStyle = colLine;
        ctx.globalAlpha = 0.12;
        ctx.beginPath();
        ctx.moveTo(run[0]!.x, y0);
        for (const p of run) ctx.lineTo(p.x, p.y);
        ctx.lineTo(run[run.length - 1]!.x, y0);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colLine;
        ctx.beginPath();
        run.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
        run = [];
      };
      let prevTs = -1;
      for (let i = Math.max(0, visible.first - 1); i <= Math.min(points.length - 1, visible.last + 1); i++) {
        const c = points[i]!;
        if (prevTs >= 0 && c.ts - prevTs > GAP_MS) flush();
        run.push({ x: xOf(c.ts), y: yOf(c.close) });
        prevTs = c.ts;
      }
      flush();
    } else {
      // Свечи: тело open–close, тени low–high; при мелком масштабе (тело
      // уже 3px) — только тонкая черта, иначе получается частокол.
      const bodyW = Math.max(1, Math.floor(v.px * 0.7));
      const thin = bodyW < 2;
      const wick = thin ? 1 : Math.max(1, Math.min(1.5, v.px * 0.12));
      for (let i = visible.first; i <= visible.last; i++) {
        const c = points[i];
        if (!c) continue;
        const x = Math.round(xOf(c.ts) + v.px / 2);
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
    }

    // Текущее значение: пунктир и метка.
    const lastC = points[points.length - 1];
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
      }
    }

    // Перекрестие.
    if (hover) {
      const ts = v.rightTs - ((plotW - hover.x) / v.px) * tfMs;
      const i = nearest(points, ts, tf === '1s' ? 0 : tfMs);
      const c = i >= 0 ? points[i] : undefined;
      if (c && Math.abs(c.ts + (tf === '1s' ? 0 : tfMs / 2) - ts) <= Math.max(tfMs, (6 / v.px) * tfMs)) {
        const x = tf === '1s' ? xOf(c.ts) : Math.round(xOf(c.ts) + v.px / 2);
        ctx.strokeStyle = 'rgba(160,160,160,0.6)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, plotH);
        ctx.moveTo(0, hover.y);
        ctx.lineTo(plotW, hover.y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (tf === '1s') {
          ctx.fillStyle = colLine;
          ctx.beginPath();
          ctx.arc(x, yOf(c.close), 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
        const label =
          tf === '1s'
            ? `${fmtFull(c.ts, true)}  ${formatPct(c.close)}  ${exName(c.exA)}→${exName(c.exB)}`
            : `${fmtFull(c.ts, false)}  ${formatPct(c.close)}  [${trimNum(c.low)}…${trimNum(c.high)}]  ${exName(c.exA)}→${exName(c.exB)}${c.source === 'reconstructed' ? ' ≈' : ''}`;
        ctx.font = mono;
        ctx.textAlign = 'left';
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = isLight ? 'rgba(255,255,255,0.92)' : 'rgba(20,20,20,0.88)';
        roundRect(ctx, 8, 8, Math.min(tw, plotW - 16), 22, 6);
        ctx.fill();
        ctx.fillStyle = isLight ? '#111' : '#e5e5e5';
        ctx.fillText(label, 14, 19, plotW - 28);
      }
    }
    ctx.restore();

    // Метки на шкале поверх сетки: текущее значение и значение под курсором.
    if (lastC) {
      const y = yOf(lastC.close);
      if (y >= -9 && y <= plotH + 9) pill(ctx, plotW + 4, y, formatPct(lastC.close), colBrand, '#06130c');
    }
    if (hover) {
      const valAtY = min + ((plotH - hover.y) / plotH) * (max - min);
      pill(ctx, plotW + 4, hover.y, `${trimNum(valAtY)}%`, 'rgba(120,120,120,0.9)', '#fff');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width, yRange, visible, hover, tf, v.rightTs, v.px]);

  // ---------------------------------------------------------------- жесты
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let last: { x: number; y: number } | null = null;
    let moved = false;
    let pinch: { dist: number; px: number; dy: number; y: { min: number; max: number } } | null =
      null;

    const pos = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const lastTs = () => (points.length ? points[points.length - 1]!.ts : Date.now());
    const clamp = () => {
      const vv = viewRef.current;
      const span = (plotW / vv.px) * tfMs;
      const maxRight = lastTs() + span * 0.6;
      const oldest = Math.min(loadedFromRef.current ?? Infinity, points[0]?.ts ?? Infinity);
      const minRight = (Number.isFinite(oldest) ? oldest : lastTs()) + span * 0.25;
      vv.rightTs = Math.min(maxRight, Math.max(Math.min(minRight, maxRight), vv.rightTs));
      followRef.current = vv.rightTs >= lastTs() + tfMs;
      // Дотянули до начала загруженного — грузим ещё.
      if (vv.rightTs - span < oldest + span * 0.5) loadOlder();
    };
    const setY = (y: { min: number; max: number } | null) => {
      viewRef.current.y = y;
      setManualY(y !== null);
    };

    const onDown = (e: PointerEvent) => {
      // Иначе браузер начинает выделять текст вокруг графика при перетаскивании.
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, pos(e));
      last = pos(e);
      moved = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const vv = viewRef.current;
        pinch = {
          dist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
          px: vv.px,
          dy: Math.abs(a!.y - b!.y),
          y: vv.y ?? yRange,
        };
        setHover(null);
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = pos(e);
      if (!pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') setHover(p);
        return;
      }
      pointers.set(e.pointerId, p);
      const vv = viewRef.current;
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const dx = Math.abs(a!.x - b!.x);
        const dy = Math.abs(a!.y - b!.y);
        if (dx >= dy) {
          const mid = (a!.x + b!.x) / 2;
          const tsAt = vv.rightTs - ((plotW - mid) / vv.px) * tfMs;
          vv.px = Math.min(MAX_PX, Math.max(minPx(tf), (pinch.px * dist) / pinch.dist));
          vv.rightTs = tsAt + ((plotW - mid) / vv.px) * tfMs;
        } else {
          const k = pinch.dy / Math.max(1, dy);
          const mid = (pinch.y.min + pinch.y.max) / 2;
          const half = ((pinch.y.max - pinch.y.min) / 2) * k;
          setY({ min: mid - half, max: mid + half });
        }
        clamp();
        redraw();
        return;
      }
      if (last) {
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        if (!moved && Math.hypot(dx, dy) < 3) return;
        moved = true;
        vv.rightTs -= (dx / vv.px) * tfMs;
        if (dy !== 0) {
          const range = vv.y ?? yRange;
          const shift = (dy / plotH) * (range.max - range.min);
          setY({ min: range.min + shift, max: range.max + shift });
        }
        clamp();
        last = p;
        setHover(null);
        redraw();
      }
    };
    const onUp = (e: PointerEvent) => {
      const p = pos(e);
      const wasTap = pointers.size === 1 && !moved && e.pointerType !== 'mouse';
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      last = pointers.size ? [...pointers.values()][0]! : null;
      // Короткое касание на телефоне — показать точку под пальцем.
      if (wasTap) setHover((h) => (h && Math.hypot(h.x - p.x, h.y - p.y) < 12 ? null : p));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vv = viewRef.current;
      const p = { x: e.offsetX, y: e.offsetY };
      if (e.shiftKey || e.ctrlKey) {
        const range = vv.y ?? yRange;
        const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        const at = range.min + ((plotH - p.y) / plotH) * (range.max - range.min);
        setY({ min: at - (at - range.min) * k, max: at + (range.max - at) * k });
      } else {
        const tsAt = vv.rightTs - ((plotW - p.x) / vv.px) * tfMs;
        const k = e.deltaY > 0 ? 1 / 1.15 : 1.15;
        vv.px = Math.min(MAX_PX, Math.max(minPx(tf), vv.px * k));
        vv.rightTs = tsAt + ((plotW - p.x) / vv.px) * tfMs;
        clamp();
      }
      redraw();
    };
    const onLeave = () => setHover(null);
    const onDbl = () => {
      const vv = viewRef.current;
      setY(null);
      vv.rightTs = lastTs() + 3 * tfMs;
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
  }, [points, plotW, plotH, yRange, redraw, tf, tfMs, loadOlder]);

  const jumpToNow = () => {
    haptic('tap');
    const vv = viewRef.current;
    vv.rightTs = (points.length ? points[points.length - 1]!.ts : Date.now()) + 3 * tfMs;
    followRef.current = true;
    redraw();
  };
  const resetY = () => {
    haptic('tap');
    viewRef.current.y = null;
    setManualY(false);
    redraw();
  };

  const last = points[points.length - 1];
  const stats = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = visible.first; i <= visible.last; i++) {
      const c = points[i];
      if (!c) continue;
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
    }
    return Number.isFinite(lo) ? { lo, hi } : null;
  }, [points, visible]);
  const hasReconstructed = useMemo(() => points.some((c) => c.source === 'reconstructed'), [points]);

  return (
    <section className="card chart">
      <div className="chart__head">
        <span className="chart__title">{t('chart.title')}</span>
        <div className="segmented segmented--mini">
          {tfs.map((k) => (
            <button
              key={k}
              type="button"
              className={`segmented__item${tf === k ? ' segmented__item--active' : ''}`}
              onClick={() => {
                haptic('tap');
                setTf(k);
              }}
            >
              {t(`chart.tf_${k}`)}
            </button>
          ))}
        </div>
      </div>
      {pairs.length > 0 && (
        <div className="chart__pairs">
          <button
            type="button"
            className={`chip-mini chip-mini--tap${effPair === null ? ' chip-mini--on' : ''}`}
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
              className={`chip-mini chip-mini--tap${samePair(effPair, p) ? ' chip-mini--on' : ''}`}
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

      <div className="chart__canvas" ref={wrapRef}>
        <canvas ref={canvasRef} style={{ width, height: HEIGHT, touchAction: 'none' }} />
        {status === 'error' && points.length === 0 && (
          <div className="chart__overlay">{t('chart.unavailable')}</div>
        )}
        {status === 'loading' && points.length === 0 && (
          <div className="chart__overlay">{t('app.loading')}</div>
        )}
        {status === 'ok' && points.length === 0 && (
          <div className="chart__overlay">{tf === '1s' ? t('chart.noSeconds') : t('chart.noData')}</div>
        )}
        <div className="chart__tools">
          {manualY && (
            <button
              type="button"
              className="icon-btn-round chart__tool"
              aria-label={t('chart.autoScale')}
              onClick={resetY}
            >
              ⟲
            </button>
          )}
          {!followRef.current && (
            <button
              type="button"
              className="icon-btn-round chart__tool"
              aria-label={t('chart.toNow')}
              onClick={jumpToNow}
            >
              <ChevronRightIcon size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="chart__legend num">
        {stats ? (
          <>
            <span>
              {t('chart.min')} {formatPct(stats.lo)}
            </span>
            <span>
              {t('chart.max')} {formatPct(stats.hi)}
            </span>
          </>
        ) : (
          <span />
        )}
        {last && (
          <span>
            {t('chart.last')} {formatPct(last.close)}
          </span>
        )}
      </div>
      {hasReconstructed && <div className="chart__note">{t('chart.reconstructed')}</div>}
      <div className="chart__note">{t('chart.hint')}</div>
    </section>
  );
}

// ---------------------------------------------------------------- утилиты

function minPx(tf: Tf): number {
  return tf === '1s' ? 0.04 : 1.5;
}

/** Первый индекс с ts ≥ значения (массив отсортирован по ts). */
function lowerBound(arr: HistoryCandle[], ts: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Ближайшая точка ко времени (для свечей — по середине бара). */
function nearest(arr: HistoryCandle[], ts: number, halfMs: number): number {
  if (arr.length === 0) return -1;
  const target = ts - halfMs / 2;
  const i = lowerBound(arr, target);
  if (i <= 0) return 0;
  if (i >= arr.length) return arr.length - 1;
  return Math.abs(arr[i]!.ts - target) < Math.abs(arr[i - 1]!.ts - target) ? i : i - 1;
}

const TIME_STEPS = [
  1000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000, 172_800_000,
  604_800_000, 1_209_600_000, 2_592_000_000,
];

function niceTimeStep(minMs: number): number {
  for (const s of TIME_STEPS) if (s >= minMs) return s;
  return TIME_STEPS[TIME_STEPS.length - 1]!;
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

function fmtAxis(ts: number, stepMs: number): string {
  const d = new Date(ts);
  if (stepMs >= 86_400_000) return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  if (stepMs < 60_000) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  // Полночь подписываем датой, чтобы не терять день при прокрутке.
  if (d.getHours() === 0 && d.getMinutes() === 0 && stepMs >= 3_600_000) {
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }
  return time;
}

function fmtFull(ts: number, seconds: boolean): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString(
    'ru-RU',
    seconds
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' },
  )}`;
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
