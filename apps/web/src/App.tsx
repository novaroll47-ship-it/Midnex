import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AppHeader } from './components/AppHeader';
import { BottomNav, type Tab } from './components/BottomNav';
import { api, ApiError } from './lib/api';
import { backButton, initTelegram, isBrowserFallback, isTelegram } from './lib/telegram';
import { initTheme } from './lib/theme';
import { primeCache } from './lib/usePolling';
import { useSettings } from './lib/useSettings';
import { CoinDetailScreen } from './screens/CoinDetailScreen';
import { CoachMarks } from './components/CoachMarks';
import { Splash } from './components/Splash';
import { pendingModules } from './onboarding/modules';
import { AlertsScreen } from './screens/AlertsScreen';
import { BotsScreen } from './screens/BotsScreen';
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
  | { kind: 'coin'; base: string }
  | { kind: 'alerts' }
  | { kind: 'bots' };

interface NavState {
  tab: Tab;
  route: Route;
}

const HISTORY_MAX = 30;

export function App() {
  const { t } = useTranslation();
  // Вкладка и экран — одно состояние, плюс история переходов: «назад» ведёт
  // туда, откуда пришли, будь то подэкран или другая вкладка.
  const [nav, setNav] = useState<NavState>({ tab: 'screener', route: { kind: 'tab' } });
  // Текущее состояние в ref: история пишется вне updater-функции, которую
  // React в dev-режиме вызывает дважды.
  const navRef = useRef(nav);
  navRef.current = nav;
  const historyRef = useRef<NavState[]>([]);
  const [historyLen, setHistoryLen] = useState(0);
  const { tab, route } = nav;
  const go = useCallback((next: Partial<NavState>) => {
    const cur = navRef.current;
    const target = { ...cur, ...next };
    if (target.tab === cur.tab && JSON.stringify(target.route) === JSON.stringify(cur.route))
      return;
    historyRef.current.push(cur);
    if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift();
    setHistoryLen(historyRef.current.length);
    navRef.current = target;
    setNav(target);
  }, []);
  const setTab = useCallback((next: Tab) => go({ tab: next, route: { kind: 'tab' } }), [go]);
  const setRoute = useCallback((next: Route) => go({ route: next }), [go]);
  const scrollRef = useRef<HTMLElement>(null);
  const settings = useSettings();

  // Загрузочный экран: настройки и первый снимок скринера — потом интерфейс.
  const [primed, setPrimed] = useState(false);
  const [primeError, setPrimeError] = useState<string | null>(null);
  const [primeAttempt, setPrimeAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setPrimeError(null);
    api
      .screener()
      .then((snap) => {
        if (!alive) return;
        primeCache('screener', snap);
        setPrimed(true);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setPrimeError(
          err instanceof ApiError && err.status === 401
            ? t('app.unauthorized')
            : t('app.loadError'),
        );
      });
    return () => {
      alive = false;
    };
  }, [primeAttempt, t]);
  const ready = primed && settings.data !== null;

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

  const goBack = useCallback(() => {
    const prev = historyRef.current.pop();
    setHistoryLen(historyRef.current.length);
    const target = prev ?? { ...navRef.current, route: { kind: 'tab' as const } };
    navRef.current = target;
    setNav(target);
  }, []);
  const canGoBack = historyLen > 0 || route.kind !== 'tab';

  // Кнопка «назад» Telegram ведёт по истории: закрывает подэкран или
  // возвращает на прошлую вкладку — и не выкидывает из мини-аппа, пока
  // есть куда вернуться.
  useEffect(() => {
    if (!canGoBack) return backButton(false);
    return backButton(true, goBack);
  }, [canGoBack, goBack]);

  // Каждый экран открывается сверху, а не там, где его оставили в прошлый раз.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab, route]);

  function switchTab(next: Tab) {
    setTab(next);
  }

  const headerTitle = useMemo(() => {
    if (route.kind === 'settings') return settingsViewTitle(route.view, t);
    if (route.kind === 'position') {
      return t(route.view === 'details' ? 'positions.details' : 'positions.edit');
    }
    if (route.kind === 'coin') return route.base;
    if (route.kind === 'alerts') return t('screener.tileAlerts');
    if (route.kind === 'bots') return t('screener.tileBots');
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
    // Тур живёт на вкладках и на экране уведомлений (его модуль ведёт туда сам).
    if (!completedModules || (route.kind !== 'tab' && route.kind !== 'alerts')) return null;
    return pendingModules(completedModules)[0] ?? null;
  }, [replayModule, completedModules, route.kind]);
  // Шаг тура «алерты» открывает экран уведомлений — он больше не вкладка.
  const switchTabForTour = useCallback(
    (next: Tab) =>
      next === 'alerts' ? go({ tab: 'screener', route: { kind: 'alerts' } }) : setTab(next),
    [go, setTab],
  );

  if (!ready) {
    const steps = Number(settings.data !== null) + Number(primed);
    return (
      <div className="app">
        <Splash
          progress={0.15 + (steps / 2) * 0.85}
          error={primeError ?? (settings.error ? t('app.loadError') : null)}
          onRetry={() => {
            setPrimeAttempt((n) => n + 1);
            settings.reload();
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <AppHeader title={headerTitle} onBack={canGoBack ? goBack : undefined} />

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

        {route.kind === 'settings' && (
          <SettingsDetail
            view={route.view}
            settings={settings}
            onOpen={(view) => setRoute({ kind: 'settings', view })}
          />
        )}

        {route.kind === 'position' && <PositionDetailScreen id={route.id} view={route.view} />}

        {route.kind === 'coin' && (
          <CoinDetailScreen
            base={route.base}
            onAlert={(base) => {
              setAlertPreset(base);
              go({ route: { kind: 'alerts' } });
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
            view={settings.data?.ui.view ?? 'list'}
            onSetView={(view) => settings.setUi({ view })}
            onOpenCoin={(base) => setRoute({ kind: 'coin', base })}
            onOpenSubscription={() =>
              go({ tab: 'settings', route: { kind: 'settings', view: 'subscription' } })
            }
            onOpenBots={() => go({ route: { kind: 'bots' } })}
            onOpenAlerts={() => go({ route: { kind: 'alerts' } })}
          />
        )}

        {route.kind === 'bots' && (
          <BotsScreen
            onOpen={(view) => go({ tab: 'settings', route: { kind: 'settings', view } })}
          />
        )}

        {route.kind === 'alerts' && (
          <AlertsScreen
            presetBase={alertPreset}
            onPresetConsumed={() => setAlertPreset(null)}
            onOpenSubscription={() =>
              go({ tab: 'settings', route: { kind: 'settings', view: 'subscription' } })
            }
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
              setTab('screener');
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
