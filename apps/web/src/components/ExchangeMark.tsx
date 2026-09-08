/** Квадратный значок биржи в фирменном цвете — как в карточках позиций на макете. */
import { exchange, type ExchangeId } from '@cs/shared';

export function ExchangeMark({ id, size = 16 }: { id: ExchangeId; size?: number }) {
  const meta = exchange(id);
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        background: `${meta.brand}22`,
        border: `1px solid ${meta.brand}66`,
        color: meta.brand,
        display: 'grid',
        placeItems: 'center',
        fontSize: size * 0.5,
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {meta.short}
    </span>
  );
}
