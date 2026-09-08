/**
 * Тонкая обёртка над Telegram WebApp SDK.
 *
 * Приложение обязано открываться и в обычном браузере на ПК — это основной
 * режим отладки. Поэтому весь SDK опционален: если Telegram нет, работаем
 * как обычная веб-страница, а бэкенд пускает нас по DEV_FAKE_USER.
 */

interface TgBackButton {
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

interface TgHaptic {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  selectionChanged(): void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: {
    user?: { id: number; first_name: string; username?: string; language_code?: string };
  };
  colorScheme: 'light' | 'dark';
  version: string;
  platform: string;
  isExpanded: boolean;
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  BackButton: TgBackButton;
  HapticFeedback?: TgHaptic;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const webApp = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;

/**
 * Скрипт telegram-web-app.js подключается и в обычном браузере, поэтому
 * само наличие window.Telegram ничего не доказывает. Вне Telegram клиент
 * сообщает platform === 'unknown' — это и есть надёжный признак.
 */
export const isTelegram = Boolean(
  webApp && webApp.platform && webApp.platform !== 'unknown' && webApp.version,
);

export const initData = webApp?.initData ?? '';

export const platform = webApp?.platform ?? 'browser';
export const tgVersion = webApp?.version ?? '—';

/** Приложение открыто вне Telegram — показываем dev-плашку. */
export const isBrowserFallback = !isTelegram;

export function initTelegram(): void {
  if (!webApp) return;
  webApp.ready();
  webApp.expand();
  // Мешает скроллу длинных списков на мобильных клиентах.
  webApp.disableVerticalSwipes?.();
  try {
    webApp.setHeaderColor('#010408');
    webApp.setBackgroundColor('#010408');
  } catch {
    // Старые клиенты Telegram не поддерживают — не критично.
  }
}

export function haptic(kind: 'tap' | 'success' | 'warning' = 'tap'): void {
  const h = webApp?.HapticFeedback;
  if (!h) return;
  if (kind === 'tap') h.selectionChanged();
  else h.notificationOccurred(kind === 'success' ? 'success' : 'warning');
}

export function backButton(visible: boolean, onClick?: () => void): () => void {
  const bb = webApp?.BackButton;
  if (!bb) return () => {};
  if (visible) {
    bb.show();
    if (onClick) bb.onClick(onClick);
  } else {
    bb.hide();
  }
  return () => {
    if (onClick) bb.offClick(onClick);
    bb.hide();
  };
}
