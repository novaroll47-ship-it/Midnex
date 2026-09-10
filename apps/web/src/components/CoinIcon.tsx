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
 * Монограмма нейтральная, как и вся палитра: оттенок серого зависит от
 * тикера, чтобы соседние монеты без логотипа всё же различались, но цвета
 * в ней нет — он в этом интерфейсе означает прибыль или убыток.
 */
function monogramColor(base: string): string {
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) | 0;
  const light = 26 + (Math.abs(h) % 5) * 4; // 26–42: тёмное серебро
  return `hsl(0 0% ${light}%)`;
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

  const style = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'block',
  } as const;

  if (failed) {
    return (
      <span
        aria-hidden="true"
        style={{
          ...style,
          background: monogramColor(base),
          color: 'rgba(255, 255, 255, 0.82)',
          display: 'grid',
          placeItems: 'center',
          fontSize: size * 0.44,
          fontWeight: 700,
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
      style={{ ...style, background: '#1a1a1d' }}
      onError={() => {
        known404.add(key);
        setFailed(true);
      }}
    />
  );
}
