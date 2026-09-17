/**
 * Модули обучения — конфигурация, а не код интерфейса.
 *
 * Каждый модуль — именованная версия (screener_basics_v1, alerts_v1…) со
 * списком шагов; шаг указывает на элемент интерфейса через data-tour и
 * ключ текста. Новая фича — новый модуль здесь плюс data-tour на её
 * элементах; старые пользователи увидят только его, потому что пройденные
 * модули хранятся на сервере.
 *
 * Шаг с элементом, которого сейчас нет на экране (например, на другой
 * вкладке), пропускается, а не ломает тур.
 */
export interface TourStep {
  /** Селектор элемента: [data-tour="…"]. */
  target: string;
  /** Ключ i18n заголовка и текста: tour.<module>.<step>.title / .text */
  key: string;
  /** Вкладка, на которой живёт элемент — тур переключит её сам. */
  tab?: 'screener' | 'alerts' | 'settings';
}

export interface TourModule {
  id: string;
  /** С какой вкладки начинать. */
  tab: 'screener' | 'alerts' | 'settings';
  steps: TourStep[];
}

export const TOUR_MODULES: TourModule[] = [
  {
    id: 'screener_basics_v1',
    tab: 'screener',
    steps: [
      { target: '[data-tour="panel"]', key: 'panel', tab: 'screener' },
      { target: '[data-tour="subscription"]', key: 'subscription', tab: 'screener' },
      { target: '[data-tour="search"]', key: 'search', tab: 'screener' },
      { target: '[data-tour="filters"]', key: 'filters', tab: 'screener' },
      { target: '[data-tour="sort"]', key: 'sort', tab: 'screener' },
      { target: '[data-tour="row"]', key: 'row', tab: 'screener' },
      { target: '[data-tour="nav-alerts"]', key: 'alertsTab', tab: 'screener' },
    ],
  },
  {
    id: 'alerts_v1',
    tab: 'alerts',
    steps: [
      { target: '[data-tour="alerts-add"]', key: 'add', tab: 'alerts' },
      { target: '[data-tour="alerts-list"]', key: 'list', tab: 'alerts' },
    ],
  },
];

/** Что показать: активные модули минус пройденные, в порядке объявления. */
export function pendingModules(completed: string[]): TourModule[] {
  const done = new Set(completed);
  return TOUR_MODULES.filter((m) => !done.has(m.id));
}
