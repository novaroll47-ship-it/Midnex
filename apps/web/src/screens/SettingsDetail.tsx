/**
 * Подэкраны раздела «Настройки».
 *
 * Каждый пункт списка открывает отдельный экран — как в нативных настройках
 * Telegram. Всё, что здесь меняется, немедленно уходит на сервер и влияет на
 * поведение приложения; заглушек без функции здесь нет, кроме двух мест,
 * которые честно помечены как недоступные до следующих этапов.
 */
import {
  APP_VERSION,
  EXCHANGES,
  PLAN_WATCHLIST_LIMIT,
  type PlanId,
  type SessionInfo,
} from '@cs/shared';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { KeyIcon } from '../icons';

import { ConfirmDialog } from '../components/ConfirmDialog';
import { ExchangeLogo } from '../components/ExchangeLogo';
import { CheckRow, InfoRow, NumberRow, RadioRow, Section, ToggleRow } from '../components/Form';
import { LANGUAGES, currentLanguage, setLanguage } from '../i18n';
import { api, type MarketStatus } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { haptic, openTelegramLink, platform, tgVersion } from '../lib/telegram';
import { currentThemeMode, setThemeMode, type ThemeMode } from '../lib/theme';
import type { SettingsController } from '../lib/useSettings';
import { ApiKeysView } from './ApiKeysView';
import { BotFundingView, BotSpreadView } from './BotViews';
import { PairsAdminView } from './PairsAdminView';
import { SubscriptionView } from './SubscriptionView';

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
  | 'about'
  | 'market'
  | 'botSpread'
  | 'botFunding'
  | 'pairs';

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
    market: 'settings.marketTitle',
    botSpread: 'bots.spreadName',
    botFunding: 'bots.fundingName',
    pairs: 'pairs.title',
  };
  return t(map[view]);
}

export function SettingsDetail({
  view,
  settings,
  onOpen,
}: {
  view: SettingsView;
  settings: SettingsController;
  /** Переход к другому разделу настроек (например, к ключам из списка бирж). */
  onOpen?: (view: SettingsView) => void;
}) {
  const { t } = useTranslation();

  if (!settings.data) {
    return <div className="empty">{t('app.loading')}</div>;
  }

  switch (view) {
    case 'general':
      return <GeneralView settings={settings} />;
    case 'opportunities':
      return <OpportunitiesView settings={settings} onOpen={onOpen} />;
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
      return <AboutView settings={settings} />;
    case 'market':
      return <MarketView />;
    case 'botSpread':
      return <BotSpreadView settings={settings} />;
    case 'botFunding':
      return <BotFundingView settings={settings} />;
    case 'pairs':
      return <PairsAdminView />;
  }
}

// ------------------------------------------------------------- основные

export function GeneralView({ settings }: { settings: SettingsController }) {
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
    </div>
  );
}

// ------------------------------------------------------------- возможности

