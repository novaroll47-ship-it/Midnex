import { useTranslation } from 'react-i18next';

import { ChevronLeftIcon } from '../icons';
import { LogoMark } from './Logo';
import { haptic, isTelegram } from '../lib/telegram';

/**
 * Шапка приложения.
 *
 * Внутри Telegram клиент уже рисует сверху имя мини-приложения и свою кнопку
 * «назад», поэтому собственные название и стрелку мы там не показываем —
 * иначе получается два одинаковых заголовка друг под другом. В обычном
 * браузере этого обрамления нет, и рисуем всё сами.
 */
export function AppHeader({ title, onBack }: { title?: string; onBack?: () => void }) {
  const { t } = useTranslation();

  const showBrand = !isTelegram && !title;
  const showBack = Boolean(onBack) && !isTelegram;

  // Внутри Telegram на вкладках показывать нечего — не занимаем экран пустой полосой.
  if (isTelegram && !title) return null;

  return (
    <header className="header">
      {showBack ? (
        <button
          className="header__icon-btn"
          type="button"
          aria-label={t('app.back')}
          onClick={() => {
            haptic('tap');
            onBack?.();
          }}
        >
          <ChevronLeftIcon size={22} />
        </button>
      ) : (
        <span />
      )}

      <div className="header__title">
        {showBrand ? (
          <span className="header__brand">
            <LogoMark height={22} />
            <strong>{t('app.brand')}</strong>
          </span>
        ) : (
          <strong>{title ?? t('app.brand')}</strong>
        )}
        {showBrand && <span>{t('app.subtitle')}</span>}
      </div>

      <span />
    </header>
  );
}
