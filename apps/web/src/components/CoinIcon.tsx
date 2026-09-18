/**
 * Иконка монеты.
 *
 * Логотип грузится через наш сервер (`/api/icon/coin/...`), а не напрямую с
 * чужого CDN: сервер один раз скачивает и кеширует, поэтому иконки работают
 * даже там, где сторонний CDN недоступен. Если логотипа нет вовсе — рисуем
 * монограмму на детерминированном по тикеру фоне, чтобы строка не «прыгала».
 */
import { useEffect, useState } from 'react';

/**
 * Палитра плашек для монограмм: десять оттенков по хэшу тикера, чтобы
 * соседние монеты без логотипа различались с первого взгляда. Брендового
 * зелёного и янтарного здесь нет — эти два цвета заняты смыслом (действие,
 * предупреждение), а не декором.
 */
const PLATE_COLORS = [
  '#3b82f6', // синий
  '#8b5cf6', // фиолетовый
  '#f97316', // оранжевый
  '#ec4899', // розовый
  '#06b6d4', // бирюзовый
  '#6366f1', // индиго
  '#f43f5e', // малиновый
  '#0ea5e9', // голубой
  '#d946ef', // фуксия
  '#a855f7', // пурпурный
];

function plateColor(base: string): string {
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) | 0;
  return PLATE_COLORS[Math.abs(h) % PLATE_COLORS.length]!;
}

/**
 * Тикеры, у которых логотипа не нашлось, помним на всё время сессии: иначе
 * при каждой перерисовке списка браузер снова дёргает заведомо пустой адрес.
 */
const known404 = new Set<string>();

export function CoinIcon({ base, size = 28 }: { base: string; size?: number }) {
  const key = base.toLowerCase();
  const [failed, setFailed] = useState(() => known404.has(key));

  useEffect(() => {
    setFailed(known404.has(key));
  }, [key]);

  // Скруглённый квадрат: радиус — треть стороны.
  const style = {
    width: size,
    height: size,
    borderRadius: Math.round(size / 3),
    flexShrink: 0,
    display: 'block',
  } as const;

  if (failed) {
    return (
      <span
        aria-hidden="true"
        style={{
          ...style,
          background: plateColor(base),
          color: '#06130c',
          display: 'grid',
          placeItems: 'center',
          fontSize: size * (base.length > 3 ? 0.3 : 0.38),
          fontWeight: 800,
          letterSpacing: '-0.02em',
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        {base.slice(0, 3)}
      </span>
    );
  }

  return (
    <img
      src={`/api/icon/coin/${encodeURIComponent(key)}`}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      style={{ ...style, background: 'var(--surface-2)' }}
      onError={() => {
        known404.add(key);
        setFailed(true);
      }}
    />
  );
}
