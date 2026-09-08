/**
 * Авторизация Telegram Mini App (ТЗ §10.4).
 *
 * Клиент присылает строку `initData` из Telegram.WebApp в заголовке
 * `X-Telegram-Init-Data`. Подпись проверяется HMAC-SHA256 с секретом,
 * производным от токена бота — только так сервер знает, что пользователь
 * действительно тот, за кого себя выдаёт.
 *
 * DEV_FAKE_USER=1 отключает проверку и подставляет тестового пользователя,
 * чтобы приложение открывалось в обычном браузере на ПК. На проде должно
 * быть выключено — сервер откажется стартовать с включённым байпасом,
 * если NODE_ENV=production.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
}

export const DEV_USER: TelegramUser = {
  id: 1,
  firstName: 'Dev',
  username: 'dev',
  languageCode: 'ru',
};

/** initData считается протухшей после этого возраста. */
const MAX_AUTH_AGE_SEC = 24 * 60 * 60;

export class AuthError extends Error {}

export function verifyInitData(initData: string, botToken: string): TelegramUser {
  if (!initData) throw new AuthError('initData is empty');

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new AuthError('initData has no hash');

  // Проверочная строка — все полученные поля, кроме hash, отсортированные по ключу.
  //
  // Отдельная история с полем signature: его новые клиенты Telegram присылают
  // для независимой проверки по Ed25519. Часть клиентов считает HMAC вместе с
  // ним, часть — без него, и ошибка в этом месте выглядит как «приложение не
  // грузится». Поэтому принимаем оба варианта: подделать любой из них без
  // токена бота всё равно нельзя.
  const build = (skipSignature: boolean): string => {
    const pairs: string[] = [];
    for (const [key, value] of params.entries()) {
      if (key === 'hash') continue;
      if (skipSignature && key === 'signature') continue;
      pairs.push(`${key}=${value}`);
    }
    return pairs.sort().join('\n');
  };

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const given = Buffer.from(hash, 'hex');

  const matches = [build(false), build(true)].some((dataCheckString) => {
    const expected = createHmac('sha256', secret).update(dataCheckString).digest();
    return expected.length === given.length && timingSafeEqual(expected, given);
  });

  if (!matches) {
    throw new AuthError(
      `initData signature mismatch (поля: ${[...params.keys()].sort().join(',')})`,
    );
  }

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE_SEC) {
    throw new AuthError('initData expired');
  }

  const rawUser = params.get('user');
  if (!rawUser) throw new AuthError('initData has no user');

  const parsed = JSON.parse(rawUser) as {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    is_premium?: boolean;
  };

  return {
    id: parsed.id,
    firstName: parsed.first_name,
    lastName: parsed.last_name,
    username: parsed.username,
    languageCode: parsed.language_code,
    isPremium: parsed.is_premium,
  };
}
