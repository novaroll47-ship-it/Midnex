/**
 * Экран «API-ключи бирж» (ТЗ §5.2, §10.4).
 *
 * Список восьми бирж; нажатие на биржу открывает шторку с формой. Секреты
 * уходят на сервер один раз при подключении и обратно не возвращаются —
 * в списке видны только последние символы ключа и результат проверки.
 *
 * Ключ с правом вывода средств сервер отклоняет; у бирж, которые не отдают
 * права по API, вместо зелёной галочки — чек-лист, который пользователь
 * должен пройти сам.
 */
import { EXCHANGES, type ExchangeId } from '@cs/shared';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ExchangeLogo } from '../components/ExchangeLogo';
import { Section } from '../components/Form';
import { Sheet } from '../components/Sheet';
import { AlertIcon, ShieldIcon } from '../icons';
import { ApiError, api, type ExchangeKeyPublic } from '../lib/api';
import { haptic } from '../lib/telegram';
import type { SettingsController } from '../lib/useSettings';

export function ApiKeysView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<ExchangeKeyPublic[] | null>(null);
  const [encryption, setEncryption] = useState(true);
  const [open, setOpen] = useState<ExchangeId | null>(null);

  const reload = useCallback(() => {
    return api
      .keys()
      .then((r) => {
        setKeys(r.keys);
        setEncryption(r.encryption);
      })
      .catch(() => setKeys([]));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Счётчик «подключено N» на главном экране настроек читает settings.data —
  // после любого изменения обновляем и его.
  async function changed() {
    await reload();
    settings.reload();
  }

  return (
    <div className="stack">
      {!encryption && (
        <section className="card notice notice--warn">
          <AlertIcon className="notice__icon" />
          <span>{t('keys.encryptionOff')}</span>
        </section>
      )}

      <Section title={t('sd.keysList')} hint={t('keys.listHint')}>
        {EXCHANGES.map((meta) => {
          const k = keys?.find((x) => x.exchange === meta.id);
          const { text, color } = statusOf(k, t);
          return (
            <button
              type="button"
              className="list__item"
              key={meta.id}
              onClick={() => {
                haptic('tap');
                setOpen(meta.id);
              }}
            >
              <span className="flex items-center gap-2.5">
                <ExchangeLogo id={meta.id} size={26} />
                <span>
                  <span className="list__title">{meta.name}</span>
                  <span className="list__sub">
                    {k
                      ? `${k.label || t('keys.key')} ${k.keyHint}`
                      : meta.needsPassphrase
                        ? t('sd.keyThreeFields')
                        : t('sd.keyTwoFields')}
                  </span>
                </span>
              </span>
              <span />
              <span className="list__meta" style={{ color }}>
                {keys === null ? '…' : text}
              </span>
            </button>
          );
        })}
      </Section>

      <section className="card notice">
        <ShieldIcon className="notice__icon" />
        <span>{t('sd.keysSafetyNote')}</span>
      </section>

      {open && (
        <KeySheet
          exchange={open}
          existing={keys?.find((x) => x.exchange === open) ?? null}
          encryption={encryption}
          onClose={() => setOpen(null)}
          onChanged={changed}
        />
      )}
    </div>
  );
}

function statusOf(
  k: ExchangeKeyPublic | undefined,
  t: (key: string) => string,
): { text: string; color: string } {
  if (!k) return { text: t('sd.keyNotConnected'), color: 'var(--text-mute)' };
  switch (k.status) {
    case 'ok':
      return k.permissionsVerified
        ? { text: t('sd.keyVerified'), color: 'var(--profit)' }
        : { text: t('sd.keyManual'), color: 'var(--yellow)' };
    case 'withdrawal_enabled':
      return { text: t('keys.statusWithdrawal'), color: 'var(--loss)' };
    case 'invalid':
      return { text: t('keys.statusInvalid'), color: 'var(--loss)' };
    default:
      return { text: t('keys.statusUnverified'), color: 'var(--text-mute)' };
  }
}

// ------------------------------------------------------------- шторка

function KeySheet({
  exchange,
  existing,
  encryption,
  onClose,
  onChanged,
}: {
  exchange: ExchangeId;
  existing: ExchangeKeyPublic | null;
  encryption: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const meta = EXCHANGES.find((e) => e.id === exchange)!;

  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'ok'; balance: number | null; manual: boolean }
    | { kind: 'withdrawal' }
    | { kind: 'error'; text: string }
    | null
  >(null);

  // Заменить ключ можно, не удаляя старый: форма показывается и для
  // подключённой биржи, если пользователь захотел ввести новый.
  const [replacing, setReplacing] = useState(false);
  const showForm = !existing || replacing;

  const canSubmit =
    encryption &&
    apiKey.trim().length > 0 &&
    secret.trim().length > 0 &&
    (!meta.needsPassphrase || passphrase.trim().length > 0);

  async function connect() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.connectKey(exchange, {
        apiKey: apiKey.trim(),
        secret: secret.trim(),
        passphrase: meta.needsPassphrase ? passphrase.trim() : undefined,
        label: label.trim() || undefined,
      });
      // Секреты в памяти страницы не задерживаем.
      setApiKey('');
      setSecret('');
      setPassphrase('');
      setReplacing(false);
      haptic('success');
      setResult({ kind: 'ok', balance: r.usdtBalance, manual: r.manualChecklist });
      await onChanged();
    } catch (err) {
      haptic('error');
      if (err instanceof ApiError && err.code === 'withdrawal_enabled') {
        setResult({ kind: 'withdrawal' });
      } else {
        setResult({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.verifyKey(exchange);
      haptic(r.key.status === 'ok' ? 'success' : 'warning');
      setResult(
        r.key.status === 'ok'
          ? { kind: 'ok', balance: r.usdtBalance, manual: !r.key.permissionsVerified }
          : r.key.status === 'withdrawal_enabled'
            ? { kind: 'withdrawal' }
            : { kind: 'error', text: r.key.lastError ?? t('keys.statusInvalid') },
      );
      await onChanged();
    } catch (err) {
      haptic('error');
      setResult({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteKey(exchange);
      haptic('success');
      await onChanged();
      onClose();
    } catch (err) {
      haptic('error');
      setConfirmDelete(false);
      setResult({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Sheet
        title={meta.name}
        description={existing && !replacing ? undefined : t('keys.formHint')}
        onClose={() => !busy && onClose()}
        footer={
          showForm ? (
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => (existing ? setReplacing(false) : onClose())}
              >
                {t('app.cancel')}
              </Button>
              <Button disabled={!canSubmit || busy} onClick={connect}>
                {busy ? t('keys.checking') : t('keys.connect')}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" disabled={busy} onClick={verify}>
                {busy ? t('keys.checking') : t('keys.verify')}
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => setConfirmDelete(true)}>
                {t('keys.remove')}
              </Button>
            </div>
          )
        }
      >
        {existing && !replacing && (
          <section className="card list">
            <div className="list__item">
              <span>
                <span className="list__title">
                  {existing.label || t('keys.key')} {existing.keyHint}
                </span>
                <span className="list__sub">
                  {t('keys.checkedAt')}:{' '}
                  {existing.lastCheckedAt ? new Date(existing.lastCheckedAt).toLocaleString() : '—'}
                </span>
              </span>
              <span />
              <span className="list__meta" style={{ color: statusOf(existing, t).color }}>
                {statusOf(existing, t).text}
              </span>
            </div>
            <button type="button" className="list__item" onClick={() => setReplacing(true)}>
              <span className="list__title">{t('keys.replace')}</span>
              <span />
              <span className="list__meta">›</span>
            </button>
          </section>
        )}

        {showForm && (
          <div className="stack">
            <Field
              label="API key"
              value={apiKey}
              onChange={setApiKey}
              placeholder={t('keys.pasteKey')}
            />
            <Field
              label="Secret"
              value={secret}
              onChange={setSecret}
              placeholder={t('keys.pasteSecret')}
              secret
            />
            {meta.needsPassphrase && (
              <Field
                label="Passphrase"
                value={passphrase}
                onChange={setPassphrase}
                placeholder={t('keys.pastePassphrase')}
                secret
              />
            )}
            <Field
              label={t('keys.label')}
              value={label}
              onChange={setLabel}
              placeholder={t('keys.labelPlaceholder')}
            />
          </div>
        )}

        {result?.kind === 'ok' && (
          <section className="card notice">
            <ShieldIcon className="notice__icon" />
            <span>
              {t('keys.connected')}
              {result.balance !== null &&
                ` · ${t('keys.balance')}: ${result.balance.toFixed(2)} USDT`}
            </span>
          </section>
        )}
        {result?.kind === 'withdrawal' && (
          <section className="card notice notice--warn">
            <AlertIcon className="notice__icon" />
            <span>{t('keys.withdrawalRejected')}</span>
          </section>
        )}
        {result?.kind === 'error' && (
          <section className="card notice notice--warn">
            <AlertIcon className="notice__icon" />
            <span>
              {t('keys.failed')}: {result.text}
            </span>
          </section>
        )}

        {/* Чек-лист показываем всегда, где права не подтверждены по API:
            до подключения — как инструкцию, после — как то, что осталось на
            совести пользователя. */}
        {(showForm || (existing && !existing.permissionsVerified)) && (
          <section className="card list">
            <div className="px-3 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('keys.checklistTitle')}
            </div>
            {(['noWithdraw', 'futuresOnly', 'ipWhitelist', 'separateKey'] as const).map((item) => (
              <div className="list__item" key={item}>
                <span className="list__sub" style={{ whiteSpace: 'normal' }}>
                  {t(`keys.checklist.${item}`)}
                </span>
              </div>
            ))}
            {!(existing?.permissionsVerified ?? false) && (
              <p className="hint" style={{ padding: '0 12px 10px', margin: 0 }}>
                {exchange === 'binance' || exchange === 'bybit'
                  ? t('keys.autoChecked')
                  : t('keys.manualOnly')}
              </p>
            )}
          </section>
        )}
      </Sheet>

      {confirmDelete && (
        <ConfirmDialog
          title={t('keys.removeTitle', { exchange: meta.name })}
          message={t('keys.removeMessage')}
          confirmLabel={t('keys.remove')}
          danger
          busy={busy}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secret?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <Input
        type={secret ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="h-[38px] rounded-lg border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px]"
      />
    </label>
  );
}
