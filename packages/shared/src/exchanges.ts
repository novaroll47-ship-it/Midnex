/**
 * Восемь бирж из ТЗ §2. Только USDT-margined перпетуалы.
 *
 * `short` — двухбуквенный код для мелких значков: одной буквы не хватает,
 * потому что Binance, Bybit и Bitget начинаются одинаково.
 * `brand` — цвет названия биржи в интерфейсе; взят из фирменных цветов бирж,
 * ровно как в утверждённых макетах (Binance жёлтый, KuCoin зелёный и т.д.).
 * `needsPassphrase` — у этих бирж API-ключ состоит из трёх частей, форма
 * подключения в настройках отличается (ТЗ §5.2).
 * `canQueryKeyPermissions` — умеет ли биржа отдать права ключа по API. Там, где
 * false, программно проверить «нет права вывода» невозможно: показываем чек-лист
 * и требуем IP-whitelist вместо ложной галочки «проверено».
 */
export const EXCHANGES = [
  {
    id: 'binance',
    short: 'BN',
    name: 'Binance',
    brand: '#F0B90B',
    needsPassphrase: false,
    canQueryKeyPermissions: true,
  },
  {
    id: 'bybit',
    short: 'BY',
    name: 'Bybit',
    brand: '#F7A600',
    needsPassphrase: false,
    canQueryKeyPermissions: true,
  },
  {
    id: 'okx',
    short: 'OK',
    name: 'OKX',
    brand: '#E9EEF2',
    needsPassphrase: true,
    canQueryKeyPermissions: false,
  },
  {
    id: 'mexc',
    short: 'MX',
    name: 'MEXC',
    brand: '#00B897',
    needsPassphrase: false,
    canQueryKeyPermissions: false,
  },
  {
    id: 'bitget',
    short: 'BG',
    name: 'Bitget',
    brand: '#2ED3E0',
    needsPassphrase: true,
    canQueryKeyPermissions: false,
  },
  {
    id: 'bingx',
    short: 'BX',
    name: 'BingX',
    brand: '#4B7BFF',
    needsPassphrase: false,
    canQueryKeyPermissions: false,
  },
  {
    id: 'gate',
    short: 'GT',
    name: 'Gate',
    brand: '#17E6A1',
    needsPassphrase: false,
    canQueryKeyPermissions: false,
  },
  {
    id: 'kucoin',
    short: 'KC',
    name: 'KuCoin',
    brand: '#24C08A',
    needsPassphrase: true,
    canQueryKeyPermissions: false,
  },
] as const;

export type ExchangeId = (typeof EXCHANGES)[number]['id'];
export type ExchangeMeta = (typeof EXCHANGES)[number];

const BY_ID = new Map<string, ExchangeMeta>(EXCHANGES.map((e) => [e.id, e]));

export function exchange(id: ExchangeId): ExchangeMeta {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown exchange: ${id}`);
  return found;
}
