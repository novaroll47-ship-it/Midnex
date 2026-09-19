/**
 * Crypto Pay API (@CryptoBot): счета в USDT за подписку.
 *
 * Все вызовы — только с бэкенда, токен приложения в .env. Подтверждение
 * оплаты — вебхуком invoice_paid на секретный путь с проверкой подписи
 * (HMAC-SHA256 тела ключом sha256(token)); опрос getInvoices — запасной
 * путь на случай пропущенного вебхука. Тестовая сеть — @CryptoTestnetBot.
 *
 * Документация: https://help.crypt.bot/crypto-pay-api
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

export interface CryptoPayInvoice {
  invoiceId: number;
  status: 'active' | 'paid' | 'expired';
  amount: string;
  asset: string;
  /** Ссылка на оплату: мини-приложение (внутри Telegram) или бот. */
  payUrl: string;
  botUrl: string;
  payload: string | null;
  paidAt: number | null;
}

interface RawInvoice {
  invoice_id: number;
  status: 'active' | 'paid' | 'expired';
  amount: string;
  asset?: string;
  bot_invoice_url: string;
  mini_app_invoice_url?: string;
  web_app_invoice_url?: string;
  payload?: string;
  paid_at?: string;
}

function fromRaw(r: RawInvoice): CryptoPayInvoice {
  return {
    invoiceId: r.invoice_id,
    status: r.status,
    amount: r.amount,
    asset: r.asset ?? 'USDT',
    payUrl: r.mini_app_invoice_url ?? r.bot_invoice_url,
    botUrl: r.bot_invoice_url,
    payload: r.payload ?? null,
    paidAt: r.paid_at ? Date.parse(r.paid_at) : null,
  };
}

export class CryptoPay {
  private readonly host: string;
  private readonly secret: Buffer;

  constructor(
    private readonly token: string,
    testnet: boolean,
    private readonly log: FastifyBaseLogger,
  ) {
    this.host = testnet ? 'https://testnet-pay.crypt.bot' : 'https://pay.crypt.bot';
    this.secret = createHash('sha256').update(token).digest();
  }

  get isTestnet(): boolean {
    return this.host.includes('testnet');
  }

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.host}/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': this.token },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as {
      ok: boolean;
      result?: T;
      error?: { code: number; name: string };
    };
    if (!json.ok || json.result === undefined) {
      throw new Error(`CryptoPay ${method}: ${json.error?.name ?? res.status}`);
    }
    return json.result;
  }

  /** Проверка токена и сети — при старте, чтобы ошибка конфигурации была видна в логе. */
  async getMe(): Promise<{ name: string }> {
    return this.call<{ name: string }>('getMe');
  }

  async createInvoice(o: {
    amountUsdt: number;
    description: string;
    payload: string;
    expiresInSec: number;
    paidBtnUrl?: string;
  }): Promise<CryptoPayInvoice> {
    const body: Record<string, unknown> = {
      currency_type: 'crypto',
      asset: 'USDT',
      amount: o.amountUsdt.toFixed(2),
      description: o.description,
      payload: o.payload,
      expires_in: o.expiresInSec,
      allow_comments: false,
      allow_anonymous: true,
    };
    if (o.paidBtnUrl) {
      body['paid_btn_name'] = 'openBot';
      body['paid_btn_url'] = o.paidBtnUrl;
    }
    return fromRaw(await this.call<RawInvoice>('createInvoice', body));
  }

  async getInvoices(ids: number[]): Promise<CryptoPayInvoice[]> {
    if (ids.length === 0) return [];
    const r = await this.call<{ items: RawInvoice[] }>('getInvoices', {
      invoice_ids: ids.join(','),
    });
    return r.items.map(fromRaw);
  }

  /** Подпись вебхука: HMAC-SHA256 сырого тела ключом sha256(token). */
  verifySignature(rawBody: string | Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Разобрать тело вебхука; null — не invoice_paid. */
  parseWebhook(body: unknown): CryptoPayInvoice | null {
    const u = body as { update_type?: string; payload?: RawInvoice };
    if (u?.update_type !== 'invoice_paid' || !u.payload) return null;
    try {
      return fromRaw(u.payload);
    } catch (err) {
      this.log.warn({ err: String(err) }, 'cryptopay: вебхук не разобран');
      return null;
    }
  }
}
