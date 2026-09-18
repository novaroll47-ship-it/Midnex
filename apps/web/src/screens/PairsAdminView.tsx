/**
 * Сверка пар — экран администратора.
 *
 * Сверка идёт автоматически: цена, стандартный множитель, CoinGecko. Сюда
 * попадают только аномалии — пары, у которых отношение цен не похоже ни на
 * 1, ни на множитель контракта, либо внешний источник спорит с ценой.
 * По каждой: обе ноги с ценами, отношение, что сказал CoinGecko, кнопки
 * «Сверить» (множитель предзаполнен отношением) / «Отклонить».
 */
import { EXCHANGES, formatPrice, priceDecimals } from '@cs/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { CoinIcon } from '../components/CoinIcon';
import { ExchangeLogo } from '../components/ExchangeLogo';
import { api, type PairCounts, type PairView } from '../lib/api';
import { haptic } from '../lib/telegram';

type Tab = 'anomalies' | 'verified' | 'rejected';

export function PairsAdminView() {
  const { t } = useTranslation();
  const [pairs, setPairs] = useState<PairView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<PairCounts | null>(null);
  const [tab, setTab] = useState<Tab>('anomalies');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .adminPairs(tab)
      .then((r) => {
        setPairs(r.pairs);
        setTotal(r.total);
        setCounts(r.counts);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [tab]);
  useEffect(() => {
    setPairs(null);
    reload();
  }, [reload]);

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    return (pairs ?? []).filter(
      (p) =>
        !q ||
        p.base.includes(q) ||
        p.symbolA.toUpperCase().includes(q) ||
        p.symbolB.toUpperCase().includes(q),
    );
  }, [pairs, query]);

  async function act(
    p: PairView,
    status: 'verified' | 'rejected' | 'candidate',
    multiplier?: number,
  ) {
    const key = pairId(p);
    setBusy(key);
    try {
      const r = await api.adminPairDecide(p, status, multiplier);
      haptic('success');
      setCounts(r.counts);
      reload();
    } catch (e) {
      haptic('error');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      {counts && (
        <section className="card summary summary--3">
          <Cell label={t('pairs.verified')} value={String(counts.verified)} tone="green" />
          <Cell label={t('pairs.auto')} value={String(counts.auto)} />
          <Cell label={t('pairs.anomalies')} value={String(counts.anomalies)} tone="yellow" />
        </section>
      )}

      <p className="hint">{t('pairs.hint')}</p>

      <div className="segmented">
        {(['anomalies', 'verified', 'rejected'] as Tab[]).map((k) => (
          <button
            key={k}
            type="button"
            className={`segmented__item${tab === k ? ' segmented__item--active' : ''}`}
            onClick={() => setTab(k)}
          >
            {t(`pairs.tab_${k}`)}
          </button>
        ))}
      </div>

      <div className="filters filters--pill">
        <div className="search search--pill">
          <input
            className="search__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('pairs.search')}
            style={{ paddingLeft: 14 }}
          />
        </div>
      </div>

      {error && <section className="card notice notice--warn">{error}</section>}

      {pairs === null && <div className="empty">{t('app.loading')}</div>}
      {pairs !== null && visible.length === 0 && (
        <div className="card empty">
          {tab === 'anomalies' ? t('pairs.emptyAnomalies') : t('pairs.empty')}
        </div>
      )}

      {visible.length > 0 && (
        <section className="card list">
          {visible.map((p) => (
            <PairRow key={pairId(p)} pair={p} busy={busy === pairId(p)} onAct={act} />
          ))}
        </section>
      )}
      {total > (pairs?.length ?? 0) && (
        <p className="hint">{t('pairs.truncated', { shown: pairs?.length ?? 0, count: total })}</p>
      )}
    </div>
  );
}

