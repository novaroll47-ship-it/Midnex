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
  /** Без торговли вкладка «Позиции» уступает место «Алертам». */
  trading: boolean;
  onChange: (tab: Tab) => void;
}) {
  const { t } = useTranslation();
  const tabs = ALL_TABS.filter((tab) => trading || tab.id !== 'positions');
  return (
    <nav className="nav" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
      {tabs.map(({ id, Icon, labelKey }) => (
        <button
          key={id}
          type="button"
          className={`nav__item${active === id ? ' nav__item--active' : ''}`}
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
