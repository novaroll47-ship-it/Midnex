import { useTranslation } from 'react-i18next';

import { BellIcon, BriefcaseIcon, ChartIcon, GearIcon } from '../icons';
import { haptic } from '../lib/telegram';

export type Tab = 'screener' | 'alerts' | 'positions' | 'settings';

const ALL_TABS: { id: Tab; Icon: typeof ChartIcon; labelKey: string }[] = [
  { id: 'screener', Icon: ChartIcon, labelKey: 'nav.screener' },
  { id: 'alerts', Icon: BellIcon, labelKey: 'nav.alerts' },
  { id: 'positions', Icon: BriefcaseIcon, labelKey: 'nav.positions' },
  { id: 'settings', Icon: GearIcon, labelKey: 'nav.settings' },
];

export function BottomNav({
  active,
  trading,
  onChange,
}: {
  active: Tab;
  /** Пока торговля выключена, «Позиции» ведут на экран «Скоро». */
  trading: boolean;
  onChange: (tab: Tab) => void;
}) {
  const { t } = useTranslation();
  void trading;
  // Алерты живут плиткой «Уведомления» на панели скринера, а не вкладкой.
  const tabs = ALL_TABS.filter((tab) => tab.id !== 'alerts');
  return (
    <nav className="nav" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
      {tabs.map(({ id, Icon, labelKey }) => (
        <button
          key={id}
          type="button"
          className={`nav__item${active === id ? ' nav__item--active' : ''}`}
          data-tour={`nav-${id}`}
          onClick={() => {
            haptic('tap');
            onChange(id);
          }}
        >
          <Icon size={21} />
          <span>{t(labelKey)}</span>
        </button>
      ))}
    </nav>
  );
}
