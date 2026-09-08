/**
 * Подэкраны раздела «Настройки».
 *
 * Каждый пункт списка открывает отдельный экран — как в нативных настройках
 * Telegram. Всё, что здесь меняется, немедленно уходит на сервер и влияет на
 * поведение приложения; заглушек без функции здесь нет, кроме двух мест,
 * которые честно помечены как недоступные до следующих этапов.
 */
import { APP_VERSION, EXCHANGES, PLAN_WATCHLIST_LIMIT, type PlanId } from '@cs/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckRow, InfoRow, NumberRow, RadioRow, Section, ToggleRow } from '../components/Form';
import { AlertIcon, ShieldIcon } from '../icons';
import { LANGUAGES, currentLanguage, setLanguage } from '../i18n';
import { api } from '../lib/api';
import { platform, tgVersion } from '../lib/telegram';
import type { SettingsController } from '../lib/useSettings';

export type SettingsView =
  | 'general'
  | 'opportunities'
  | 'notifications'
  | 'risk'
  | 'subscription'
  | 'apikeys'
  | 'sessions'
  | 'theme'
  | 'language'
  | 'about';

export function settingsViewTitle(view: SettingsView, t: (k: string) => string): string {
  const map: Record<SettingsView, string> = {
    general: 'settings.generalTitle',
    opportunities: 'settings.opportunitiesTitle',
    notifications: 'settings.notificationsTitle',
    risk: 'settings.riskTitle',
    subscription: 'settings.subscriptionTitle',
    apikeys: 'settings.apiKeysTitle',
    sessions: 'settings.sessionsTitle',
    theme: 'settings.themeTitle',
    language: 'settings.languageTitle',
    about: 'settings.aboutTitle',
  };
  return t(map[view]);
}

export function SettingsDetail({
  view,
  settings,
}: {
  view: SettingsView;
  settings: SettingsController;
}) {
  const { t } = useTranslation();

  if (!settings.data) {
    return <div className="empty">{t('app.loading')}</div>;
  }

  switch (view) {
    case 'general':
      return <GeneralView settings={settings} />;
    case 'opportunities':
      return <OpportunitiesView settings={settings} />;
    case 'notifications':
      return <NotificationsView settings={settings} />;
    case 'risk':
      return <RiskView settings={settings} />;
    case 'subscription':
      return <SubscriptionView settings={settings} />;
    case 'apikeys':
      return <ApiKeysView settings={settings} />;
    case 'sessions':
      return <SessionsView />;
    case 'theme':
      return <ThemeView />;
    case 'language':
      return <LanguageView />;
    case 'about':
      return <AboutView />;
  }
}

// ------------------------------------------------------------- основные

function GeneralView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const bot = settings.data!.bot;

  return (
    <div className="stack">
      <Section title={t('sd.botState')}>
        <ToggleRow
          title={t('sd.running')}
          sub={t('sd.runningSub')}
          value={bot.running}
          onChange={(running) => settings.patchBot({ running })}
        />
      </Section>

      <Section title={t('sd.mode')} hint={t('sd.modeHint')}>
        <RadioRow
          title={t('sd.modeScreener')}
          sub={t('sd.modeScreenerSub')}
          selected={bot.mode === 'screener'}
          onSelect={() => settings.patchBot({ mode: 'screener' })}
        />
        <RadioRow
          title={t('sd.modeSemi')}
          sub={t('sd.modeSemiSub')}
          selected={bot.mode === 'semi'}
          onSelect={() => settings.patchBot({ mode: 'semi' })}
        />
        <RadioRow
          title={t('sd.modeAuto')}
          sub={t('sd.modeAutoSub')}
          selected={bot.mode === 'auto'}
          onSelect={() => settings.patchBot({ mode: 'auto' })}
        />
      </Section>

      <Section title={t('sd.execution')} hint={t('sd.executionHint')}>
        <RadioRow
          title={t('sd.execPaper')}
          sub={t('sd.execPaperSub')}
          selected={bot.executionMode === 'paper'}
          onSelect={() => settings.patchBot({ executionMode: 'paper' })}
        />
        <RadioRow
          title={t('sd.execTestnet')}
          sub={t('sd.execTestnetSub')}
          selected={bot.executionMode === 'testnet'}
          onSelect={() => settings.patchBot({ executionMode: 'testnet' })}
          badge={t('sd.stageM5')}
          disabled
        />
        <RadioRow
          title={t('sd.execLive')}
          sub={t('sd.execLiveSub')}
          selected={bot.executionMode === 'live'}
          onSelect={() => settings.patchBot({ executionMode: 'live' })}
          badge={t('sd.stageM5')}
          disabled
        />
      </Section>

      <Section title={t('sd.refresh')}>
        <NumberRow
          title={t('sd.refreshRate')}
          sub={t('sd.refreshRateSub')}
          value={Math.round(bot.refreshMs / 1000)}
          unit={t('sd.unitSec')}
          min={1}
          max={60}
          onCommit={(sec) => settings.patchBot({ refreshMs: sec * 1000 })}
        />
      </Section>
    </div>
  );
}

