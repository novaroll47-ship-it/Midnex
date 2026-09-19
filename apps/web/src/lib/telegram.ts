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
  /** Цвета клиента — для режима «под цвет Telegram». */
  themeParams?: Partial<
    Record<
      | 'bg_color'
      | 'secondary_bg_color'
      | 'section_bg_color'
      | 'text_color'
      | 'hint_color'
      | 'link_color'
      | 'button_color'
      | 'button_text_color'
      | 'subtitle_text_color',
      string
    >
  >;
  version: string;
  platform: string;
  isExpanded: boolean;
  viewportHeight?: number;
  viewportStableHeight?: number;
  ready(): void;
  expand(): void;
  close?(): void;
  openInvoice?(url: string, callback?: (status: string) => void): void;
  openTelegramLink?(url: string): void;
  openLink?(url: string, options?: { try_instant_view?: boolean }): void;
  disableVerticalSwipes?(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  onEvent?(event: string, handler: () => void): void;
  BackButton: TgBackButton;
  HapticFeedback?: TgHaptic;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const webApp = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;

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
  // Цвета шапки и фона задаёт тема — см. lib/theme.ts.
  syncViewportHeight();
  webApp.onEvent?.('viewportChanged', syncViewportHeight);
}

/**
 * Высота видимой области из клиента → --app-height. Значение берём только
 * когда оно похоже на правду: в Telegram Desktop оно бывает нулевым, и без
 * проверки экран схлопывался в чёрную полосу.
 */
function syncViewportHeight(): void {
  const h = webApp?.viewportStableHeight ?? webApp?.viewportHeight;
  const root = document.documentElement.style;
  if (typeof h === 'number' && Number.isFinite(h) && h >= 300 && h <= window.innerHeight + 1) {
    root.setProperty('--app-height', `${Math.round(h)}px`);
  } else {
    root.removeProperty('--app-height');
  }
  resetDocumentScroll();
}

/**
 * Клавиатура над полем ввода заставляет WebView прокрутить сам документ,
 * хотя у приложения фиксированная высота и свой скролл внутри. После
 * закрытия клавиатуры экран остаётся сдвинутым, снизу — чёрная пустота.
 * Возвращаем документ на место; вызывается при смене viewport, закрытии
 * шторок и потере фокуса полем.
 */
export function resetDocumentScroll(): void {
  if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0) {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
}

if (typeof document !== 'undefined') {
  // Поле потеряло фокус — клавиатура уходит, документ возвращаем.
  document.addEventListener(
    'focusout',
    () => {
      setTimeout(resetDocumentScroll, 50);
      setTimeout(resetDocumentScroll, 350);
    },
    true,
  );
  window.addEventListener('resize', () => setTimeout(resetDocumentScroll, 50));
}

export function haptic(kind: 'tap' | 'success' | 'warning' | 'error' = 'tap'): void {
  const h = webApp?.HapticFeedback;
  if (!h) return;
  if (kind === 'tap') h.selectionChanged();
  else h.notificationOccurred(kind);
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

/** Закрыть мини-приложение; в браузере закрывать нечего — просто перезагрузка. */
export function closeApp(): void {
  if (webApp?.close) webApp.close();
  else window.location.reload();
}

/**
 * Инвойс Telegram (звёзды) внутри мини-приложения. Статусы: paid, cancelled,
 * failed, pending. Вне Telegram открываем ссылку в новой вкладке — оплатить
 * там нельзя, но хотя бы видно, что происходит.
 */
export function openInvoice(url: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    if (webApp?.openInvoice) {
      // На части клиентов окно оплаты не открывается и колбэк не приходит —
      // тогда через таймаут отдаём 'timeout', и экран предложит счёт в чате.
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve('timeout');
        }
      }, timeoutMs);
      webApp.openInvoice(url, (status) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(status);
      });
    } else {
      window.open(url, '_blank', 'noopener');
      resolve('pending');
    }
  });
}

/** Открыть ссылку t.me внутри Telegram (чат с ботом, счёт). */
export function openTelegramLink(url: string): void {
  // Внутри Telegram t.me-ссылки открывает сам клиент; если метода нет
  // (старый клиент) — обычной ссылкой, её клиент тоже перехватит.
  try {
    if (webApp?.openTelegramLink) return webApp.openTelegramLink(url);
    if (webApp?.openLink) return webApp.openLink(url);
  } catch {
    // Провалились — ниже запасной путь.
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
