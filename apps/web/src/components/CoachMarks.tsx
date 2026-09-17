/**
 * Coach marks: затемнение с вырезом под элемент, карточка с текстом,
 * «Далее» / «Пропустить». Тур не блокирует приложение: закрыть можно в
 * любой момент, а недоступные шаги пропускаются.
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { haptic } from '../lib/telegram';
import type { TourModule } from '../onboarding/modules';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function CoachMarks({
  module,
  onSwitchTab,
  onDone,
}: {
  module: TourModule;
  onSwitchTab: (tab: TourModule['tab']) => void;
  onDone: (completed: boolean) => void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const step = module.steps[index];

  // Найти элемент шага; если его нет — переключить вкладку и подождать,
  // потом пропустить шаг.
  useLayoutEffect(() => {
    if (!step) return;
    let cancelled = false;
    let attempts = 0;
    if (step.tab) onSwitchTab(step.tab);

    let follow: ReturnType<typeof setInterval> | null = null;
    const measure = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
    };
    const find = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(step.target);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        measure(el);
        // Экран ещё догружается (подписка, список) и элементы сдвигаются —
        // подсветка следует за элементом, пока шаг открыт.
        follow = setInterval(() => measure(el), 250);
        return;
      }
      if (++attempts < 15) setTimeout(find, 100);
      else setIndex((i) => i + 1);
    };
    find();
    return () => {
      cancelled = true;
      if (follow) clearInterval(follow);
    };
  }, [step, onSwitchTab]);

  useEffect(() => {
    if (index >= module.steps.length) onDone(true);
  }, [index, module.steps.length, onDone]);

  if (!step || !rect) return null;

  const last = index === module.steps.length - 1;
  // Карточка — под элементом, если есть место, иначе над ним.
  const below = rect.top + rect.height + 190 < window.innerHeight;
  const cardTop = below ? rect.top + rect.height + 10 : Math.max(10, rect.top - 180);

  return (
    <div className="coach" role="dialog" aria-modal="true">
      <svg className="coach__mask" width="100%" height="100%">
        <defs>
          <mask id="coach-hole">
            <rect width="100%" height="100%" fill="#fff" />
            <rect
              x={rect.left}
              y={rect.top}
              width={rect.width}
              height={rect.height}
              rx={12}
              fill="#000"
            />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.72)" mask="url(#coach-hole)" />
        <rect
          x={rect.left}
          y={rect.top}
          width={rect.width}
          height={rect.height}
          rx={12}
          fill="none"
          stroke="var(--blue)"
          strokeWidth={2}
        />
      </svg>

      <div className="coach__card" style={{ top: cardTop }}>
        <div className="coach__step">
          {index + 1} / {module.steps.length}
        </div>
        <div className="coach__title">{t(`tour.${module.id}.${step.key}.title`)}</div>
        <div className="coach__text">{t(`tour.${module.id}.${step.key}.text`)}</div>
        <div className="coach__actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              haptic('tap');
              onDone(false);
            }}
          >
            {t('tour.skip')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              haptic('tap');
              setIndex((i) => i + 1);
            }}
          >
            {last ? t('tour.finish') : t('tour.next')}
          </Button>
        </div>
      </div>
    </div>
  );
}
