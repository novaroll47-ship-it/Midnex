/**
 * Экран «Боты»: список ботов с их состоянием. Пока торговля выключена —
 * оба «Скоро», но настройки уже можно посмотреть.
 */
import { useTranslation } from 'react-i18next';

import { ChevronRightIcon } from '../icons';
import { haptic } from '../lib/telegram';

export function BotsScreen({ onOpen }: { onOpen: (view: 'botSpread' | 'botFunding') => void }) {
  const { t } = useTranslation();
  const bots: { view: 'botSpread' | 'botFunding'; name: string; sub: string }[] = [
    { view: 'botSpread', name: t('bots.spreadName'), sub: t('bots.spreadPanelSub') },
    { view: 'botFunding', name: t('bots.fundingName'), sub: t('bots.fundingPanelSub') },
  ];
  return (
    <div className="stack">
      <p className="hint">{t('bots.screenHint')}</p>
      <section className="card list">
        {bots.map((b) => (
          <button
            key={b.view}
            type="button"
            className="list__item"
            onClick={() => {
              haptic('tap');
              onOpen(b.view);
            }}
          >
            <span>
              <span className="list__title">{b.name}</span>
              <span className="list__sub">{b.sub}</span>
            </span>
            <span className="list__meta">{t('settings.soon')}</span>
            <ChevronRightIcon className="list__chevron" size={16} />
          </button>
        ))}
      </section>
    </div>
  );
}
