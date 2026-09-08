/**
 * Иконка монеты. Для монет из макета — узнаваемые фирменные знаки,
 * для всех остальных — монограмма на детерминированном по тикеру фоне.
 * Всё рисуется инлайном: скринер показывает сотни монет, тянуть логотипы
 * по сети на каждую строку нельзя.
 */

const BRAND: Record<string, { bg: string; fg: string; glyph: string }> = {
  BTC: { bg: '#F7931A', fg: '#FFFFFF', glyph: '₿' },
  ETH: { bg: '#5B6474', fg: '#FFFFFF', glyph: '♦' },
  XRP: { bg: '#1B1E22', fg: '#FFFFFF', glyph: '✕' },
  DOGE: { bg: '#C3A634', fg: '#FFFFFF', glyph: 'Ð' },
  SOL: { bg: '#141A2E', fg: '#14F195', glyph: '≡' },
  TON: { bg: '#0098EA', fg: '#FFFFFF', glyph: '◆' },
  PEPE: { bg: '#3D8130', fg: '#FFFFFF', glyph: 'P' },
  BONK: { bg: '#F5A623', fg: '#FFFFFF', glyph: 'B' },
  WIF: { bg: '#C8A27A', fg: '#FFFFFF', glyph: 'W' },
};

const PALETTE = [
  '#2A6FDB',
  '#7B5BD6',
  '#1F9D8C',
  '#C25A4B',
  '#4B7BB5',
  '#9B6A2F',
  '#3E8E5A',
  '#8A5A9B',
];

function fallback(base: string): { bg: string; fg: string; glyph: string } {
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) | 0;
  const bg = PALETTE[Math.abs(h) % PALETTE.length]!;
  return { bg, fg: '#FFFFFF', glyph: base.slice(0, 1) };
}

export function CoinIcon({ base, size = 28 }: { base: string; size?: number }) {
  const brand = BRAND[base] ?? fallback(base);
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: brand.bg,
        color: brand.fg,
        display: 'grid',
        placeItems: 'center',
        fontSize: size * 0.52,
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {brand.glyph}
    </span>
  );
}
