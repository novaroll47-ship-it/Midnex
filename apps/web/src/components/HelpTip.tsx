/**
 * Кнопка «?» рядом с заголовком: по нажатию — шторка с подробной подсказкой.
 * Вместо длинного серого текста под каждым блоком.
 */
import { useState } from 'react';

import { haptic } from '../lib/telegram';
import { Sheet } from './Sheet';

export function HelpTip({ title, text, label = '?' }: { title: string; text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="help-tip"
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation();
          haptic('tap');
          setOpen(true);
        }}
      >
        {label}
      </button>
      {open && (
        <Sheet title={title} onClose={() => setOpen(false)}>
          <p className="help-tip__text">{text}</p>
        </Sheet>
      )}
    </>
  );
}