function pairId(p: PairView): string {
  return `${p.exchangeA}:${p.symbolA}|${p.exchangeB}:${p.symbolB}`;
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'yellow' }) {
  const color =
    tone === 'green' ? 'var(--green)' : tone === 'yellow' ? 'var(--yellow)' : 'var(--text)';
  return (
    <div className="summary__cell">
      <div className="summary__label">{label}</div>
      <div className="summary__value num" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function PairRow({
  pair: p,
  busy,
  onAct,
}: {
  pair: PairView;
  busy: boolean;
  onAct: (p: PairView, status: 'verified' | 'rejected' | 'candidate', multiplier?: number) => void;
}) {
  const { t } = useTranslation();
  const ratio = p.liveRatio ?? p.ratio;
  // Множитель предзаполняем округлённым отношением — обычно это и есть ответ.
  const [mult, setMult] = useState(() =>
    p.status === 'verified' ? String(p.multiplier) : suggestMultiplier(ratio),
  );
  const name = (id: string) => EXCHANGES.find((e) => e.id === id)?.name ?? id;
  const fmt = (v: number | null) => (v === null ? '—' : formatPrice(v, priceDecimals(v)));

  return (
    <div className="pair-row">
      <div className="pair-row__head">
        <CoinIcon base={p.base} size={26} />
        <div className="pair-row__id">
          <div className="pair-row__base">
            {p.base}
            {p.verificationSource && (
              <span className="pair-row__source">{t(`pairs.source_${p.verificationSource}`)}</span>
            )}
          </div>
          <div className="pair-row__symbol">
            <ExchangeLogo id={p.exchangeA} size={11} /> {name(p.exchangeA)} · {p.symbolA}
            <span className="num"> {fmt(p.priceA)}</span>
          </div>
          <div className="pair-row__symbol">
            <ExchangeLogo id={p.exchangeB} size={11} /> {name(p.exchangeB)} · {p.symbolB}
            <span className="num"> {fmt(p.priceB)}</span>
          </div>
        </div>
        <div className="pair-row__price num">
          <div>{ratio === null ? '—' : fmtRatio(ratio)}</div>
          {p.externalA && p.externalB && (
            <div
              style={{
                fontSize: 11,
                color: p.externalA === p.externalB ? 'var(--green)' : 'var(--red)',
              }}
            >
              {p.externalA === p.externalB ? p.externalA : `${p.externalA} ≠ ${p.externalB}`}
            </div>
          )}
        </div>
      </div>
      {p.note && <div className="pair-row__note">{p.note}</div>}
      <div className="pair-row__actions">
        <label className="pair-row__mult">
          <span>{t('pairs.multiplier')}</span>
          <input
            className="num"
            inputMode="decimal"
            value={mult}
            onChange={(e) => setMult(e.target.value)}
          />
        </label>
        {p.status !== 'verified' && (
          <Button size="sm" disabled={busy} onClick={() => onAct(p, 'verified', parseMult(mult))}>
            {t('pairs.verify')}
          </Button>
        )}
        {p.status !== 'rejected' && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onAct(p, 'rejected')}
          >
            {t('pairs.reject')}
          </Button>
        )}
        {p.status !== 'candidate' && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onAct(p, 'candidate')}
          >
            {t('pairs.reset')}
          </Button>
        )}
      </div>
    </div>
  );
}

function fmtRatio(r: number): string {
  if (r >= 100) return `×${Math.round(r)}`;
  if (r >= 1) return `×${r.toFixed(3)}`;
  const inv = 1 / r;
  return inv >= 100 ? `×1/${Math.round(inv)}` : `×${r.toFixed(4)}`;
}

/** «1000», «0.001» или «1/970» — как удобнее вводить. */
function parseMult(text: string): number | undefined {
  const m = text.trim().replace(',', '.');
  const frac = /^1\s*\/\s*([\d.]+)$/.exec(m);
  const v = frac ? 1 / Number(frac[1]) : Number(m);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

function suggestMultiplier(r: number | null): string {
  if (r === null) return '1';
  if (r >= 2) return String(Math.round(r));
  if (r <= 0.5) return `1/${Math.round(1 / r)}`;
  return '1';
}
