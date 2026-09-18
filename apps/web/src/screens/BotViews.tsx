/**
 * Экраны ботов: «Спред» и «Фандинг».
 *
 * Оба бота ещё не торгуют, поэтому экраны заперты: настройки видны целиком —
 * пользователь понимает, что получит, — но ни один элемент не реагирует.
 * Когда сервер включит торговлю (features.trading), замок снимается и те же
 * экраны становятся рабочими: значения «Спреда» уже хранятся на сервере.
 */
import { DEFAULT_FUNDING_BOT, EXCHANGES } from '@cs/shared';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckRow, NumberRow, Section, ToggleRow } from '../components/Form';
import { ClockIcon } from '../icons';
import type { SettingsController } from '../lib/useSettings';
import { GeneralView, NotificationsView, OpportunitiesView, RiskView } from './SettingsDetail';

function Locked({ locked, children }: { locked: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="stack">
      {locked && (
        <section className="card notice">
          <ClockIcon className="notice__icon" />
          <span>{t('bots.lockedNote')}</span>
        </section>
      )}
      <div className={`stack${locked ? ' locked' : ''}`} aria-disabled={locked}>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- бот «Спред»

export function BotSpreadView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const locked = !(settings.data?.features?.trading ?? false);
  return (
    <Locked locked={locked}>
      <section className="card card--pad bot-about">
        <div className="bot-about__title">{t('bots.spreadTitle')}</div>
        <div className="bot-about__text">{t('bots.spreadAbout')}</div>
      </section>
      <GeneralView settings={settings} />
      <OpportunitiesView settings={settings} />
      <RiskView settings={settings} />
      <NotificationsView settings={settings} />
    </Locked>
  );
}

// ------------------------------------------------------------- бот «Фандинг»

/**
 * Настройки фандинг-бота пока только показываются: хранить их на сервере
 * начнём вместе с самим ботом, а до тех пор здесь значения по умолчанию.
 */
export function BotFundingView({ settings }: { settings: SettingsController }) {
  const { t } = useTranslation();
  const locked = !(settings.data?.features?.trading ?? false);
  const f = DEFAULT_FUNDING_BOT;
  const noop = () => {};

  return (
    <Locked locked={locked}>
      <section className="card card--pad bot-about">
        <div className="bot-about__title">{t('bots.fundingTitle')}</div>
        <div className="bot-about__text">{t('bots.fundingAbout')}</div>
      </section>

      <Section title={t('sd.botState')}>
        <ToggleRow
          title={t('sd.running')}
          sub={t('bots.fundingRunningSub')}
          value={false}
          onChange={noop}
        />
      </Section>

      <Section title={t('sd.exchanges')} hint={t('bots.fundingExchangesHint')}>
        {EXCHANGES.map((ex) => (
          <CheckRow
            key={ex.id}
            title={ex.name}
            checked={f.exchanges.includes(ex.id)}
            onToggle={noop}
          />
        ))}
      </Section>

      <Section title={t('bots.fundingEntry')} hint={t('bots.fundingEntryHint')}>
        <NumberRow
          title={t('bots.minRateDiff')}
          sub={t('bots.minRateDiffSub')}
          value={f.minRateDiffPct}
          unit="%"
          step={0.01}
          onCommit={noop}
        />
        <NumberRow
          title={t('bots.minApr')}
          sub={t('bots.minAprSub')}
          value={f.minAprPct}
          unit="%"
          onCommit={noop}
        />
        <NumberRow
          title={t('bots.maxEntrySpread')}
          sub={t('bots.maxEntrySpreadSub')}
          value={f.maxEntrySpreadPct}
          unit="%"
          step={0.05}
          onCommit={noop}
        />
      </Section>

      <Section title={t('bots.fundingHold')} hint={t('bots.fundingHoldHint')}>
        <NumberRow
          title={t('bots.minPayouts')}
          sub={t('bots.minPayoutsSub')}
          value={f.minPayouts}
          unit={t('bots.unitPayouts')}
          onCommit={noop}
        />
        <NumberRow
          title={t('bots.exitBelow')}
          sub={t('bots.exitBelowSub')}
          value={f.exitBelowPct}
          unit="%"
          step={0.01}
          onCommit={noop}
        />
      </Section>

      <Section title={t('bots.size')}>
        <NumberRow
          title={t('sd.defaultNotional')}
          value={f.notionalUsdt}
          unit="USDT"
          onCommit={noop}
        />
        <NumberRow
          title={t('sd.defaultLeverage')}
          sub={t('bots.fundingLeverageSub')}
          value={f.leverage}
          unit="x"
          onCommit={noop}
        />
        <NumberRow
          title={t('bots.maxPositions')}
          value={f.maxPositions}
          unit={t('positions.pcs')}
          onCommit={noop}
        />
      </Section>

      <Section title={t('sd.notifyEvents')}>
        <ToggleRow title={t('bots.notifyPayout')} value onChange={noop} />
        <ToggleRow title={t('sd.notifyOpened')} value onChange={noop} />
        <ToggleRow title={t('sd.notifyClosed')} value onChange={noop} />
      </Section>
    </Locked>
  );
}
