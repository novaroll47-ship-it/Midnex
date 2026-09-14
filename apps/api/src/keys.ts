/**
 * Проверка ключа биржи при подключении (ТЗ §5.2, §10.4).
 *
 * Два шага. Первый — ключ вообще работает: запрашиваем баланс фьючерсного
 * счёта. Второй — права: у Binance и Bybit их можно прочитать по API, и если
 * у ключа есть право на вывод средств, подключение отклоняется. У остальных
 * шести бирж права по API не читаются; там результат «проверено вручную»,
 * и интерфейс обязан показать чек-лист, а не зелёную галочку.
 *
 * Секреты сюда приходят открытым текстом только на время вызова и никуда
 * не логируются.
 */
import ccxt, { type Exchange } from 'ccxt';
import { exchange as exchangeMeta, type ExchangeId } from '@cs/shared';

const CCXT_ID: Record<ExchangeId, string> = {
  binance: 'binance',
  bybit: 'bybit',
  okx: 'okx',
  mexc: 'mexc',
  bitget: 'bitget',
  bingx: 'bingx',
  gate: 'gate',
  kucoin: 'kucoinfutures',
};

export interface KeyCredentials {
  apiKey: string;
  secret: string;
  passphrase?: string;
}

export interface KeyCheck {
  ok: boolean;
  /** true — вывод точно отключён; false — включён; null — узнать нельзя. */
  withdrawalDisabled: boolean | null;
  /** Права прочитаны по API биржи, а не приняты на веру. */
  permissionsVerified: boolean;
  /** Баланс фьючерсного счёта в USDT, если удалось прочитать. */
  usdtBalance: number | null;
  error: string | null;
}

function makeClient(id: ExchangeId, creds: KeyCredentials): Exchange {
  const Ctor = (ccxt as unknown as Record<string, new (cfg: object) => Exchange>)[CCXT_ID[id]]!;
  return new Ctor({
    apiKey: creds.apiKey,
    secret: creds.secret,
    ...(creds.passphrase ? { password: creds.passphrase } : {}),
    enableRateLimit: true,
    timeout: 20_000,
    options: { defaultType: 'swap' },
  });
}

/** Что ответила биржа, без секретов и в разумной длине. */
function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // ccxt отдаёт «bybit {"retCode":10003,"retMsg":"API key is invalid."}» —
  // человеку нужен только текст биржи, без обёртки.
  const json = raw.slice(raw.indexOf('{'));
  try {
    const body = JSON.parse(json) as Record<string, unknown>;
    const msg = body['retMsg'] ?? body['msg'] ?? body['message'] ?? body['error'];
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 160);
  } catch {
    // Не JSON — отдаём как есть.
  }
  return raw.replace(/[A-Za-z0-9]{32,}/g, '…').slice(0, 160);
}

async function checkBinance(
  client: Exchange,
): Promise<Pick<KeyCheck, 'withdrawalDisabled' | 'permissionsVerified'>> {
  // sapiGetAccountApiRestrictions — права ключа на уровне аккаунта.
  const call = (
    client as unknown as { sapiGetAccountApiRestrictions?: () => Promise<Record<string, unknown>> }
  ).sapiGetAccountApiRestrictions;
  if (!call) return { withdrawalDisabled: null, permissionsVerified: false };
  const r = await call.call(client);
  return {
    withdrawalDisabled: r['enableWithdrawals'] === false,
    permissionsVerified: true,
  };
}

async function checkBybit(
  client: Exchange,
): Promise<Pick<KeyCheck, 'withdrawalDisabled' | 'permissionsVerified'>> {
  const call = (
    client as unknown as {
      privateGetV5UserQueryApi?: () => Promise<{ result?: Record<string, unknown> }>;
    }
  ).privateGetV5UserQueryApi;
  if (!call) return { withdrawalDisabled: null, permissionsVerified: false };
  const r = await call.call(client);
  const perms = (r.result?.['permissions'] ?? {}) as Record<string, unknown>;
  // Вывод у Bybit сидит в разделе Wallet; если там пусто — вывода нет.
  const wallet = Array.isArray(perms['Wallet']) ? (perms['Wallet'] as string[]) : [];
  const canWithdraw = wallet.some((p) => /withdraw/i.test(p));
  return { withdrawalDisabled: !canWithdraw, permissionsVerified: true };
}

export async function verifyExchangeKey(id: ExchangeId, creds: KeyCredentials): Promise<KeyCheck> {
  const meta = exchangeMeta(id);
  if (meta.needsPassphrase && !creds.passphrase) {
    return {
      ok: false,
      withdrawalDisabled: null,
      permissionsVerified: false,
      usdtBalance: null,
      error: 'у этой биржи к ключу нужен passphrase',
    };
  }

  const client = makeClient(id, creds);
  try {
    // Шаг 1: ключ вообще принимается и видит фьючерсный счёт.
    const balance = await client.fetchBalance();
    const usdt = balance['USDT'] as { total?: number } | undefined;
    const usdtBalance = typeof usdt?.total === 'number' ? usdt.total : null;

    // Шаг 2: права, где их можно прочитать.
    let rights: Pick<KeyCheck, 'withdrawalDisabled' | 'permissionsVerified'> = {
      withdrawalDisabled: null,
      permissionsVerified: false,
    };
    try {
      if (id === 'binance') rights = await checkBinance(client);
      else if (id === 'bybit') rights = await checkBybit(client);
    } catch {
      // Права прочитать не удалось — ключ рабочий, но проверка ручная.
    }

    return { ok: true, usdtBalance, error: null, ...rights };
  } catch (err) {
    return {
      ok: false,
      withdrawalDisabled: null,
      permissionsVerified: false,
      usdtBalance: null,
      error: describe(err),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // REST-клиенту закрывать нечего.
    }
  }
}
