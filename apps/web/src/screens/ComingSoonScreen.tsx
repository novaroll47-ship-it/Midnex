/**
 * Заглушка торговых разделов на этапе «только скринер».
 *
 * Ничего не делает намеренно: аудитория видит, что будет дальше, но ни одна
 * кнопка не ведёт в недоделанный функционал.
 */
import { useTranslation } from 'react-i18next';

import { ClockIcon } from '../icons';

export function ComingSoonScreen({ what }: { what: 'positions' }) {
  const { t } = useTranslation();
  return (
    <div className="stack">
      <div className="screen-title">
        <h1>{t(`soon.${what}Title`)}</h1>
        <span className="badge badge--soon">{t('settings.soon')}</span>
      </div>

      <section className="card soon">
        <ClockIcon className="soon__icon" />
        <div className="soon__title">{t(`soon.${what}Lead`)}</div>
        <div className="soon__text">{t(`soon.${what}Text`)}</div>
      </section>

      <p className="hint">{t('soon.seeBots')}</p>
    </div>
  );
}
