import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AppHeader } from './components/AppHeader';
import { BottomNav, type Tab } from './components/BottomNav';
import { backButton, initTelegram, isBrowserFallback } from './lib/telegram';
import { useSettings } from './lib/useSettings';
import { PositionDetailScreen, type PositionView } from './screens/PositionDetail';
import { PositionsScreen } from './screens/PositionsScreen';
import { ScreenerScreen } from './screens/ScreenerScreen';
import { SettingsDetail, settingsViewTitle, type SettingsView } from './screens/SettingsDetail';
import { SettingsScreen } from './screens/SettingsScreen';

/**
 * Навигация приложения.
 *
 * Полноценный роутер здесь не нужен: экранов немного, а Telegram и так не
 * даёт адресной строки. Достаточно вкладки и не более одного подэкрана
 * поверх неё — ровно так устроены нативные настройки Telegram.
 */
type Route =
  | { kind: 'tab' }
  | { kind: 'settings'; view: SettingsView }
  | { kind: 'position'; id: string; view: PositionView };

export function App() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('screener');
  const [route, setRoute] = useState<Route>({ kind: 'tab' });
  const scrollRef = useRef<HTMLElement>(null);
  const settings = useSettings();

  useEffect(() => {
    initTelegram();
  }, []);

  const goBack = useCallback(() => setRoute({ kind: 'tab' }), []);

  // Аппаратная кнопка «назад» Telegram должна закрывать подэкран, а не всё
  // приложение — иначе пользователь вылетает из мини-аппа одним нажатием.
  useEffect(() => {
    if (route.kind === 'tab') return backButton(false);
    return backButton(true, goBack);
  }, [route.kind, goBack]);

  // Каждый экран открывается сверху, а не там, где его оставили в прошлый раз.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab, route]);

  function switchTab(next: Tab) {
    setRoute({ kind: 'tab' });
    setTab(next);
  }

  const headerTitle = useMemo(() => {
    if (route.kind === 'settings') return settingsViewTitle(route.view, t);
    if (route.kind === 'position') {
      return t(route.view === 'details' ? 'positions.details' : 'positions.edit');
    }
    return undefined;
  }, [route, t]);

  // Скринер сам управляет прокруткой: шапка таблицы стоит на месте, едет
  // только список монет. Остальные экраны скроллятся целиком.
  const fixedLayout = route.kind === 'tab' && tab === 'screener';

  return (
    <div className="app">
      <AppHeader title={headerTitle} onBack={route.kind === 'tab' ? undefined : goBack} />

      <main
        className={`app__body${fixedLayout ? ' app__body--fixed' : ''}`}
        ref={scrollRef}
        key={`${tab}:${route.kind}`}
      >
        {isBrowserFallback && route.kind === 'tab' && (
          <div className="dev-banner">{t('app.devBanner')}</div>
        )}

        {route.kind === 'settings' && <SettingsDetail view={route.view} settings={settings} />}

        {route.kind === 'position' && (
          <PositionDetailScreen id={route.id} view={route.view} />
        )}

        {route.kind === 'tab' && tab === 'screener' && (
          <ScreenerScreen
            plan={settings.data?.plan ?? 'unlimited'}
            minSpreadPct={settings.data?.bot.minSpreadPct}
            refreshMs={settings.data?.bot.refreshMs ?? 1000}
            onOpenSettings={() => {
              setTab('settings');
              setRoute({ kind: 'settings', view: 'general' });
            }}
          />
        )}

        {route.kind === 'tab' && tab === 'positions' && (
          <PositionsScreen
            onOpenDetails={(id) => setRoute({ kind: 'position', id, view: 'details' })}
            onOpenEdit={(id) => setRoute({ kind: 'position', id, view: 'edit' })}
          />
        )}

        {route.kind === 'tab' && tab === 'settings' && (
          <SettingsScreen
            settings={settings}
            onOpen={(view) => setRoute({ kind: 'settings', view })}
          />
        )}
      </main>

      <BottomNav active={tab} onChange={switchTab} />
    </div>
  );
}
