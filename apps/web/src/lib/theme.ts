/**
 * Тема: тёмная, светлая, как в Telegram (только светло/темно) или под
 * цвет Telegram (ещё и палитра клиента).
 *
 * Выбор хранится на устройстве; по умолчанию следуем за темой клиента
 * Telegram (а в браузере — за системной). Применяется атрибутом
 * data-theme на <html>, на который смотрят токены в polish.css. Режим
 * «под цвет Telegram» поверх этого подставляет цвета из themeParams
 * клиента: фон, поверхности, текст, ссылки и акцент кнопок — форма и
 * паттерны при этом те же. Цвета шапки и фона самого Telegram
 * синхронизируем, иначе вокруг светлого приложения остаётся чёрная рамка.
 */
import { webApp } from './telegram';

export type ThemeMode = 'dark' | 'light' | 'telegram';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'midnex.theme';
const BG: Record<ResolvedTheme, string> = { dark: '#000000', light: '#ffffff' };

const listeners = new Set<(theme: ResolvedTheme) => void>();

export function currentThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light' || v === 'telegram') return v;
  } catch {
    // Хранилище недоступно — считаем, что выбора не было.
  }
  // По умолчанию — тёмная; старое значение «как в Telegram» тоже сводится к ней.
  return 'dark';
}

function systemTheme(): ResolvedTheme {
  if (webApp?.colorScheme) return webApp.colorScheme;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(mode = currentThemeMode()): ResolvedTheme {
  return mode === 'telegram' ? systemTheme() : mode;
}

/** Токены, которые берутся из клиента в режиме «под цвет Telegram». */
type TgParam =
  | 'bg_color'
  | 'secondary_bg_color'
  | 'section_bg_color'
  | 'text_color'
  | 'hint_color'
  | 'link_color'
  | 'button_color'
  | 'button_text_color'
  | 'subtitle_text_color';

const TG_VARS: [cssVar: string, param: TgParam][] = [
  ['--bg', 'bg_color'],
  ['--surface', 'secondary_bg_color'],
  ['--surface-2', 'section_bg_color'],
  ['--text', 'text_color'],
  ['--text-dim', 'hint_color'],
  ['--text-mute', 'subtitle_text_color'],
  ['--link', 'link_color'],
  ['--brand', 'button_color'],
  ['--brand-ink', 'button_text_color'],
  ['--primary', 'button_color'],
  ['--primary-foreground', 'button_text_color'],
  ['--background', 'bg_color'],
  ['--card', 'secondary_bg_color'],
  // Нижняя панель и шторки красятся своими токенами — иначе остаются чёрными.
  ['--nav-bg', 'bg_color'],
  ['--popover', 'secondary_bg_color'],
  ['--secondary', 'section_bg_color'],
  ['--muted', 'section_bg_color'],
  ['--surface-3', 'section_bg_color'],
];

function applyTelegramPalette(on: boolean): void {
  const root = document.documentElement.style;
  const params = webApp?.themeParams;
  for (const [cssVar, param] of TG_VARS) {
    const value = on ? params?.[param] : undefined;
    if (value) root.setProperty(cssVar, value);
    else root.removeProperty(cssVar);
  }
  // Бренд из клиента — значит и его мягкая подложка должна быть от него.
  const button = on ? params?.button_color : undefined;
  if (button && /^#[0-9a-f]{6}$/i.test(button)) {
    const r = parseInt(button.slice(1, 3), 16);
    const g = parseInt(button.slice(3, 5), 16);
    const b = parseInt(button.slice(5, 7), 16);
    root.setProperty('--brand-soft', `rgba(${r}, ${g}, ${b}, 0.14)`);
    root.setProperty('--brand-line', `rgba(${r}, ${g}, ${b}, 0.4)`);
  } else {
    root.removeProperty('--brand-soft');
    root.removeProperty('--brand-line');
  }
}

export function applyTheme(): ResolvedTheme {
  const mode = currentThemeMode();
  const theme = resolveTheme(mode);
  document.documentElement.dataset['theme'] = theme;
  const telegram = mode === 'telegram' && Boolean(webApp?.themeParams?.bg_color);
  applyTelegramPalette(telegram);
  try {
    const bg = telegram ? (webApp?.themeParams?.bg_color ?? BG[theme]) : BG[theme];
    webApp?.setHeaderColor(bg);
    webApp?.setBackgroundColor(bg);
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
    if (currentThemeMode() === 'telegram') applyTheme();
  });
}
