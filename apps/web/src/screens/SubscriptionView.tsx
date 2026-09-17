/**
 * Экран «Подписка»: статус, выбор тарифа и срока, оплата.
 *
 * Оплата звёздами открывает инвойс Telegram прямо в мини-приложении; оплата
 * USDT показывает кошелёк и сумму, пользователь присылает хэш перевода, и
 * заявка ждёт подтверждения администратора. Тарифы, которых ещё нет
 * (торговля), показаны с ценой и бейджем «Скоро», без взаимодействия.
 */
import {
  BILLING_MONTHS,
  PLAN_ORDER,
  PRICING,
  discountPct,
  type BillingMonths,
  type PlanId,
} from '@cs/shared';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InfoRow, RadioRow, Section } from '../components/Form';
import { Sheet } from '../components/Sheet';
import { AlertIcon, CheckIcon, ClockIcon } from '../icons';
import { api, type BillingResponse } from '../lib/api';
import { haptic, openInvoice, openTelegramLink } from '../lib/telegram';
import type { SettingsController } from '../lib/useSettings';

/** Подписи сетей: пользователь должен выбрать ту же сеть, что в своём кошельке. */
const NETWORK_LABEL: Record<string, string> = {
  TRC20: 'Tron — комиссия ~1 USDT',
  BEP20: 'BNB Smart Chain — комиссия копейки',
  ERC20: 'Ethereum — комиссия высокая, лучше другая сеть',
  TON: 'TON',
};

