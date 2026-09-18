/**
 * Загрузочный экран: логотип и полоса прогресса, пока не пришли настройки
 * и первый снимок скринера. Интерфейс показывается только полностью
 * готовым — без прочерков и «Загрузка…» в каждом блоке. Ошибка — здесь же,
 * с кнопкой «Повторить».
 */
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

export function Splash({
  progress,
  error,
  onRetry,
}: {
  /** 0–1: сколько шагов загрузки пройдено. */
  progress: number;
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash__logo">
        <span className="splash__mark">M</span>
        <span className="splash__brand">{t('app.brand')}</span>
      </div>
      {error ? (
        <>
          <div className="splash__error">{error}</div>
          <Button onClick={onRetry}>{t('app.retry')}</Button>
        </>
      ) : (
        <>
          <div className="splash__bar">
            <div className="splash__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="splash__hint">{t('app.loadingData')}</div>
        </>
      )}
    </div>
  );
}
