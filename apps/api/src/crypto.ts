/**
 * Шифрование секретов бирж: AES-256-GCM.
 *
 * Ключ шифрования — KEY_ENCRYPTION_KEY из окружения сервера, 32 байта в hex.
 * В базе он не лежит никогда: утечка базы без ключа даёт нападающему только
 * шифротекст. Без настроенного ключа приём ключей бирж отключён целиком —
 * хранить их открытым текстом нельзя ни при каких обстоятельствах.
 *
 * Формат хранения: base64url(iv).base64url(ciphertext).base64url(tag).
 * GCM даёт аутентификацию: подменённый шифротекст не расшифруется.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

let key: Buffer | null = null;

export function initEncryption(hex: string | undefined): boolean {
  if (!hex) return false;
  const buf = Buffer.from(hex.trim(), 'hex');
  if (buf.length !== 32) {
    throw new Error('KEY_ENCRYPTION_KEY должен быть 32 байта в hex (64 символа)');
  }
  key = buf;
  return true;
}

export function encryptionReady(): boolean {
  return key !== null;
}

export function encrypt(plain: string): string {
  if (!key) throw new Error('шифрование не настроено');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, ct, tag].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(stored: string): string {
  if (!key) throw new Error('шифрование не настроено');
  const [ivB, ctB, tagB] = stored.split('.');
  if (!ivB || !ctB || !tagB) throw new Error('повреждённая запись');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}

/** Подсказка для интерфейса: последние символы ключа, чтобы узнать его. */
export function keyHint(apiKey: string): string {
  return apiKey.length <= 4 ? '••••' : `…${apiKey.slice(-4)}`;
}