export function OpportunitiesView({
  settings,
  onOpen,
}: {
  settings: SettingsController;
  onOpen?: (view: SettingsView) => void;
}) {
  const { t } = useTranslation();
  const bot = settings.data!.bot;
  const enabled = new Set(bot.enabledExchanges);
  // Торговать можно только там, где введён ключ: без него бот не откроет сделку.
  const withKey = new Set(
    (settings.data!.apiKeys ?? []).filter((k) => k.connected).map((k) => k.exchange),
  );
  const [needKey, setNeedKey] = useState<string | null>(null);

  function toggleExchange(id: (typeof EXCHANGES)[number]['id']) {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id);
    else {
      if (!withKey.has(id)) {
        haptic('warning');
        setNeedKey(EXCHANGES.find((e) => e.id === id)?.name ?? id);
        return;
      }
      next.add(id);
    }
    setNeedKey(null);
    settings.patchBot({ enabledExchanges: [...next] });
  }

  return (
    <div className="stack">
      <Section title={t('sd.exchanges')} hint={t('sd.exchangesHint')}>
        {EXCHANGES.map((ex) => (
          <CheckRow
            key={ex.id}
            title={ex.name}
            sub={withKey.has(ex.id) ? undefined : t('sd.noKey')}
            checked={enabled.has(ex.id)}
            disabled={!withKey.has(ex.id) && !enabled.has(ex.id)}
            onToggle={() => toggleExchange(ex.id)}
          />
        ))}
      </Section>
      {needKey && (
        <button type="button" className="card notice notice--warn" onClick={() => onOpen?.('apikeys')}>
          <KeyIcon className="notice__icon" />
          <span>{t('sd.needKeyNotice', { exchange: needKey })}</span>
        </button>
      )}

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
        {
          <>
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
          </>
        }
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

export function NotificationsView({ settings }: { settings: SettingsController }) {
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

export function RiskView({ settings }: { settings: SettingsController }) {
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

// ------------------------------------------------------------- API-ключи

// ------------------------------------------------------------- сессии

function SessionsView() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .sessions()
      .then((r) => setSessions(r.sessions))
      .catch(() =>
        setSessions([
          {
            id: 'local',
            platform,
            telegramVersion: tgVersion,
            current: true,
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
          },
        ]),
      );
  }, []);

  useEffect(load, [load]);

  async function logoutOthers() {
    setBusy(true);
    try {
      await api.logoutOthers();
      haptic('success');
      load();
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  const others = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <div className="stack">
      <Section title={t('sd.currentSession')} hint={t('sd.sessionsHint')}>
        {sessions === null && <div className="empty">{t('app.loading')}</div>}
        {(sessions ?? []).map((s) => (
          <div className="list__item" key={s.id}>
            <span>
              <span className="list__title">{platformName(s.platform, t)}</span>
              <span className="list__sub">
                {t('sd.tgVersion')}: {s.telegramVersion || '—'} · {t('sd.lastSeen')}:{' '}
                {new Date(s.lastSeenAt).toLocaleString()}
              </span>
            </span>
            <span />
            <span className={`list__meta${s.current ? ' list__meta--green' : ''}`}>
              {s.current ? t('sd.sessionCurrent') : t('sd.sessionOther')}
            </span>
          </div>
        ))}
      </Section>

      <Section hint={t('sd.logoutOthersHint')}>
        <button
          type="button"
          className="list__item"
          disabled={others === 0 || busy}
          onClick={() => setConfirm(true)}
        >
          <span
            className="list__title"
            style={{ color: others ? 'var(--loss)' : 'var(--text-mute)' }}
          >
            {t('sd.logoutOthers')}
          </span>
          <span />
          <span className="list__meta">{others}</span>
        </button>
      </Section>

      {confirm && (
        <ConfirmDialog
          title={t('sd.logoutOthers')}
          message={t('sd.logoutOthersConfirm', { count: others })}
          confirmLabel={t('sd.logoutOthers')}
          danger
          busy={busy}
          onConfirm={logoutOthers}
          onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  );
}

function platformName(p: string, t: (k: string) => string): string {
  const map: Record<string, string> = {
    ios: 'iOS',
    android: 'Android',
    tdesktop: 'Telegram Desktop',
    macos: 'macOS',
    weba: 'Telegram Web',
    webk: 'Telegram Web',
    web: t('sd.platformBrowser'),
    unknown: t('sd.platformUnknown'),
  };
  return map[p] ?? p;
}

// ------------------------------------------------------------- тема и язык

function ThemeView() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ThemeMode>(currentThemeMode);
  const modes: ThemeMode[] = ['system', 'dark', 'light', 'telegram'];
  return (
    <div className="stack">
      <Section title={t('sd.theme')} hint={t('sd.themeHint')}>
        {modes.map((m) => (
          <RadioRow
            key={m}
            title={t(`sd.theme_${m}`)}
            sub={m === 'system' || m === 'telegram' ? t(`sd.theme_${m}_sub`) : undefined}
            selected={mode === m}
            onSelect={() => {
              setMode(m);
              setThemeMode(m);
            }}
          />
        ))}
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

function AboutView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const storage = settings.data?.storage;
  return (
    <div className="stack">
      <Section title={t('sd.aboutApp')}>
        <InfoRow label={t('sd.version')} value={APP_VERSION} />
        <InfoRow label={t('sd.stage')} value={t('sd.stageValue')} tone="dim" />
        <InfoRow label={t('sd.platform')} value={platform} tone="dim" />
        <InfoRow
          label={t('sd.storage')}
          value={storage === 'postgres' ? t('sd.storagePostgres') : t('sd.storageMemory')}
          tone={storage === 'postgres' ? 'green' : 'red'}
        />
      </Section>
      <Section title={t('sd.links')}>
        <button
          type="button"
          className="list__item"
          onClick={() => openTelegramLink('https://t.me/midnexio')}
        >
          <span>
            <span className="list__title">{t('sd.channel')}</span>
            <span className="list__sub">@midnexio · {t('sd.channelSub')}</span>
          </span>
          <span />
          <span className="list__meta" style={{ color: 'var(--blue)' }}>
            {t('sd.open')}
          </span>
        </button>
      </Section>
      <p className="hint">{t('sd.aboutDisclaimer')}</p>
    </div>
  );
}

// ------------------------------------------------------------- данные бирж

/**
 * Экран отладки рыночного слоя: что подключено, каким способом, сколько
 * символов покрыто и с какой задержкой. Нужен, чтобы на приёмке отличить
 * «биржа молчит» от «код считает неправильно».
 */
function MarketView() {
  const { t } = useTranslation();
  const { data } = usePolling<MarketStatus>(() => api.marketStatus(), 2000);

  if (!data) return <div className="empty">{t('app.loading')}</div>;

  const engine = data.engine;
  const sourceText =
    data.mode === 'mock' ? t('md.modeMock') : data.live ? t('md.modeLive') : t('md.modeWarming');
  const uptime = engine?.startedAt ? formatUptime(Date.now() - engine.startedAt) : '—';

  return (
    <div className="stack">
      <Section title={t('md.source')}>
        <InfoRow label={t('md.source')} value={sourceText} tone={data.live ? 'green' : 'dim'} />
        <InfoRow label={t('md.universe')} value={String(engine?.universeSize ?? 0)} />
        <InfoRow label={t('md.uptime')} value={uptime} tone="dim" />
      </Section>

      {engine && (
        <Section title={t('md.feeds')} hint={t('md.feedsHint')}>
          {engine.feeds.map((f) => {
            const tone =
              f.status === 'live'
                ? 'var(--green)'
                : f.status === 'down'
                  ? 'var(--red)'
                  : 'var(--text-dim)';
            return (
              <div className="list__item" key={f.exchange}>
                <span>
                  <span
                    className="list__title"
                    style={{ display: 'flex', alignItems: 'center', gap: 7 }}
                  >
                    <ExchangeLogo id={f.exchange} size={15} />
                    {EXCHANGES.find((e) => e.id === f.exchange)?.name}
                    <span className="badge badge--soon" style={{ marginTop: 0 }}>
                      {f.mode.toUpperCase()}
                    </span>
                  </span>
                  <span className="list__sub num">
                    {t('md.coverage', { quoted: f.quoted, symbols: f.symbols })}
                    {f.latencyMs !== null && ` · ${t('md.latency', { ms: f.latencyMs })}`}
                    {f.reconnects > 0 && ` · ${t('md.reconnects', { count: f.reconnects })}`}
                  </span>
                  {f.lastError && (
                    <span className="list__sub" style={{ color: 'var(--red)' }}>
                      {f.lastError.slice(0, 90)}
                    </span>
                  )}
                </span>
                <span />
                <span className="list__meta" style={{ color: tone }}>
                  {t(`md.status_${f.status}`)}
                </span>
              </div>
            );
          })}
        </Section>
      )}

      {engine && engine.fundingUnsupported.length > 0 && (
        <Section title={t('md.fundingUnsupported')} hint={t('md.fundingUnsupportedHint')}>
          {engine.fundingUnsupported.map((id) => (
            <div className="list__item" key={id}>
              <span
                className="list__title"
                style={{ display: 'flex', alignItems: 'center', gap: 7 }}
              >
                <ExchangeLogo id={id} size={15} />
                {EXCHANGES.find((e) => e.id === id)?.name}
              </span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин ${s % 60} с`;
  return `${s} с`;
}