// ------------------------------------------------------------- возможности

function OpportunitiesView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const bot = settings.data!.bot;
  const enabled = new Set(bot.enabledExchanges);

  function toggleExchange(id: (typeof EXCHANGES)[number]['id']) {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Спред считается между двумя биржами — с одной сравнивать не с чем.
    if (next.size < 2) return;
    settings.patchBot({ enabledExchanges: [...next] });
  }

  return (
    <div className="stack">
      <Section title={t('sd.exchanges')} hint={t('sd.exchangesHint')}>
        {EXCHANGES.map((ex) => (
          <CheckRow
            key={ex.id}
            title={ex.name}
            sub={ex.needsPassphrase ? t('sd.needsPassphrase') : undefined}
            checked={enabled.has(ex.id)}
            onToggle={() => toggleExchange(ex.id)}
            accent={ex.brand}
          />
        ))}
      </Section>

      <Section title={t('sd.entryParams')} hint={t('sd.minSpreadHint')}>
        <NumberRow
          title={t('sd.minSpread')}
          value={bot.minSpreadPct}
          unit="%"
          min={0}
          max={50}
          step={0.05}
          onCommit={(minSpreadPct) => settings.patchBot({ minSpreadPct })}
        />
        <NumberRow
          title={t('sd.defaultLeverage')}
          value={bot.defaultLeverage}
          unit="x"
          min={1}
          max={settings.data!.risk.maxLeverage}
          onCommit={(defaultLeverage) => settings.patchBot({ defaultLeverage })}
        />
        <NumberRow
          title={t('sd.defaultNotional')}
          sub={t('sd.defaultNotionalSub')}
          value={bot.defaultNotionalUsdt}
          unit="USDT"
          min={5}
          onCommit={(defaultNotionalUsdt) => settings.patchBot({ defaultNotionalUsdt })}
        />
      </Section>

      <Section title={t('sd.funding')} hint={t('sd.fundingHint')}>
        <ToggleRow
          title={t('sd.onlyProfitableFunding')}
          sub={t('sd.onlyProfitableFundingSub')}
          value={bot.onlyProfitableFunding}
          onChange={(onlyProfitableFunding) => settings.patchBot({ onlyProfitableFunding })}
        />
      </Section>
    </div>
  );
}

// ------------------------------------------------------------- уведомления

function NotificationsView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const n = settings.data!.notifications;

  return (
    <div className="stack">
      <Section hint={t('sd.notifyHint')}>
        <ToggleRow
          title={t('sd.notifyEnabled')}
          sub={t('sd.notifyEnabledSub')}
          value={n.enabled}
          onChange={(enabled) => settings.patchNotifications({ enabled })}
        />
      </Section>

      <Section title={t('sd.notifyEvents')}>
        <ToggleRow
          title={t('sd.notifyOpportunity')}
          sub={t('sd.notifyOpportunitySub')}
          value={n.onOpportunity}
          disabled={!n.enabled}
          onChange={(onOpportunity) => settings.patchNotifications({ onOpportunity })}
        />
        <NumberRow
          title={t('sd.notifyThreshold')}
          value={n.opportunityThresholdPct}
          unit="%"
          min={0}
          max={50}
          step={0.1}
          onCommit={(opportunityThresholdPct) =>
            settings.patchNotifications({ opportunityThresholdPct })
          }
        />
        <ToggleRow
          title={t('sd.notifyOpened')}
          value={n.onPositionOpened}
          disabled={!n.enabled}
          onChange={(onPositionOpened) => settings.patchNotifications({ onPositionOpened })}
        />
        <ToggleRow
          title={t('sd.notifyClosed')}
          value={n.onPositionClosed}
          disabled={!n.enabled}
          onChange={(onPositionClosed) => settings.patchNotifications({ onPositionClosed })}
        />
        <ToggleRow
          title={t('sd.notifyRisk')}
          sub={t('sd.notifyRiskSub')}
          value={n.onRiskLimit}
          disabled={!n.enabled}
          onChange={(onRiskLimit) => settings.patchNotifications({ onRiskLimit })}
        />
        <ToggleRow
          title={t('sd.notifyConfirm')}
          sub={t('sd.notifyConfirmSub')}
          value={n.onConfirmationNeeded}
          disabled={!n.enabled}
          onChange={(onConfirmationNeeded) => settings.patchNotifications({ onConfirmationNeeded })}
        />
      </Section>
    </div>
  );
}

