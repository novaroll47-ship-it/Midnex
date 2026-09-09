/**
 * Нижняя шторка — для фильтров и выбора, которым не хватает места в строке.
 *
 * Отдельный экран под фильтр открывать неудобно: пользователь теряет из виду
 * список, к которому фильтр применяется. Шторка оставляет список на месте.
 */
import { useEffect, type ReactNode } from 'react';

import { XIcon } from '../icons';

export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // Пока шторка открыта, список под ней скроллиться не должен.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <span className="sheet__title">{title}</span>
          <button className="sheet__close" type="button" onClick={onClose} aria-label="close">
            <XIcon size={18} />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {footer && <div className="sheet__footer">{footer}</div>}
      </div>
    </div>
  );
}
