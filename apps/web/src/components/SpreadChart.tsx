/**
 * Живой график спреда на экране монеты — на Lightweight Charts (TradingView).
 *
 * Таймфреймы 1с · 1м · 15м · 1ч · 1д: на «1с» — линия с заливкой от нуля
 * (посекундный спред из VictoriaMetrics), на остальных — свечи. Ноль —
 * всегда по центру, пока шкала в автоподборе; потянул шкалу цены — она
 * ручная, «⟲» возвращает авто. Тянуть график можно мышью и пальцем,
 * колесо/щипок — масштаб, шкалы тянутся отдельно. Правый край следует за
 * живыми данными, пока его не увели в прошлое — тогда появляется «→».
 * Прокрутка влево до начала загруженного — догружает историю.
 *
 * График всегда по конкретной паре бирж: открывается на той, что сейчас
 * лучшая в таблице, дальше пару выбирает пользователь — за таблицей график
 * не бегает (иначе он сбрасывался при каждой смене лучшей пары).
 */
import { EXCHANGES, formatPct, type ExchangeId } from '@cs/shared';
import {
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type LogicalRange,
  type MouseEventParams,
  type SeriesDataItemTypeMap,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChevronRightIcon } from '../icons';
import { HelpTip } from './HelpTip';
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
/** Глубже этого истории не бывает (VictoriaMetrics хранит «1с» 7 дней). */
const MAX_BACK_MS: Record<Tf, number> = {
  '1s': 7 * 86_400_000,
  '1m': 40 * 86_400_000,
  '15m': 400 * 86_400_000,
  '1h': 400 * 86_400_000,
  '1d': 730 * 86_400_000,
};
/** Сколько баров видно при открытии. */
const INITIAL_BARS: Record<Tf, number> = { '1s': 240, '1m': 45, '15m': 45, '1h': 45, '1d': 40 };
const REFRESH_MS: Record<Tf, number> = { '1s': 1000, '1m': 5000, '15m': 5000, '1h': 5000, '1d': 5000 };
/** Пропуск данных длиннее этого — видимый разрыв на графике. */
const GAP_BARS = 5;
const HEIGHT = 250;
const RIGHT_OFFSET = 3;

type Store = Map<number, HistoryCandle>;

