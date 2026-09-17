import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AppHeader } from './components/AppHeader';
import { BottomNav, type Tab } from './components/BottomNav';
import { api } from './lib/api';
import { backButton, initTelegram, isBrowserFallback, isTelegram } from './lib/telegram';
import { initTheme } from './lib/theme';
import { useSettings } from './lib/useSettings';
import { CoinDetailScreen } from './screens/CoinDetailScreen';
import { CoachMarks } from './components/CoachMarks';
import { pendingModules } from './onboarding/modules';
import { AlertsScreen } from './screens/AlertsScreen';
import { ComingSoonScreen } from './screens/ComingSoonScreen';
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
  | { kind: 'position'; id: string; view: PositionView }
  | { kind: 'coin'; base: string };

export function App() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('screener');
  const [route, setRoute] = useState<Route>({ kind: 'tab' });
  const scrollRef = useRef<HTMLElement>(null);
  const settings = useSettings();

  // Обход авторизации включается на сервере, а не в браузере, поэтому
  // спрашиваем сервер: иначе плашка врёт про то, чего нет. /api/health —
  // единственный маршрут без авторизации, он для этого и открыт.
  const [devBypass, setDevBypass] = useState<boolean | null>(null);

  useEffect(() => {
    initTelegram();
    initTheme();
    api
      .health()
      .then((h) => setDevBypass(h.devFakeUser))
      .catch(() => setDevBypass(null));
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
    if (route.kind === 'coin') return route.base;
    return undefined;
  }, [route, t]);

  // Скринер сам управляет прокруткой: шапка таблицы стоит на месте, едет
  // только список монет. Остальные экраны скроллятся целиком.
  const fixedLayout = route.kind === 'tab' && tab === 'screener';

  // Пока не включена торговля — наружу только скринер; остальное «Скоро».
  const trading = settings.data?.features?.trading ?? false;
  // Монета, для которой открыть форму алерта (переход с экрана монеты).
  const [alertPreset, setAlertPreset] = useState<string | null>(null);

  // Обучение: первый непройденный модуль показываем, когда открыта вкладка.
  // Ручной перезапуск из настроек кладёт id модуля в replayModule.
  const [replayModule, setReplayModule] = useState<string | null>(null);
  const completedModules = settings.data?.onboarding?.completed;
  const tourModule = useMemo(() => {
    if (replayModule) return pendingModules([]).find((m) => m.id === replayModule) ?? null;
    if (!completedModules || route.kind !== 'tab') return null;
    return pendingModules(completedModules)[0] ?? null;
  }, [replayModule, completedModules, route.kind]);
  const switchTabForTour = useCallback((next: Tab) => {
    setRoute({ kind: 'tab' });
    setTab(next);
  }, []);

  return (
    <div className="app">
      <AppHeader title={headerTitle} onBack={route.kind === 'tab' ? undefined : goBack} />

      <main
        className={`app__body${fixedLayout ? ' app__body--fixed' : ''}${
          isTelegram && !headerTitle ? ' app__body--bare' : ''
        }`}
        ref={scrollRef}
        key={`${tab}:${route.kind}`}
      >
        {isBrowserFallback && route.kind === 'tab' && devBypass !== null && (
          <div className="dev-banner">{devBypass ? t('app.devBanner') : t('app.needTelegram')}</div>
        )}

        {route.kind === 'settings' && <SettingsDetail view={route.view} settings={settings} />}

        {route.kind === 'position' && <PositionDetailScreen id={route.id} view={route.view} />}

        {route.kind === 'coin' && (
          <CoinDetailScreen
            base={route.base}
            onAlert={(base) => {
              setAlertPreset(base);
              setRoute({ kind: 'tab' });
              setTab('alerts');
            }}
          />
        )}

        {route.kind === 'tab' && tab === 'screener' && (
          <ScreenerScreen
            plan={settings.data?.plan ?? 'unlimited'}
            trading={trading}
            subscription={settings.data?.subscription}
            minSpreadPct={settings.data?.bot.minSpreadPct}
            refreshMs={settings.data?.bot.refreshMs ?? 1000}
            onOpenCoin={(base) => setRoute({ kind: 'coin', base })}
            onOpenSubscription={() => {
              setTab('settings');
              setRoute({ kind: 'settings', view: 'subscription' });
            }}
            onOpenBot={(view) => {
              setTab('settings');
              setRoute({ kind: 'settings', view });
            }}
          />
        )}

        {route.kind === 'tab' && tab === 'alerts' && (
          <AlertsScreen
            presetBase={alertPreset}
            onPresetConsumed={() => setAlertPreset(null)}
            onOpenSubscription={() => {
              setTab('settings');
              setRoute({ kind: 'settings', view: 'subscription' });
            }}
          />
        )}

        {route.kind === 'tab' && tab === 'positions' && !trading && (
          <ComingSoonScreen what="positions" />
        )}

        {route.kind === 'tab' && tab === 'positions' && trading && (
          <PositionsScreen
            onOpenDetails={(id) => setRoute({ kind: 'position', id, view: 'details' })}
            onOpenEdit={(id) => setRoute({ kind: 'position', id, view: 'edit' })}
          />
        )}

        {route.kind === 'tab' && tab === 'settings' && (
          <SettingsScreen
            settings={settings}
            trading={trading}
            onOpen={(view) => setRoute({ kind: 'settings', view })}
            onReplayTour={(id) => {
              setRoute({ kind: 'tab' });
              setReplayModule(id);
            }}
          />
        )}
      </main>

      <BottomNav active={tab} trading={trading} onChange={switchTab} />

      {tourModule && (
        <CoachMarks
          key={tourModule.id}
          module={tourModule}
          onSwitchTab={switchTabForTour}
          onDone={() => {
            setReplayModule(null);
            if (!completedModules?.includes(tourModule.id)) {
              settings.setOnboarding([...(completedModules ?? []), tourModule.id]);
            }
          }}
        />
      )}
    </div>
  );
}
