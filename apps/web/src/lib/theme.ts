/**
 * Тема: тёмная, светлая или как в Telegram.
 *
 * Выбор хранится на устройстве; по умолчанию следуем за темой клиента
 * Telegram (а в браузере — за системной). Применяется атрибутом
 * data-theme на <html>, на который смотрят токены в polish.css. Цвета
 * шапки и фона самого Telegram синхронизируем, иначе вокруг светлого
 * приложения остаётся чёрная рамка клиента.
 */
import { webApp } from './telegram';

export type ThemeMode = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'midnex.theme';
const BG: Record<ResolvedTheme, string> = { dark: '#000000', light: '#ffffff' };

const listeners = new Set<(theme: ResolvedTheme) => void>();

export function currentThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    // Хранилище недоступно — считаем, что выбора не было.
  }
  return 'system';
}

function systemTheme(): ResolvedTheme {
  if (webApp?.colorScheme) return webApp.colorScheme;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(mode = currentThemeMode()): ResolvedTheme {
  return mode === 'system' ? systemTheme() : mode;
}

export function applyTheme(): ResolvedTheme {
  const theme = resolveTheme();
  document.documentElement.dataset['theme'] = theme;
  try {
    webApp?.setHeaderColor(BG[theme]);
    webApp?.setBackgroundColor(BG[theme]);
  } catch {
    // Старые клиенты Telegram не поддерживают — не критично.
  }
  for (const fn of listeners) fn(theme);
  return theme;
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Без хранилища выбор доживёт до перезагрузки — лучше, чем ничего.
  }
  applyTheme();
}

export function onThemeChange(fn: (theme: ResolvedTheme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Один раз при старте: применить и следить за сменой темы в клиенте. */
export function initTheme(): void {
  applyTheme();
  webApp?.onEvent?.('themeChanged', () => {
    if (currentThemeMode() === 'system') applyTheme();
  });
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (currentThemeMode() === 'system') applyTheme();
  });
}
