/**
 * Выбор бирж для расчёта спреда — общий для скринера и экрана монеты.
 * Пустой список означает «все восемь». Хранится на устройстве: это фильтр
 * отображения, а не настройка аккаунта.
 */
import { EXCHANGES, type ExchangeId } from '@cs/shared';

export const VENUES_KEY = 'midnex.screener.venues';

export function loadVenues(): ExchangeId[] {
  try {
    const raw = localStorage.getItem(VENUES_KEY);
    const ids = new Set<string>(EXCHANGES.map((e) => e.id));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    const out = list.filter((v): v is ExchangeId => typeof v === 'string' && ids.has(v));
    return out.length >= 2 && out.length < EXCHANGES.length ? out : [];
  } catch {
    return [];
  }
}

export function saveVenues(next: ExchangeId[]): void {
  try {
    localStorage.setItem(VENUES_KEY, JSON.stringify(next));
  } catch {
    // Хранилище недоступно — фильтр живёт до перезапуска.
  }
}
