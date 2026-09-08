/**
 * Форматирование чисел ровно как в утверждённых макетах:
 * «66 245.30», «0.12834», «+569.90», «0.86%».
 * Разделитель разрядов — узкий неразрывный пробел, десятичный — точка.
 */

const THIN_NBSP = ' ';

/** Сколько знаков после точки показывать для цены такой величины. */
export function priceDecimals(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 100) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 5;
  return 8;
}

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_NBSP);
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

function subscript(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)] ?? d)
    .join('');
}

/**
 * Компактная запись для мем-коинов: 0.00002484 → «0.0₄2484».
 * Так показывают цены сами биржи, и только так две цены и спред помещаются
 * в одну строку скринера на экране телефона.
 */
function formatTiny(abs: number, sign: string): string {
  const exp = Math.floor(Math.log10(abs));
  const zeros = -exp - 1;
  const digits = (abs * 10 ** -exp)
    .toFixed(3)
    .replace(/0+$/, '')
    .replace(/\.$/, '')
    .replace('.', '');
  return `${sign}0.0${subscript(zeros)}${digits}`;
}

export function formatPrice(value: number, decimals = priceDecimals(value)): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (abs > 0 && abs < 0.001) return formatTiny(abs, sign);

  let fixed = abs.toFixed(decimals);
  // У копеечных монет шаг цены свой у каждой биржи, поэтому хвостовые нули
  // только шумят: 0.52870 → 0.5287. На M2 точность придёт из market.precision.
  if (abs < 1 && fixed.includes('.')) {
    fixed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  }
  const [int = '0', frac] = fixed.split('.');
  return sign + group(int) + (frac ? `.${frac}` : '');
}

/** Абсолютный спред со знаком: «+569.90», «+0.00181». */
export function formatDelta(value: number, decimals: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return sign + formatPrice(Math.abs(value), decimals);
}

export function formatPct(value: number, decimals = 2): string {
  return `${value.toFixed(decimals)}%`;
}

export function formatSignedPct(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(decimals)}%`;
}

export function formatUsdt(value: number, decimals = 2): string {
  return formatPrice(value, decimals);
}

export function formatSignedUsdt(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return sign + formatPrice(Math.abs(value), decimals);
}

/** «09:41:30» в локальном времени. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** «24.05.2024» */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}
