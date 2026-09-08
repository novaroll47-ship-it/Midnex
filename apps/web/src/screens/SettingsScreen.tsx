/** Экран «Настройки» — макет docs/mockup-settings.png. Список разделов. */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ChevronRightIcon, LogoutIcon } from '../icons';
import { LANGUAGES, currentLanguage } from '../i18n';
import { haptic } from '../lib/telegram';
import type { SettingsController } from '../lib/useSettings';
import type { SettingsView } from './SettingsDetail';

export function SettingsScreen({
  settings,
  onOpen,
}: {
  settings: SettingsController;
  onOpen: (view: SettingsView) => void;
}) {
  const { t } = useTranslation();
  const [sounds, setSounds] = useState(true);

  const data = settings.data;
  const connectedKeys = (data?.apiKeys ?? []).filter((k) => k.connected).length;
  const lang = currentLanguage();
  const langLabel = LANGUAGES.find((l) => l.code === lang)?.label ?? lang;

  const modeLabel = data
    ? t(
        data.bot.mode === 'auto'
          ? 'sd.modeAuto'
          : data.bot.mode === 'semi'
            ? 'sd.modeSemi'
            : 'sd.modeScreener',
      )
    : '';

  return (
    <div className="stack">
      <div className="section-label">{t('settings.botSection')}</div>
      <section className="card list">
        <Row
          title={t('settings.generalTitle')}
          sub={t('settings.generalSub')}
          meta={modeLabel}
          metaGreen
          onClick={() => onOpen('general')}
        />
        <Row
          title={t('settings.opportunitiesTitle')}
          sub={t('settings.opportunitiesSub')}
          meta={data ? `${data.bot.enabledExchanges.length}/8` : undefined}
          onClick={() => onOpen('opportunities')}
        />
        <Row
          title={t('settings.notificationsTitle')}
          sub={t('settings.notificationsSub')}
          meta={data ? t(data.notifications.enabled ? 'sd.on' : 'sd.off') : undefined}
          metaGreen={data?.notifications.enabled}
          onClick={() => onOpen('notifications')}
        />
        <Row
          title={t('settings.riskTitle')}
          sub={t('settings.riskSub')}
          meta={data ? `${data.risk.maxOpenPairs} / ${data.risk.maxLeverage}x` : undefined}
          onClick={() => onOpen('risk')}
        />
        <Row
          title={t('settings.subscriptionTitle')}
          sub={t('settings.subscriptionSub')}
          meta={data ? t(`sd.plan_${data.plan}`) : undefined}
          metaGreen
          onClick={() => onOpen('subscription')}
        />
        {/* Задел под ТЗ §7.2 — стратегия появится позже, но место в UI занято сразу. */}
        <Row
          title={t('settings.fundingTitle')}
          sub={t('settings.fundingSub')}
          badge={t('settings.soon')}
          disabled
        />
      </section>

      <div className="section-label">{t('settings.securitySection')}</div>
      <section className="card list">
        <Row
          title={t('settings.apiKeysTitle')}
          sub={t('settings.apiKeysSub')}
          meta={t('settings.apiKeysMeta', { count: connectedKeys })}
          metaGreen
          onClick={() => onOpen('apikeys')}
        />
        <Row
          title={t('settings.sessionsTitle')}
          sub={t('settings.sessionsSub')}
          onClick={() => onOpen('sessions')}
        />
      </section>

      <div className="section-label">{t('settings.appSection')}</div>
      <section className="card list">
        <Row
          title={t('settings.themeTitle')}
          sub={t('settings.themeSub')}
          meta={t('settings.themeDark')}
          metaGreen
          onClick={() => onOpen('theme')}
        />
        <Row
          title={t('settings.languageTitle')}
          sub={t('settings.languageSub')}
          meta={langLabel}
          metaGreen
          onClick={() => onOpen('language')}
        />
        <Row
          title={t('settings.soundsTitle')}
          sub={t('settings.soundsSub')}
          control={
            <button
              type="button"
              className={`switch${sounds ? ' switch--on' : ''}`}
              role="switch"
              aria-checked={sounds}
              aria-label={t('settings.soundsTitle')}
              onClick={() => {
                setSounds((v) => !v);
                haptic('tap');
              }}
            >
              <span className="switch__knob" />
            </button>
          }
        />
      </section>

      <section className="card list">
        <Row
          title={t('settings.aboutTitle')}
          sub={t('settings.aboutSub')}
          onClick={() => onOpen('about')}
        />
      </section>

      <button className="logout" type="button">
        {t('settings.logout')}
        <LogoutIcon />
      </button>
    </div>
  );
}

function Row({
  title,
  sub,
  meta,
  metaGreen,
  badge,
  control,
  disabled,
  onClick,
}: {
  title: string;
  sub?: string;
  meta?: string;
  metaGreen?: boolean;
  badge?: string;
  control?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span>
        <span className="list__title">
          {title}
          {badge && (
            <span className="badge badge--soon" style={{ marginLeft: 8, marginTop: 0 }}>
              {badge}
            </span>
          )}
        </span>
        {sub && <span className="list__sub">{sub}</span>}
      </span>
      {meta ? (
        <span className={`list__meta${metaGreen ? ' list__meta--green' : ''}`}>{meta}</span>
      ) : (
        <span />
      )}
      {control ?? <ChevronRightIcon className="list__chevron" />}
    </>
  );

  if (control || disabled || !onClick) {
    return (
      <div className={`list__item${disabled ? ' list__item--disabled' : ''}`}>{content}</div>
    );
  }

  return (
    <button
      className="list__item"
      type="button"
      onClick={() => {
        haptic('tap');
        onClick();
      }}
    >
      {content}
    </button>
  );
}
