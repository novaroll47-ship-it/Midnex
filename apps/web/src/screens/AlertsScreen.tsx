/**
 * Вкладка «Алерты»: правила пользователя — по монете или общее — и их
 * состояние. Уведомления приходят в чат с ботом; здесь — только правила.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { CoinIcon } from '../components/CoinIcon';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Sheet } from '../components/Sheet';
import { BellIcon, ClockIcon, PlusIcon, XIcon } from '../icons';
import { api, type AlertRule } from '../lib/api';
import { haptic } from '../lib/telegram';

export function AlertsScreen({
  onOpenSubscription,
  presetBase,
  onPresetConsumed,
}: {
  onOpenSubscription: () => void;
  /** Открыть форму сразу с монетой — приход с экрана монеты. */
  presetBase?: string | null;
  onPresetConsumed?: () => void;
}) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [active, setActive] = useState(true);
  const [adding, setAdding] = useState<null | { base: string | null }>(null);
  const [removing, setRemoving] = useState<AlertRule | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api
      .alerts()
      .then((r) => {
        setRules(r.rules);
        setActive(r.active);
      })
      .catch(() => setRules([]));
  }, []);
  useEffect(reload, [reload]);

  useEffect(() => {
    if (presetBase) {
      setAdding({ base: presetBase });
      onPresetConsumed?.();
    }
  }, [presetBase, onPresetConsumed]);

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api.deleteAlert(removing.id);
      haptic('success');
      setRemoving(null);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="screen-title">
        <h1>{t('alerts.title')}</h1>
        <button className="btn-ghost" type="button" onClick={() => setAdding({ base: null })}>
          <PlusIcon size={15} />
          {t('alerts.add')}
        </button>
      </div>

      {!active && (
        <button type="button" className="card notice notice--warn" onClick={onOpenSubscription}>
          <BellIcon className="notice__icon" />
          <span>{t('alerts.inactiveNote')}</span>
        </button>
      )}

      <p className="hint">{t('alerts.hint')}</p>

      {rules === null && <div className="empty">{t('app.loading')}</div>}
      {rules && rules.length === 0 && (
        <section className="card soon">
          <BellIcon className="soon__icon" />
          <div className="soon__title">{t('alerts.emptyTitle')}</div>
          <div className="soon__text">{t('alerts.emptyText')}</div>
          <Button className="mt-3" onClick={() => setAdding({ base: null })}>
            {t('alerts.addFirst')}
          </Button>
        </section>
      )}

      {rules && rules.length > 0 && (
        <section className="card list">
          {rules.map((r) => (
            <div className="list__item" key={r.id}>
              <span className="flex items-center gap-2.5">
                {r.type === 'pair' && r.base ? (
                  <CoinIcon base={r.base} size={26} />
                ) : (
                  <span className="alert-glyph">
                    <BellIcon size={14} />
                  </span>
                )}
                <span>
                  <span className="list__title">
                    {r.type === 'pair' ? r.base : t('alerts.anyCoin')} · {t('alerts.above')}{' '}
                    <span className="num">{r.thresholdPct.toFixed(2)}%</span>
                  </span>
                  <span className="list__sub">
                    {r.isArmed
                      ? t('alerts.armed')
                      : t('alerts.fired', {
                          when: r.lastFiredAt ? fmtTime(r.lastFiredAt) : '',
                          base: r.type === 'global' && r.lastBase ? ` · ${r.lastBase}` : '',
                        })}
                  </span>
                </span>
              </span>
              <span />
              <button
                type="button"
                className="icon-btn-round"
                style={{ width: 32, height: 32 }}
                aria-label={t('alerts.remove')}
                onClick={() => setRemoving(r)}
              >
                <XIcon size={14} />
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="card notice">
        <ClockIcon className="notice__icon" />
        <span>{t('alerts.hysteresisNote')}</span>
      </section>

      {adding && (
        <AddSheet
          base={adding.base}
          onClose={() => setAdding(null)}
          onAdded={() => {
            setAdding(null);
            reload();
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={t('alerts.removeTitle')}
          message={t('alerts.removeText', {
            what: removing.type === 'pair' ? removing.base : t('alerts.anyCoin'),
          })}
          confirmLabel={t('alerts.remove')}
          danger
          busy={busy}
          onConfirm={remove}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

function AddSheet({
  base: preset,
  onClose,
  onAdded,
}: {
  base: string | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<'pair' | 'global'>(preset ? 'pair' : 'global');
  const [base, setBase] = useState(preset ?? '');
  const [threshold, setThreshold] = useState('1.00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const presets = ['0.50', '1.00', '2.00', '3.00', '5.00'];

  const valid =
    Number(threshold.replace(',', '.')) > 0 && (type === 'global' || base.trim().length > 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.createAlert({
        type,
        base: type === 'pair' ? base.trim().toUpperCase() : undefined,
        thresholdPct: Number(threshold.replace(',', '.')),
      });
      haptic('success');
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={t('alerts.newTitle')}
      description={t('alerts.newHint')}
      onClose={() => !busy && onClose()}
      footer={
        <Button disabled={!valid || busy} onClick={save}>
          {busy ? t('app.working') : t('alerts.save')}
        </Button>
      }
    >
      <div className="segmented">
        <button
          type="button"
          className={`segmented__item${type === 'pair' ? ' segmented__item--active' : ''}`}
          onClick={() => setType('pair')}
        >
          {t('alerts.typePair')}
        </button>
        <button
          type="button"
          className={`segmented__item${type === 'global' ? ' segmented__item--active' : ''}`}
          onClick={() => setType('global')}
        >
          {t('alerts.typeGlobal')}
        </button>
      </div>

      {type === 'pair' && (
        <div className="sheet__group">
          <label className="sheet__row">
            <span className="sheet__row-title">{t('alerts.coin')}</span>
            <input
              className="sheet__input"
              value={base}
              placeholder="BTC"
              autoCapitalize="characters"
              onChange={(e) => setBase(e.target.value.toUpperCase())}
            />
          </label>
        </div>
      )}

      <div className="sheet__group">
        <label className="sheet__row">
          <span>
            <span className="sheet__row-title">{t('alerts.threshold')}</span>
            <span className="sheet__row-sub">{t('alerts.thresholdSub')}</span>
          </span>
          <span className="num-field">
            <input
              className="num-field__input num"
              inputMode="decimal"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <span className="num-field__unit">%</span>
          </span>
        </label>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {presets.map((p) => (
          <Button
            key={p}
            variant={Number(threshold) === Number(p) ? 'default' : 'secondary'}
            className="num h-10 px-0"
            onClick={() => setThreshold(p)}
          >
            {p}%
          </Button>
        ))}
      </div>

      {error && <section className="card notice notice--warn">{error}</section>}
    </Sheet>
  );
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