export function SubscriptionView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [plan, setPlan] = useState<PlanId>('screener');
  const [months, setMonths] = useState<BillingMonths>(1);
  const [pay, setPay] = useState<'stars' | 'crypto' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const reload = useCallback(() => {
    api
      .billing()
      .then(setBilling)
      .catch(() => setBilling(null));
  }, []);
  useEffect(reload, [reload]);

  if (!billing) return <div className="empty">{t('app.loading')}</div>;

  const sub = billing.subscription;
  const purchasable = new Set(billing.purchasable);
  const canBuy = purchasable.has(plan);
  const usd = PRICING[plan][months];

  async function refreshAll() {
    reload();
    settings.reload();
  }

  return (
    <div className="stack">
      <Section title={t('sub.statusTitle')}>
        <InfoRow
          label={sub.source === 'trial' ? t('sub.trial') : t(`sd.plan_${sub.plan}`)}
          value={
            sub.active
              ? sub.expiresAt
                ? t('sub.activeUntil', { date: fmtDate(sub.expiresAt) })
                : t('sd.planActive')
              : t('sub.inactive')
          }
          tone={sub.active ? 'green' : 'red'}
        />
        {sub.active && sub.expiresAt && (
          <InfoRow label={t('sub.daysLeft')} value={String(sub.daysLeft)} tone="dim" />
        )}
      </Section>

      {billing.pending && (
        <section className="card notice">
          <ClockIcon className="notice__icon" />
          <span>
            {t('sub.pendingNote', {
              id: billing.pending.id,
              amount: billing.pending.amount,
              network: billing.pending.network ?? '',
            })}
            {!billing.pending.txHash && ` ${t('sub.pendingNoHash')}`}
          </span>
        </section>
      )}

      {notice && (
        <section className={`card notice${notice.kind === 'warn' ? ' notice--warn' : ''}`}>
          {notice.kind === 'warn' ? (
            <AlertIcon className="notice__icon" />
          ) : (
            <CheckIcon className="notice__icon" />
          )}
          <span>{notice.text}</span>
        </section>
      )}

      <Section title={t('sub.planTitle')} hint={t('sub.planHint')}>
        {PLAN_ORDER.map((p) => (
          <RadioRow
            key={p}
            title={`${t(`sd.plan_${p}`)} · $${PRICING[p][1]}${t('sub.perMonth')}`}
            sub={t(`sub.plan_${p}_sub`)}
            selected={plan === p}
            onSelect={() => setPlan(p)}
            disabled={!purchasable.has(p)}
            badge={purchasable.has(p) ? undefined : t('settings.soon')}
          />
        ))}
      </Section>

      <Section title={t('sub.termTitle')} hint={t('sub.termHint')}>
        {BILLING_MONTHS.map((m) => {
          const d = discountPct(plan, m);
          return (
            <RadioRow
              key={m}
              title={`${m} ${t('sub.months', { count: m })} · $${PRICING[plan][m]}`}
              sub={
                d > 0
                  ? t('sub.perMonthWithDiscount', {
                      price: (PRICING[plan][m] / m).toFixed(1),
                      discount: d,
                    })
                  : t('sub.fullPrice')
              }
              selected={months === m}
              onSelect={() => setMonths(m)}
              disabled={!canBuy}
            />
          );
        })}
      </Section>

      <div className="grid grid-cols-2 gap-2">
        <Button
          disabled={!canBuy || !billing.starsAvailable}
          onClick={() => {
            haptic('tap');
            setPay('stars');
          }}
        >
          ⭐ {t('sub.payStars')}
        </Button>
        <Button
          variant="secondary"
          disabled={!canBuy || billing.wallets.length === 0}
          onClick={() => {
            haptic('tap');
            setPay('crypto');
          }}
        >
          {t('sub.payCrypto')}
        </Button>
      </div>
      <p className="hint">{t('sub.totalHint', { usd, plan: t(`sd.plan_${plan}`), months })}</p>

      {pay === 'stars' && (
        <StarsSheet
          plan={plan}
          months={months}
          usd={usd}
          starsPerUsd={billing.starsPerUsd}
          botUsername={billing.botUsername}
          onClose={() => setPay(null)}
          onDone={(ok) => {
            setPay(null);
            setNotice(
              ok
                ? { kind: 'ok', text: t('sub.starsPaid') }
                : { kind: 'warn', text: t('sub.starsFailed') },
            );
            void refreshAll();
          }}
        />
      )}

      {pay === 'crypto' && (
        <CryptoSheet
          plan={plan}
          months={months}
          usd={usd}
          networks={billing.wallets}
          onClose={() => setPay(null)}
          onSubmitted={() => {
            setPay(null);
            setNotice({ kind: 'ok', text: t('sub.cryptoSubmitted') });
            void refreshAll();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------- звёзды

function StarsSheet({
  plan,
  months,
  usd,
  starsPerUsd,
  botUsername,
  onClose,
  onDone,
}: {
  plan: PlanId;
  months: BillingMonths;
  usd: number;
  starsPerUsd: number;
  botUsername: string | null;
  onClose: () => void;
  onDone: (ok: boolean) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stars = Math.max(1, Math.round(usd * starsPerUsd));

  // Пока счёт выставлен, раз в 4 секунды спрашиваем сервер: как только
  // Telegram подтвердит оплату (в чате или в окне), подписка появится сама.
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      api
        .billing()
        .then((b) => {
          if (b.subscription.active) onDone(true);
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [waiting, onDone]);

  const [fallback, setFallback] = useState<{ link: string; sentToChat: boolean } | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { link, payment } = await api.starsInvoice(plan, months);
      setWaiting(true);
      const status = await openInvoice(link, 2500);
      // 'paid' — Telegram списал звёзды; подписку продлит бот по successful_payment.
      if (status === 'paid') return onDone(true);
      if (status === 'cancelled' || status === 'failed') return onDone(false);
      // Окно не открылось (или клиент не сообщил результат): шлём счёт в чат
      // с ботом и ведём туда.
      const sentToChat = await api
        .starsToChat(payment.id)
        .then(() => true)
        .catch(() => false);
      setFallback({ link, sentToChat });
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={t('sub.payStars')}
      description={t('sub.starsHint')}
      onClose={() => !busy && onClose()}
      footer={
        fallback ? (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => openTelegramLink(fallback.link)}>
              {t('sub.openInvoice')}
            </Button>
            <Button
              onClick={() =>
                openTelegramLink(botUsername ? `https://t.me/${botUsername}` : fallback.link)
              }
            >
              {t('sub.openChat')}
            </Button>
          </div>
        ) : (
          <Button disabled={busy} onClick={start}>
            {busy ? t('app.working') : t('sub.payAmount', { amount: `${stars} ⭐` })}
          </Button>
        )
      }
    >
      {fallback && (
        <section className="card notice">
          <ClockIcon className="notice__icon" />
          <span>{t(fallback.sentToChat ? 'sub.starsFallbackChat' : 'sub.starsFallbackLink')}</span>
        </section>
      )}
      <section className="card list">
        <InfoRow
          label={t(`sd.plan_${plan}`)}
          value={`${months} ${t('sub.months', { count: months })}`}
        />
        <InfoRow label={t('sub.price')} value={`$${usd} ≈ ${stars} ⭐`} />
      </section>
      {error && (
        <section className="card notice notice--warn">
          <AlertIcon className="notice__icon" />
          <span>{error}</span>
        </section>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------- USDT

function CryptoSheet({
  plan,
  months,
  usd,
  networks,
  onClose,
  onSubmitted,
}: {
  plan: PlanId;
  months: BillingMonths;
  usd: number;
  networks: string[];
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { t } = useTranslation();
  const [network, setNetwork] = useState(networks[0] ?? '');
  const [request, setRequest] = useState<{ id: string; address: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [hash, setHash] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.cryptoRequest(plan, months, network);
      setRequest({ id: r.payment.id, address: r.address });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      await api.cryptoSubmit(request.id, hash.trim());
      haptic('success');
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={t('sub.payCrypto')}
      description={request ? t('sub.cryptoStep2') : t('sub.cryptoStep1')}
      onClose={() => !busy && onClose()}
      footer={
        request ? (
          <Button disabled={busy || hash.trim().length < 10} onClick={submit}>
            {busy ? t('app.working') : t('sub.iPaid')}
          </Button>
        ) : (
          <Button disabled={busy || !network} onClick={create}>
            {busy ? t('app.working') : t('sub.showWallet')}
          </Button>
        )
      }
    >
      {!request && (
        <section className="card list">
          {networks.map((n) => (
            <RadioRow
              key={n}
              title={`USDT · ${n}`}
              sub={NETWORK_LABEL[n]}
              selected={network === n}
              onSelect={() => setNetwork(n)}
            />
          ))}
          <InfoRow label={t('sub.price')} value={`${usd} USDT`} />
        </section>
      )}

      {request && (
        <>
          <section className="card list">
            <InfoRow label={t('sub.amount')} value={`${usd} USDT`} tone="green" />
            <InfoRow label={t('sub.network')} value={network} />
            <InfoRow label={t('sub.requestCode')} value={`#${request.id}`} tone="dim" />
          </section>
          <div className="card card--pad">
            <div className="section-label" style={{ margin: '0 0 6px' }}>
              {t('sub.address')}
            </div>
            <code className="num" style={{ wordBreak: 'break-all', fontSize: 13 }}>
              {request.address}
            </code>
            <Button
              variant="secondary"
              className="mt-2 h-9 w-full"
              onClick={() => {
                void navigator.clipboard?.writeText(request.address);
                haptic('success');
                setCopied(true);
              }}
            >
              {copied ? t('sub.copied') : t('sub.copy')}
            </Button>
          </div>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('sub.txHash')}
            </span>
            <Input
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              placeholder={t('sub.txHashPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              className="h-[38px] rounded-lg border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-[13px]"
            />
          </label>
          <p className="hint hint--sheet">{t('sub.cryptoHint')}</p>
        </>
      )}

      {error && (
        <section className="card notice notice--warn">
          <AlertIcon className="notice__icon" />
          <span>{error}</span>
        </section>
      )}
    </Sheet>
  );
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
