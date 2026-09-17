/**
 * Сверка ног — экран администратора.
 *
 * Список кандидатов с живой ценой и отношением к медиане уже сверенных
 * ног той же монеты: ratio ≈ 1 — та же монета, 1000 — множитель, всё
 * остальное — другой актив. Кнопки «Сверить» / «Отклонить», поле множителя,
 * массовое подтверждение совпадающих.
 */
import { EXCHANGES, formatPrice, priceDecimals, type ExchangeId } from '@cs/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { CoinIcon } from '../components/CoinIcon';
import { ExchangeLogo } from '../components/ExchangeLogo';
import { api, type LegView } from '../lib/api';
import { haptic } from '../lib/telegram';

type Tab = 'candidate' | 'verified' | 'rejected';

export function PairsAdminView() {
  const { t } = useTranslation();
  const [legs, setLegs] = useState<LegView[] | null>(null);
  const [counts, setCounts] = useState<{
    total: number;
    verified: number;
    candidate: number;
  } | null>(null);
  const [tab, setTab] = useState<Tab>('candidate');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .adminPairs()
      .then((r) => {
        setLegs(r.legs);
        setCounts(r.counts);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(reload, [reload]);

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    return (legs ?? [])
      .filter(
        (l) => l.status === tab && (!q || l.base.includes(q) || l.symbol.toUpperCase().includes(q)),
      )
      .sort((a, b) => {
        // Сначала те, где есть с чем сравнить; внутри — по монете.
        const ra = a.ratio === null ? 1 : 0;
        const rb = b.ratio === null ? 1 : 0;
        return ra - rb || a.base.localeCompare(b.base) || a.exchange.localeCompare(b.exchange);
      });
  }, [legs, tab, query]);

  async function act(
    l: LegView,
    status: 'verified' | 'rejected' | 'candidate',
    multiplier?: number,
  ) {
    const key = `${l.exchange}:${l.symbol}`;
    setBusy(key);
    try {
      await api.adminPairSet(l.exchange, l.symbol, status, multiplier);
      haptic('success');
      reload();
    } catch (e) {
      haptic('error');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function verifyMatching() {
    setBusy('all');
    try {
      const r = await api.adminPairsVerifyMatching();
      haptic('success');
      setError(null);
      setCounts(r.counts);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      {counts && (
        <section className="card summary summary--3">
          <Cell label={t('pairs.total')} value={String(counts.total)} />
          <Cell label={t('pairs.verified')} value={String(counts.verified)} tone="green" />
          <Cell label={t('pairs.candidates')} value={String(counts.candidate)} tone="yellow" />
        </section>
      )}

      <p className="hint">{t('pairs.hint')}</p>

      <div className="segmented">
        {(['candidate', 'verified', 'rejected'] as Tab[]).map((k) => (
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
        {tab === 'candidate' && (
          <Button
            className="h-11 rounded-full px-4"
            disabled={busy !== null}
            onClick={verifyMatching}
          >
            {t('pairs.verifyMatching')}
          </Button>
        )}
      </div>

      {error && <section className="card notice notice--warn">{error}</section>}

      {legs === null && <div className="empty">{t('app.loading')}</div>}
      {legs !== null && visible.length === 0 && (
        <div className="card empty">{t('pairs.empty')}</div>
      )}

      {visible.length > 0 && (
        <section className="card list">
          {visible.slice(0, 200).map((l) => (
            <LegRow
              key={`${l.exchange}:${l.symbol}`}
              leg={l}
              busy={busy === `${l.exchange}:${l.symbol}`}
              onAct={act}
            />
          ))}
        </section>
      )}
      {visible.length > 200 && (
        <p className="hint">{t('pairs.truncated', { count: visible.length })}</p>
      )}
    </div>
  );
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

function LegRow({
  leg: l,
  busy,
  onAct,
}: {
  leg: LegView;
  busy: boolean;
  onAct: (l: LegView, status: 'verified' | 'rejected' | 'candidate', multiplier?: number) => void;
}) {
  const { t } = useTranslation();
  const [mult, setMult] = useState(String(l.multiplier));
  const exName = EXCHANGES.find((e) => e.id === l.exchange)?.name ?? l.exchange;
  const ratioText =
    l.ratio === null ? '—' : `×${l.ratio.toFixed(l.ratio > 10 || l.ratio < 0.1 ? 0 : 3)}`;
  const ratioTone =
    l.ratio === null
      ? 'var(--text-mute)'
      : Math.abs(l.ratio - 1) <= 0.01
        ? 'var(--green)'
        : 'var(--red)';

  return (
    <div className="pair-row">
      <div className="pair-row__head">
        <CoinIcon base={l.base} size={26} />
        <div className="pair-row__id">
          <div className="pair-row__base">{l.base}</div>
          <div className="pair-row__symbol">
            <ExchangeLogo id={l.exchange as ExchangeId} size={11} /> {exName} · {l.symbol}
          </div>
        </div>
        <div className="pair-row__price num">
          <div>{l.price === null ? '—' : formatPrice(l.price, priceDecimals(l.price))}</div>
          <div style={{ color: ratioTone, fontSize: 11 }}>
            {ratioText}
            {l.peers > 0 && ` · ${t('pairs.peers', { count: l.peers })}`}
          </div>
        </div>
      </div>
      <div className="pair-row__actions">
        <label className="pair-row__mult">
          <span>{t('pairs.multiplier')}</span>
          <input
            className="num"
            inputMode="numeric"
            value={mult}
            onChange={(e) => setMult(e.target.value)}
          />
        </label>
        {l.status !== 'verified' && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onAct(l, 'verified', Number(mult) || undefined)}
          >
            {t('pairs.verify')}
          </Button>
        )}
        {l.status !== 'rejected' && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onAct(l, 'rejected')}
          >
            {t('pairs.reject')}
          </Button>
        )}
        {l.status !== 'candidate' && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onAct(l, 'candidate')}
          >
            {t('pairs.reset')}
          </Button>
        )}
      </div>
    </div>
  );
}