function pairKeyStrOf(p: ChartPair | null): string {
  return p ? `${p.exA}|${p.exB}` : '';
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

const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

type CandleItem = SeriesDataItemTypeMap<Time>['Candlestick'];
type LineItem = SeriesDataItemTypeMap<Time>['Baseline'];

/**
 * Точки → данные серии. Библиотека рисует бары подряд без учёта времени,
 * поэтому длинные паузы обозначаем пустыми барами (whitespace) — до пяти
 * штук, чтобы дыра была видна, но не растягивала график на километр.
 */
function seriesData(
  points: HistoryCandle[],
  tf: Tf,
  colors: { up: string; down: string; upDim: string; downDim: string },
): (CandleItem | LineItem)[] {
  const tfMs = TF_MS[tf];
  const out: (CandleItem | LineItem)[] = [];
  let prev = -1;
  for (const c of points) {
    if (prev >= 0 && c.ts - prev > GAP_BARS * tfMs) {
      const n = Math.min(5, Math.floor((c.ts - prev) / tfMs) - 1);
      const step = (c.ts - prev) / (n + 1);
      for (let k = 1; k <= n; k++) {
        const t = sec(prev + step * k);
        if (t > sec(prev) && t < sec(c.ts)) out.push({ time: t });
      }
    }
    prev = c.ts;
    if (tf === '1s') {
      out.push({ time: sec(c.ts), value: c.close });
    } else {
      const dim = c.source === 'reconstructed';
      const up = c.close >= c.open;
      const col = dim ? (up ? colors.upDim : colors.downDim) : up ? colors.up : colors.down;
      out.push({
        time: sec(c.ts),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        color: col,
        wickColor: col,
      });
    }
  }
  return out;
}

export function SpreadChart({
  base,
  pairs = [],
  currentPair = null,
  pair: pickedProp,
  onPairChange,
}: {
  base: string;
  /** Сверенные пары монеты — для сравнения бирж. */
  pairs?: ChartPair[];
  /** Лучшая пара сейчас — с неё график открывается. */
  currentPair?: ChartPair | null;
  /** Выбранная пара (если родитель ведёт её сам — например, чтобы считать по ней стакан). */
  pair?: ChartPair | null;
  onPairChange?: (pair: ChartPair) => void;
}) {
  const { t } = useTranslation();
  const [tf, setTf] = useState<Tf>('1m');
  const [pickedState, setPickedState] = useState<ChartPair | null>(null);
  const picked = pickedProp !== undefined ? pickedProp : pickedState;
  const setPicked = (p: ChartPair) => {
    setPickedState(p);
    onPairChange?.(p);
  };
  // Выбранная пользователем пара, иначе — лучшая на момент открытия (фиксируем,
  // чтобы график не сбрасывался при каждой смене лучшей пары в таблице).
  const [initial] = useState<ChartPair | null>(currentPair);
  const known = (p: ChartPair | null) => (p && pairs.some((q) => samePair(q, p)) ? p : null);
  // Без сверенных пар — история по монете (лучшая пара).
  const effPair = pairs.length > 0 ? (known(picked) ?? known(initial) ?? pairs[0]!) : null;
  // Родителю нужна фактическая пара (в том числе стартовая), а не только выбранная рукой.
  useEffect(() => {
    if (effPair) onPairChange?.(effPair);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKeyStrOf(effPair)]);
  const pairKeyStr = effPair ? `${effPair.exA}|${effPair.exB}` : '';
  const tfs = TFS;
  const tfMs = TF_MS[tf];
  const exName = (id: string) => EXCHANGES.find((e) => e.id === id)?.name ?? id;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Baseline'> | null>(null);
  const zeroLineRef = useRef<IPriceLine | null>(null);
  const storeRef = useRef<Store>(new Map());
  const pointsRef = useRef<HistoryCandle[]>([]);
  /** Сколько баров в серии (точки + пустые бары-разрывы) — логические индексы библиотеки. */
  const barsRef = useRef(0);
  const loadedFromRef = useRef<number | null>(null);
  /** Первая порция загружена и вид выставлен — можно догружать историю. */
  const readyRef = useRef(false);
  const olderRef = useRef({ busy: false, exhausted: false });
  const colorsRef = useRef({ up: '#4ade80', down: '#f87171', upDim: '#4ade8080', downDim: '#f8717180' });

  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [count, setCount] = useState(0);
  const [atEnd, setAtEnd] = useState(true);
  const [manualY, setManualY] = useState(false);
  const [hover, setHover] = useState<HistoryCandle | null>(null);
  const [last, setLast] = useState<HistoryCandle | null>(null);
  const [stats, setStats] = useState<{ lo: number; hi: number } | null>(null);

  const refreshStats = useCallback(() => {
    const chart = chartRef.current;
    const pts = pointsRef.current;
    const range = chart?.timeScale().getVisibleRange();
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of pts) {
      if (range && (c.ts / 1000 < (range.from as number) || c.ts / 1000 > (range.to as number))) continue;
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
    }
    setStats(Number.isFinite(lo) ? { lo, hi } : null);
  }, []);

  // ---------------------------------------------------------------- график
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const v = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb;
    const up = v('--positive', '#4ade80');
    const down = v('--negative', '#f87171');
    colorsRef.current = { up, down, upDim: withAlpha(up, 0.45), downDim: withAlpha(down, 0.45) };
    const textMute = v('--text-mute', '#6e6e71');
    const isLight = css.getPropertyValue('color-scheme').trim() === 'light';

    const chart = createChart(el, {
      height: HEIGHT,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: textMute,
        fontSize: 11,
        fontFamily: v('--font-num', 'ui-monospace, Menlo, monospace'),
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(128,128,128,0.12)' },
        horzLines: { color: 'rgba(128,128,128,0.12)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { labelBackgroundColor: isLight ? '#333' : '#555' },
        horzLine: { labelBackgroundColor: isLight ? '#333' : '#555' },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderVisible: false,
        rightOffset: RIGHT_OFFSET,
        shiftVisibleRangeOnNewBar: true,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          const d = new Date((time as number) * 1000);
          if (type === TickMarkType.Year) return String(d.getFullYear());
          if (type === TickMarkType.Month) return d.toLocaleDateString('ru-RU', { month: 'short' });
          if (type === TickMarkType.DayOfMonth) return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
          if (type === TickMarkType.TimeWithSeconds) {
            return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          }
          return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        },
      },
      localization: {
        locale: 'ru-RU',
        priceFormatter: (p: number) => `${trimNum(p)}%`,
        timeFormatter: (time: Time) => fmtFull((time as number) * 1000, true),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      kineticScroll: { touch: true, mouse: false },
    });
    chartRef.current = chart;
    if (import.meta.env.DEV) (window as unknown as { __chart?: unknown }).__chart = { chart, barsRef };

    const onRange = (range: LogicalRange | null) => {
      if (!range) return;
      setManualY(!chart.priceScale('right').options().autoScale);
      // Дотянули до начала загруженного — грузим ещё (после первой загрузки,
      // иначе подгонка библиотекой под весь ряд утянет за собой полгода истории).
      if (range.from < 15 && readyRef.current) loadOlderRef.current();
      refreshStats();
      // «Мы в конце?» считаем следующим кадром: при новом баре событие приходит
      // до сдвига вида, и на секунду мигала бы кнопка «→».
      setTimeout(() => {
        const r = chart.timeScale().getVisibleLogicalRange();
        if (r) setAtEnd(r.to >= barsRef.current - 1 + RIGHT_OFFSET - 0.5);
      }, 50);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    const onCross = (p: MouseEventParams<Time>) => {
      if (!p.time || !p.point) {
        setHover(null);
        return;
      }
      const c = storeRef.current.get((p.time as number) * 1000);
      setHover(c ?? null);
    };
    chart.subscribeCrosshairMove(onCross);

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onCross);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [refreshStats]);

  // Серия под таймфрейм: линия на «1с», свечи на остальных.
  const ensureSeries = useCallback(
    (kind: '1s' | 'candles') => {
      const chart = chartRef.current;
      if (!chart) return null;
      const cur = seriesRef.current;
      if (cur && cur.seriesType() === (kind === '1s' ? 'Baseline' : 'Candlestick')) return cur;
      if (cur) chart.removeSeries(cur);
      const { up, down } = colorsRef.current;
      const common = {
        priceFormat: { type: 'custom' as const, minMove: 0.0001, formatter: (p: number) => `${trimNum(p)}%` },
        // Ноль по центру: шкала симметрична по видимым данным.
        autoscaleInfoProvider: (orig: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
          const r = orig();
          if (!r || !r.priceRange) return r;
          const m = Math.max(Math.abs(r.priceRange.minValue), Math.abs(r.priceRange.maxValue), 0.02);
          return { priceRange: { minValue: -m, maxValue: m } };
        },
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineStyle: LineStyle.Dotted,
      };
      const s =
        kind === '1s'
          ? chart.addSeries(BaselineSeries, {
              ...common,
              baseValue: { type: 'price', price: 0 },
              topLineColor: up,
              topFillColor1: withAlpha(up, 0.28),
              topFillColor2: withAlpha(up, 0.03),
              bottomLineColor: down,
              bottomFillColor1: withAlpha(down, 0.03),
              bottomFillColor2: withAlpha(down, 0.28),
              lineWidth: 2,
              priceLineColor: up,
            })
          : chart.addSeries(CandlestickSeries, {
              ...common,
              upColor: up,
              downColor: down,
              wickUpColor: up,
              wickDownColor: down,
              borderVisible: false,
              priceLineColor: up,
            });
      zeroLineRef.current = s.createPriceLine({
        price: 0,
        color: 'rgba(160,160,160,0.9)',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: '',
      });
      seriesRef.current = s;
      return s;
    },
    [],
  );

  const pushData = useCallback(
    (fresh: HistoryCandle[], mode: 'replace' | 'append') => {
      const s = ensureSeries(tf === '1s' ? '1s' : 'candles');
      if (!s) return;
      const pts = pointsRef.current;
      const data = seriesData(pts, tf, colorsRef.current);
      barsRef.current = data.length;
      if (mode === 'append' && fresh.length > 0 && fresh.length <= 50) {
        // Живой хвост: обновляем только новые бары, вид не дёргается.
        const firstNew = fresh[0]!.ts;
        const tail = data.filter((d) => (d.time as number) * 1000 >= firstNew);
        try {
          for (const d of tail) (s as ISeriesApi<'Candlestick'>).update(d as CandleItem);
          return;
        } catch {
          // Бар старше последнего — библиотека такое не принимает, кладём всё целиком.
        }
      }
      (s as ISeriesApi<'Candlestick'>).setData(data as CandleItem[]);
    },
    [ensureSeries, tf],
  );

  const merge = useCallback(
    (rows: HistoryCandle[], mode: 'replace' | 'append') => {
      const store = storeRef.current;
      const prevLast = pointsRef.current[pointsRef.current.length - 1]?.ts ?? -1;
      const fresh: HistoryCandle[] = [];
      for (const c of rows) {
        const had = store.get(c.ts);
        if (!had || had.close !== c.close || had.high !== c.high || had.low !== c.low) {
          store.set(c.ts, c);
          if (c.ts >= prevLast) fresh.push(c);
        }
      }
      const arr = [...store.values()].sort((a, b) => a.ts - b.ts);
      pointsRef.current = arr;
      setCount(arr.length);
      setLast(arr[arr.length - 1] ?? null);
      const onlyTail = fresh.length === rows.length || rows.every((c) => c.ts >= prevLast);
      pushData(fresh.sort((a, b) => a.ts - b.ts), mode === 'append' && onlyTail ? 'append' : 'replace');
      refreshStats();
    },
    [pushData, refreshStats],
  );

  // Данные: сброс при смене монеты/таймфрейма/пары, первая загрузка, живой хвост.
  useEffect(() => {
    let alive = true;
    storeRef.current = new Map();
    pointsRef.current = [];
    loadedFromRef.current = null;
    readyRef.current = false;
    olderRef.current = { busy: false, exhausted: false };
    setStatus('loading');
    setCount(0);
    setHover(null);
    setLast(null);
    const chart = chartRef.current;
    if (chart) {
      const s = ensureSeries(tf === '1s' ? '1s' : 'candles');
      s?.setData([]);
      chart.priceScale('right').applyOptions({ autoScale: true });
      setManualY(false);
    }

    const load = () => {
      if (document.hidden) return;
      const to = Date.now();
      const pts = pointsRef.current;
      const lastTs = pts.length ? pts[pts.length - 1]!.ts : -1;
      const initial = loadedFromRef.current === null;
      const from = initial ? to - CHUNK_MS[tf] : Math.max(lastTs - 2 * tfMs, to - CHUNK_MS[tf]);
      api
        .history(base, tf, from, to, effPair ?? undefined)
        .then((r) => {
          if (!alive) return;
          const rows = toPoints(r);
          merge(rows, initial ? 'replace' : 'append');
          if (initial) {
            loadedFromRef.current = from;
            const c = chartRef.current;
            if (c && rows.length > 0) {
              // Библиотека при первых данных подгоняет вид сама — ставим свой
              // масштаб следующим кадром, когда её раскладка уже отработала.
              const n = barsRef.current;
              const apply = () => {
                c.timeScale().setVisibleLogicalRange({
                  from: Math.max(0, n - INITIAL_BARS[tf]),
                  to: n - 1 + RIGHT_OFFSET,
                });
                readyRef.current = true;
              };
              apply();
              requestAnimationFrame(apply);
            } else {
              readyRef.current = true;
            }
          }
          setStatus('ok');
        })
        .catch(() => alive && pointsRef.current.length === 0 && setStatus('error'));
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
  const loadOlderRef = useRef<() => void>(() => {});
  loadOlderRef.current = () => {
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
        if (rows.length > 0) {
          // Сохраняем положение: библиотека считает бары от начала, а мы добавили слева.
          const chart = chartRef.current;
          const before = barsRef.current;
          const range = chart?.timeScale().getVisibleLogicalRange();
          merge(rows, 'replace');
          const added = barsRef.current - before;
          if (chart && range && added > 0) {
            chart.timeScale().setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        st.busy = false;
      });
  };

  const jumpToNow = () => {
    haptic('tap');
    chartRef.current?.timeScale().scrollToRealTime();
  };
  const resetY = () => {
    haptic('tap');
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
    setManualY(false);
  };

  const hasReconstructed = useMemo(
    () => pointsRef.current.some((c) => c.source === 'reconstructed'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [count],
  );

  return (
    <section className="card chart">
      <div className="chart__head">
        <span className="chart__title">
          {t('chart.title')}
          <HelpTip title={t('chart.title')} text={t('chart.hint')} />
        </span>
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
          {pairs.map((p) => (
            <button
              key={`${p.exA}|${p.exB}`}
              type="button"
              className={`chip-mini chip-mini--tap${samePair(effPair, p) ? ' chip-mini--on' : ''}`}
              onClick={() => {
                haptic('tap');
                setPicked(p);
              }}
            >
              {exName(p.exA)} ↔ {exName(p.exB)}
            </button>
          ))}
        </div>
      )}

      <div className="chart__canvas" style={{ height: HEIGHT }}>
        <div ref={wrapRef} className="chart__lw" />
        {hover && (
          <div className="chart__tip num">
            <span className="chart__tip-time">{fmtFull(hover.ts, tf === '1s')}</span>
            <b>{formatPct(hover.close)}</b>
            {tf !== '1s' && (
              <span>
                {trimNum(hover.low)}…{trimNum(hover.high)}%
              </span>
            )}
            <span>
              {exName(hover.exA)} → {exName(hover.exB)}
              {hover.source === 'reconstructed' ? ' ≈' : ''}
            </span>
          </div>
        )}
        {status === 'error' && count === 0 && <div className="chart__overlay">{t('chart.unavailable')}</div>}
        {status === 'loading' && count === 0 && <div className="chart__overlay">{t('app.loading')}</div>}
        {status === 'ok' && count === 0 && (
          <div className="chart__overlay">{tf === '1s' ? t('chart.noSeconds') : t('chart.noData')}</div>
        )}
        <div className="chart__tools">
          {manualY && (
            <button type="button" className="icon-btn-round chart__tool" aria-label={t('chart.autoScale')} onClick={resetY}>
              ⟲
            </button>
          )}
          {!atEnd && (
            <button type="button" className="icon-btn-round chart__tool" aria-label={t('chart.toNow')} onClick={jumpToNow}>
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
    </section>
  );
}

// ---------------------------------------------------------------- утилиты

function trimNum(v: number): string {
  const a = Math.abs(v);
  const d = a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return v.toFixed(d).replace(/\.?0+$/, '');
}

function fmtFull(ts: number, seconds: boolean): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString(
    'ru-RU',
    seconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' },
  )}`;
}

/** #rrggbb → rgba(); другие форматы возвращаем как есть. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
