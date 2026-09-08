import { useTranslation } from 'react-i18next';

import { BriefcaseIcon, ChartIcon, GearIcon } from '../icons';
import { haptic } from '../lib/telegram';

export type Tab = 'screener' | 'positions' | 'settings';

const TABS: { id: Tab; Icon: typeof ChartIcon; labelKey: string }[] = [
  { id: 'screener', Icon: ChartIcon, labelKey: 'nav.screener' },
  { id: 'positions', Icon: BriefcaseIcon, labelKey: 'nav.positions' },
  { id: 'settings', Icon: GearIcon, labelKey: 'nav.settings' },
];

export function BottomNav({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  const { t } = useTranslation();
  return (
    <nav className="nav">
      {TABS.map(({ id, Icon, labelKey }) => (
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
