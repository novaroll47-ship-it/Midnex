/**
 * i18n с первого дня (ТЗ §5.3): добавление языка = добавление JSON-файла
 * и одной строки здесь, без правок в компонентах.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './en.json';
import ru from './ru.json';

export const LANGUAGES = [
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'cs.lang';

function detectLanguage(): LanguageCode {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'ru' || saved === 'en') return saved;
  const tgLang = window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
  const browser = tgLang ?? navigator.language;
  return browser?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

void i18n.use(initReactI18next).init({
  resources: {
    ru: { translation: ru },
    en: { translation: en },
  },
  lng: detectLanguage(),
  fallbackLng: 'ru',
  interpolation: { escapeValue: false },
});

export function setLanguage(code: LanguageCode): void {
  localStorage.setItem(STORAGE_KEY, code);
  void i18n.changeLanguage(code);
}

export function currentLanguage(): LanguageCode {
  return i18n.language.startsWith('ru') ? 'ru' : 'en';
}

export default i18n;
