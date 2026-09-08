import { useTranslation } from 'react-i18next';

import { ChevronLeftIcon } from '../icons';
import { haptic } from '../lib/telegram';

/**
 * Шапка приложения.
 *
 * Гамбургера и кнопки «...» здесь нет намеренно: в Mini App их рисует сам
 * Telegram поверх страницы, и дублировать их — значит получить два ряда
 * одинаковых элементов управления.
 */
export function AppHeader({ title, onBack }: { title?: string; onBack?: () => void }) {
  const { t } = useTranslation();

  return (
    <header className="header">
      {onBack ? (
        <button
          className="header__icon-btn"
          type="button"
          aria-label={t('app.back')}
          onClick={() => {
            haptic('tap');
            onBack();
          }}
        >
          <ChevronLeftIcon size={22} />
        </button>
      ) : (
        <span />
      )}

      <div className="header__title">
        <strong>{title ?? t('app.brand')}</strong>
        {!title && <span>{t('app.subtitle')}</span>}
      </div>

      <span />
    </header>
  );
}
