/** Строительные блоки экранов настроек: переключатели, поля, выбор из списка. */
import { useEffect, useState, type ReactNode } from 'react';

import { CheckIcon, CircleDotIcon, CircleIcon } from '../icons';
import { haptic } from '../lib/telegram';

export function Section({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <>
      {title && <div className="section-label">{title}</div>}
      <section className="card list">{children}</section>
      {hint && <p className="hint">{hint}</p>}
    </>
  );
}

export function ToggleRow({
  title,
  sub,
  value,
  onChange,
  disabled,
}: {
  title: string;
  sub?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`list__item${disabled ? ' list__item--disabled' : ''}`}>
      <span>
        <span className="list__title">{title}</span>
        {sub && <span className="list__sub">{sub}</span>}
      </span>
      <span />
      <button
        type="button"
        className={`switch${value ? ' switch--on' : ''}`}
        role="switch"
        aria-checked={value}
        aria-label={title}
        disabled={disabled}
        onClick={() => {
          haptic('tap');
          onChange(!value);
        }}
      >
        <span className="switch__knob" />
      </button>
    </div>
  );
}

export function RadioRow({
  title,
  sub,
  selected,
  onSelect,
  disabled,
  badge,
}: {
  title: string;
  sub?: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  badge?: string;
}) {
  return (
    <button
      type="button"
      className={`list__item${disabled ? ' list__item--disabled' : ''}`}
      disabled={disabled}
      onClick={() => {
        haptic('tap');
        onSelect();
      }}
    >
      <span>
        <span className="list__title">
          {title}
          {badge && (
            <span className="badge badge--soon" style={{ marginLeft: 8, marginTop: 0 }}>
              {badge}
            </span>
          )}
        </span>
        {sub && <span className="list__sub">{sub}</span>}
      </span>
      <span />
      <span style={{ color: selected ? 'var(--green)' : 'var(--text-mute)' }}>
        {selected ? <CircleDotIcon /> : <CircleIcon />}
      </span>
    </button>
  );
}

export function CheckRow({
  title,
  sub,
  checked,
  onToggle,
  accent,
}: {
  title: string;
  sub?: string;
  checked: boolean;
  onToggle: () => void;
  accent?: string;
}) {
  return (
    <button
      type="button"
      className="list__item"
      onClick={() => {
        haptic('tap');
        onToggle();
      }}
    >
      <span>
        <span className="list__title" style={accent ? { color: accent } : undefined}>
          {title}
        </span>
        {sub && <span className="list__sub">{sub}</span>}
      </span>
      <span />
      <span className={`checkbox${checked ? ' checkbox--on' : ''}`}>
        <CheckIcon />
      </span>
    </button>
  );
}

/**
 * Числовое поле с отложенным сохранением: значение уходит на сервер, когда
 * поле теряет фокус или пользователь жмёт Enter, а не на каждое нажатие
 * клавиши — иначе получается запрос на символ.
 */
export function NumberRow({
  title,
  sub,
  value,
  unit,
  min,
  max,
  step,
  onCommit,
}: {
  title: string;
  sub?: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const parsed = Number(draft.replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    let next = parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  }

  return (
    <div className="list__item">
      <span>
        <span className="list__title">{title}</span>
        {sub && <span className="list__sub">{sub}</span>}
      </span>
      <span />
      <span className="num-field">
        <input
          className="num-field__input num"
          inputMode="decimal"
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Сохраняем сразу, а не через blur: на части клиентов Telegram
            // закрытие клавиатуры не даёт полю потерять фокус.
            commit();
            e.currentTarget.blur();
          }}
          aria-label={title}
        />
        {unit && <span className="num-field__unit">{unit}</span>}
      </span>
    </div>
  );
}

export function InfoRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'green' | 'red' | 'dim';
}) {
  const color =
    tone === 'green'
      ? 'var(--green)'
      : tone === 'red'
        ? 'var(--red)'
        : tone === 'dim'
          ? 'var(--text-dim)'
          : undefined;
  return (
    <div className="list__item">
      <span className="list__title">{label}</span>
      <span />
      <span className="list__meta num" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}
