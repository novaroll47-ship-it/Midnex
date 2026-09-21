/**
 * Экран «Подписка»: статус, выбор тарифа и срока, оплата.
 *
 * Оплата звёздами открывает инвойс Telegram прямо в мини-приложении; оплата
 * USDT — счёт в @CryptoBot, подтверждается автоматически. Возвратов нет, и
 * это написано до кнопок оплаты. Пришедшим по партнёрской ссылке к первой
 * оплате добавляется подарочная неделя — строка об этом видна на экране.
 * Тарифы, которых ещё нет (торговля), показаны с ценой и бейджем «Скоро».
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
import { InfoRow, RadioRow, Section } from '../components/Form';
import { Sheet } from '../components/Sheet';
import { AlertIcon, CheckIcon, ClockIcon } from '../icons';
import { api, type BillingResponse } from '../lib/api';
import { haptic, openInvoice, openTelegramLink } from '../lib/telegram';
import type { SettingsController } from '../lib/useSettings';

export function SubscriptionView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [plan, setPlan] = useState<PlanId>('screener');
  const [months, setMonths] = useState<BillingMonths>(1);
  const [pay, setPay] = useState<'stars' | 'cryptobot' | null>(null);
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

      {billing.bonusDays > 0 && (
        <section className="card notice">
          <span className="notice__icon">🎁</span>
          <span>{t('sub.bonusDays', { days: billing.bonusDays })}</span>
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

      {/* Два способа: CryptoBot и звёзды. */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          disabled={!canBuy || !billing.cryptoBotAvailable}
          onClick={() => {
            haptic('tap');
            setPay('cryptobot');
          }}
        >
          {t('sub.payCryptoBot')}
        </Button>
        <Button
          className="whitespace-nowrap"
          disabled={!canBuy || !billing.starsAvailable}
          onClick={() => {
            haptic('tap');
            setPay('stars');
          }}
        >
          ⭐ {t('sub.payStars')}
        </Button>
      </div>
      <p className="hint">
        {t('sub.totalHint', { usd, plan: t(`sd.plan_${plan}`), months })}
        {billing.bonusDays > 0 && ` ${t('sub.totalBonus', { days: billing.bonusDays })}`}
      </p>
      <p className="hint">{t('sub.noRefunds')}</p>

      {pay === 'stars' && (
        <StarsSheet
          plan={plan}
          months={months}
          usd={usd}
          bonusDays={billing.bonusDays}
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

      {pay === 'cryptobot' && (
        <CryptoBotSheet
          plan={plan}
          months={months}
          usd={usd}
          bonusDays={billing.bonusDays}
          onClose={() => setPay(null)}
          onDone={(ok) => {
            setPay(null);
            setNotice(
              ok
                ? { kind: 'ok', text: t('sub.starsPaid') }
                : { kind: 'warn', text: t('sub.cryptoBotPending') },
            );
            void refreshAll();
          }}
        />
      )}

    </div>
  );
}

// ------------------------------------------------------------- @CryptoBot

/**
 * Счёт в USDT через @CryptoBot: открываем ссылку на оплату внутри Telegram и
 * ждём подтверждения — сервер узнаёт об оплате вебхуком, а мы опрашиваем
 * статус заявки, пока шторка открыта.
 */
function CryptoBotSheet({
  plan,
  months,
  usd,
  bonusDays,
  onClose,
  onDone,
}: {
  plan: PlanId;
  months: BillingMonths;
  usd: number;
  bonusDays: number;
  onClose: () => void;
  onDone: (paid: boolean) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [invoice, setInvoice] = useState<{ id: string; payUrl: string; botUrl: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!invoice) return;
    let alive = true;
    const timer = setInterval(() => {
      api
        .paymentStatus(invoice.id)
        .then((r) => {
          if (!alive) return;
          if (r.payment.status === 'paid') onDone(true);
          else if (r.payment.status === 'cancelled' || r.payment.status === 'rejected')
            onDone(false);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [invoice, onDone]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.cryptoBotInvoice(plan, months);
      setInvoice({ id: r.payment.id, payUrl: r.payUrl, botUrl: r.botUrl });
      haptic('success');
      // Ссылка на бота (t.me/CryptoBot?start=…) открывается во всех клиентах;
      // мини-приложение счёта Desktop открывать не умеет.
      openTelegramLink(r.botUrl);
    } catch (e) {
      haptic('error');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={t('sub.payCryptoBot')}
      description={t('sub.cryptoBotHint')}
      onClose={() => !busy && onClose()}
      footer={
        invoice ? (
          <Button variant="secondary" onClick={() => openTelegramLink(invoice.botUrl)}>
            {t('sub.cryptoBotReopen')}
          </Button>
        ) : (
          <Button disabled={busy} onClick={create}>
            {busy ? t('app.working') : t('sub.payAmount', { amount: `${usd} USDT` })}
          </Button>
        )
      }
    >
      <section className="card list">
        <InfoRow
          label={t(`sd.plan_${plan}`)}
          value={`${months} ${t('sub.months', { count: months })}`}
        />
        <InfoRow label={t('sub.price')} value={`${usd} USDT`} tone="green" />
        {bonusDays > 0 && <InfoRow label={t('sub.bonusRow')} value={`+${bonusDays}`} tone="green" />}
      </section>
      <p className="hint hint--sheet">{t('sub.noRefunds')}</p>
      {invoice && (
        <>
          <section className="card notice">
            <ClockIcon className="notice__icon" />
            <span>{t('sub.cryptoBotWaiting')}</span>
          </section>
          {/* Обычная ссылка — на случай, если программное открытие клиент проигнорировал. */}
          <a className="btn-ghost coin-alert" href={invoice.botUrl} target="_blank" rel="noopener">
            {t('sub.cryptoBotOpenLink')}
          </a>
        </>
      )}
      {error && <section className="card notice notice--warn">{error}</section>}
    </Sheet>
  );
}

// ------------------------------------------------------------- звёзды

function StarsSheet({
  plan,
  months,
  usd,
  bonusDays,
  starsPerUsd,
  botUsername,
  onClose,
  onDone,
}: {
  plan: PlanId;
  months: BillingMonths;
  usd: number;
  bonusDays: number;
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
      title={t('sub.payStarsTitle')}
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
        {bonusDays > 0 && <InfoRow label={t('sub.bonusRow')} value={`+${bonusDays}`} tone="green" />}
      </section>
      <p className="hint hint--sheet">{t('sub.noRefunds')}</p>
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