// ------------------------------------------------------------- риск

function RiskView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const r = settings.data!.risk;

  return (
    <div className="stack">
      <Section title={t('sd.riskLimits')} hint={t('sd.riskHint')}>
        <NumberRow
          title={t('sd.maxOpenPairs')}
          sub={t('sd.maxOpenPairsSub')}
          value={r.maxOpenPairs}
          min={1}
          max={50}
          onCommit={(maxOpenPairs) => settings.patchRisk({ maxOpenPairs })}
        />
        <NumberRow
          title={t('sd.maxLeverage')}
          value={r.maxLeverage}
          unit="x"
          min={1}
          max={125}
          onCommit={(maxLeverage) => settings.patchRisk({ maxLeverage })}
        />
        <NumberRow
          title={t('sd.maxNotional')}
          sub={t('sd.maxNotionalSub')}
          value={r.maxNotionalPerLegUsdt}
          unit="USDT"
          min={5}
          onCommit={(maxNotionalPerLegUsdt) => settings.patchRisk({ maxNotionalPerLegUsdt })}
        />
        <NumberRow
          title={t('sd.dailyLoss')}
          sub={t('sd.dailyLossSub')}
          value={r.dailyLossLimitPct}
          unit="%"
          min={0.5}
          max={100}
          step={0.5}
          onCommit={(dailyLossLimitPct) => settings.patchRisk({ dailyLossLimitPct })}
        />
        <NumberRow
          title={t('sd.holdTimeout')}
          sub={t('sd.holdTimeoutSub')}
          value={r.holdTimeoutMinutes}
          unit={t('sd.unitMin')}
          min={1}
          onCommit={(holdTimeoutMinutes) => settings.patchRisk({ holdTimeoutMinutes })}
        />
      </Section>

      <Section title={t('sd.entryMechanics')} hint={t('sd.entryMechanicsHint')}>
        <NumberRow
          title={t('sd.limitTimeout')}
          sub={t('sd.limitTimeoutSub')}
          value={r.limitOrderTimeoutMs}
          unit={t('sd.unitMs')}
          min={200}
          max={60_000}
          step={100}
          onCommit={(limitOrderTimeoutMs) => settings.patchRisk({ limitOrderTimeoutMs })}
        />
        <NumberRow
          title={t('sd.chaseAttempts')}
          sub={t('sd.chaseAttemptsSub')}
          value={r.chaseAttempts}
          min={1}
          max={20}
          onCommit={(chaseAttempts) => settings.patchRisk({ chaseAttempts })}
        />
        <NumberRow
          title={t('sd.chaseTimeout')}
          value={r.chaseTimeoutMs}
          unit={t('sd.unitMs')}
          min={500}
          max={60_000}
          step={500}
          onCommit={(chaseTimeoutMs) => settings.patchRisk({ chaseTimeoutMs })}
        />
      </Section>
    </div>
  );
}

// ------------------------------------------------------------- подписка

const PLANS: PlanId[] = ['screener', 'limited', 'unlimited'];

