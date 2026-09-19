/**
 * Знак MidNex. Правило по размеру из README логотипа: от 48px — полная
 * иконка с метками, меньше — упрощённая; для светлой темы — одноцветный
 * знак цветом #00A85E (градиент на светлом теряет контраст).
 */
import { useEffect, useState } from 'react';

import { currentThemeMode, onThemeChange, resolveTheme } from '../lib/theme';

function useLightTheme(): boolean {
  const [light, setLight] = useState(() => resolveTheme(currentThemeMode()) === 'light');
  useEffect(() => onThemeChange((t) => setLight(t === 'light')), []);
  return light;
}

/** Круглая иконка (аватар). */
export function LogoIcon({ size = 64 }: { size?: number }) {
  const src = size >= 48 ? '/logo/midnex-icon.svg' : '/logo/midnex-icon-simple.svg';
  return <img src={src} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}

/** Знак без фона — для шапки рядом со словом MIDNEX. */
export function LogoMark({ height = 22 }: { height?: number }) {
  const light = useLightTheme();
  const width = Math.round((height * 96) / 104.4);
  if (light) {
    return (
      <svg
        viewBox="0 22 96 104.4"
        width={width}
        height={height}
        aria-hidden="true"
        style={{ color: '#00a85e', display: 'block' }}
      >
        <polygon
          points="0,108 0,32 22,32 45.45,78 74,22 96,22 96,108 74,108 74,70.4 45.45,126.4 22,80.4 22,108"
          fill="currentColor"
        />
      </svg>
    );
  }
  return (
    <img
      src="/logo/midnex-mark.svg"
      width={width}
      height={height}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
