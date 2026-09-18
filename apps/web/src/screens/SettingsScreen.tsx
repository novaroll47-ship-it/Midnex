/** Экран «Настройки» — макет docs/mockup-settings.png. Список разделов. */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ChevronRightIcon, LogoutIcon } from '../icons';
import { LANGUAGES, currentLanguage } from '../i18n';
import { api } from '../lib/api';
import { currentThemeMode } from '../lib/theme';
import { closeApp, haptic } from '../lib/telegram';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Sheet } from '../components/Sheet';
import { TOUR_MODULES } from '../onboarding/modules';
import type { SettingsController } from '../lib/useSettings';
import type { SettingsView } from './SettingsDetail';

export function SettingsScreen({
  settings,
  trading,
  onOpen,
  onReplayTour,
}: {
  settings: SettingsController;
  /** false — этап «только скринер»: торговые разделы показаны, но заперты. */
  trading: boolean;
  onOpen: (view: SettingsView) => void;
  onReplayTour: (moduleId: string) => void;
}) {
  const { t } = useTranslation();

  // Раздел, доступный только с торговлей: без неё — бейдж «Скоро» и никакой реакции.
  const locked = (view: SettingsView) =>
    trading ? { onClick: () => onOpen(view) } : { badge: t('settings.soon'), disabled: true };
  const [sounds, setSounds] = useState(true);
  const [logoutAsk, setLogoutAsk] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);

  // Личность в мини-приложении даёт Telegram, «выйти» из неё нельзя. Что
  // можно — забыть остальные устройства и закрыть приложение.
  async function logout() {
    setLogoutBusy(true);
    try {
      await api.logoutOthers();
    } catch {
      // Сеть упала — приложение всё равно закрываем, как просили.
    }
    closeApp();
  }

  const data = settings.data;
  const connectedKeys = (data?.apiKeys ?? []).filter((k) => k.connected).length;
  const lang = currentLanguage();
  const langLabel = LANGUAGES.find((l) => l.code === lang)?.label ?? lang;

  const modeLabel = data ? t(data.bot.mode === 'auto' ? 'sd.modeAuto' : 'sd.modeSemi') : '';

  return (
    <div className="stack">
      <div className="section-label">{t('settings.accountSection')}</div>
      <section className="card list">
        <Row
          title={t('settings.subscriptionTitle')}
          sub={t('settings.subscriptionSub')}
          meta={
            data
              ? data.subscription.active
                ? t('sub.metaActive', { days: data.subscription.daysLeft })
                : t('sub.metaInactive')
              : undefined
          }
          metaGreen={data?.subscription.active}
          onClick={() => onOpen('subscription')}
        />
      </section>

      {/* Модуль ботов. Пока торговля выключена — это список того, что будет:
          каждый бот получит свой экран настроек, когда появится. */}
      <div className="section-label">{t('settings.botsSection')}</div>
      <section className="card list">
        <Row
          title={t('bots.spreadName')}
          sub={t('settings.botTradingSub')}
          meta={trading ? undefined : t('settings.soon')}
          onClick={() => onOpen('botSpread')}
        />
        <Row
          title={t('bots.fundingName')}
          sub={t('settings.botFundingSub')}
          meta={t('settings.soon')}
          onClick={() => onOpen('botFunding')}
        />
      </section>

      <div className="section-label">{t('settings.securitySection')}</div>
      <section className="card list">
        <Row
          title={t('settings.apiKeysTitle')}
          sub={t('settings.apiKeysSub')}
          meta={t('settings.apiKeysMeta', { count: connectedKeys })}
          metaGreen
          {...locked('apikeys')}
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
          meta={t(`sd.theme_${currentThemeMode()}`)}
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
        {data?.features.admin && (
          <Row title={t('pairs.title')} sub={t('pairs.sub')} onClick={() => onOpen('pairs')} />
        )}
        <Row
          title={t('settings.marketTitle')}
          sub={t('settings.marketSub')}
          onClick={() => onOpen('market')}
        />
        <Row
          title={t('settings.helpTitle')}
          sub={t('settings.helpSub')}
          onClick={() => setHelpOpen(true)}
        />
        <Row
          title={t('settings.aboutTitle')}
          sub={t('settings.aboutSub')}
          onClick={() => onOpen('about')}
        />
      </section>

      <button className="logout" type="button" onClick={() => setLogoutAsk(true)}>
        {t('settings.logout')}
        <LogoutIcon />
      </button>

      {helpOpen && (
        <Sheet
          title={t('settings.helpTitle')}
          description={t('settings.helpHint')}
          onClose={() => setHelpOpen(false)}
        >
          <div className="sheet__group">
            {TOUR_MODULES.map((m) => (
              <button
                key={m.id}
                type="button"
                className="sheet__row sheet__row--tap"
                onClick={() => {
                  setHelpOpen(false);
                  onReplayTour(m.id);
                }}
              >
                <span>
                  <span className="sheet__row-title">{t(`tour.${m.id}.name`)}</span>
                  <span className="sheet__row-sub">
                    {data?.onboarding?.completed.includes(m.id)
                      ? t('settings.tourDone')
                      : t('settings.tourNew')}
                  </span>
                </span>
                <span style={{ color: 'var(--blue)' }}>{t('settings.tourReplay')}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {logoutAsk && (
        <ConfirmDialog
          title={t('settings.logout')}
          message={t('settings.logoutConfirm')}
          confirmLabel={t('settings.logout')}
          danger
          busy={logoutBusy}
          onConfirm={logout}
          onCancel={() => setLogoutAsk(false)}
        />
      )}
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
    return <div className={`list__item${disabled ? ' list__item--disabled' : ''}`}>{content}</div>;
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