function SubscriptionView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const current = settings.data!.plan;

  return (
    <div className="stack">
      <Section title={t('sd.currentPlan')}>
        <InfoRow label={t(`sd.plan_${current}`)} value={t('sd.planActive')} tone="green" />
        <InfoRow
          label={t('sd.watchlistLimitLabel')}
          value={
            PLAN_WATCHLIST_LIMIT[current] === null
              ? t('sd.unlimited')
              : String(PLAN_WATCHLIST_LIMIT[current])
          }
        />
      </Section>

      <Section title={t('sd.changePlan')} hint={t('sd.paymentsHint')}>
        {PLANS.map((plan) => (
          <RadioRow
            key={plan}
            title={t(`sd.plan_${plan}`)}
            sub={t(`sd.plan_${plan}_sub`)}
            selected={current === plan}
            onSelect={() => settings.patchPlan(plan)}
          />
        ))}
      </Section>
    </div>
  );
}

// ------------------------------------------------------------- API-ключи

function ApiKeysView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const keys = settings.data!.apiKeys;

  return (
    <div className="stack">
      <section className="card notice notice--warn">
        <AlertIcon className="notice__icon" />
        <span>{t('sd.keysStageWarning')}</span>
      </section>

      <Section title={t('sd.keysList')}>
        {keys.map((k) => {
          const meta = EXCHANGES.find((e) => e.id === k.exchange)!;
          const status = !k.connected
            ? t('sd.keyNotConnected')
            : k.permissionsVerified
              ? t('sd.keyVerified')
              : t('sd.keyManual');
          return (
            <div className="list__item" key={k.exchange}>
              <span>
                <span className="list__title" style={{ color: meta.brand }}>
                  {meta.name}
                </span>
                <span className="list__sub">
                  {meta.needsPassphrase ? t('sd.keyThreeFields') : t('sd.keyTwoFields')}
                </span>
              </span>
              <span />
              <span
                className="list__meta"
                style={{
                  color: !k.connected
                    ? 'var(--text-mute)'
                    : k.permissionsVerified
                      ? 'var(--green)'
                      : 'var(--yellow)',
                }}
              >
                {status}
              </span>
            </div>
          );
        })}
      </Section>

      <section className="card notice">
        <ShieldIcon className="notice__icon" />
        <span>{t('sd.keysSafetyNote')}</span>
      </section>
    </div>
  );
}

// ------------------------------------------------------------- сессии

function SessionsView() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<{ platform: string; telegramVersion: string }[]>([]);

  useEffect(() => {
    api
      .sessions()
      .then((r) => setSessions(r.sessions))
      .catch(() => setSessions([{ platform, telegramVersion: tgVersion }]));
  }, []);

  return (
    <div className="stack">
      <Section title={t('sd.currentSession')} hint={t('sd.sessionsHint')}>
        {sessions.map((s, i) => (
          <div className="list__item" key={i}>
            <span>
              <span className="list__title">{s.platform}</span>
              <span className="list__sub">
                {t('sd.tgVersion')}: {s.telegramVersion}
              </span>
            </span>
            <span />
            <span className="list__meta list__meta--green">{t('sd.sessionCurrent')}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}

// ------------------------------------------------------------- тема и язык

function ThemeView() {
  const { t } = useTranslation();
  return (
    <div className="stack">
      <Section title={t('sd.theme')} hint={t('sd.themeHint')}>
        <RadioRow title={t('settings.themeDark')} selected onSelect={() => {}} />
        <RadioRow
          title={t('sd.themeLight')}
          selected={false}
          onSelect={() => {}}
          badge={t('settings.soon')}
          disabled
        />
      </Section>
    </div>
  );
}

function LanguageView() {
  const { t } = useTranslation();
  const lang = currentLanguage();
  return (
    <div className="stack">
      <Section title={t('settings.languageTitle')} hint={t('sd.languageHint')}>
        {LANGUAGES.map((l) => (
          <RadioRow
            key={l.code}
            title={l.label}
            selected={lang === l.code}
            onSelect={() => setLanguage(l.code)}
          />
        ))}
      </Section>
    </div>
  );
}

function AboutView() {
  const { t } = useTranslation();
  return (
    <div className="stack">
      <Section title={t('sd.aboutApp')}>
        <InfoRow label={t('sd.version')} value={APP_VERSION} />
        <InfoRow label={t('sd.stage')} value={t('sd.stageValue')} tone="dim" />
        <InfoRow label={t('sd.platform')} value={platform} tone="dim" />
      </Section>
      <p className="hint">{t('sd.aboutDisclaimer')}</p>
    </div>
  );
}
