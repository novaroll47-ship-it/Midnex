/** Модальное подтверждение — для необратимых действий вроде закрытия позиции. */
import { useTranslation } from 'react-i18next';

import { haptic } from '../lib/telegram';

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="modal__sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal__title">{title}</div>
        <div className="modal__text">{message}</div>
        <div className="modal__actions">
          <button className="btn-outline" type="button" onClick={onCancel} disabled={busy}>
            {t('app.cancel')}
          </button>
          <button
            className={`btn-outline${danger ? ' btn-outline--danger' : ''}`}
            type="button"
            disabled={busy}
            onClick={() => {
              haptic('warning');
              onConfirm();
            }}
          >
            {busy ? t('app.working') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
