import { AlipaySdk } from 'alipay-sdk';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import {alipayPaidAt,alipayTimestamp} from './alipay-time';

export type PaymentChannel = 'page' | 'wap';
export interface AlipayEnvironment {
  ALIPAY_APP_ID: string;
  ALIPAY_PRIVATE_KEY: string;
  ALIPAY_PUBLIC_KEY: string;
  ALIPAY_SELLER_ID: string;
  ALIPAY_GATEWAY?: string;
  PAYMENT_MODE?: 'live' | 'sandbox';
}
export interface PayableOrder {
  id: string;
  subject: string;
  totalAmount: string;
  expiresAt?: string;
}
export interface PaymentUrlOptions {
  channel: PaymentChannel;
  pageReturnUrl: string;
  notifyUrl: string;
}
export interface AlipayQueryResult {
  outTradeNo: string;
  tradeNo: string;
  tradeStatus: 'WAIT_BUYER_PAY' | 'TRADE_CLOSED' | 'TRADE_SUCCESS' | 'TRADE_FINISHED';
  totalAmount: string;
  sellerId?: string;
  buyerId?: string;
  paidAt?: string;
}

export class AlipayError extends Error {
  constructor(readonly code: string, message = 'Alipay request failed') {
    super(message);
    this.name = 'AlipayError';
  }
}

const LIVE_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const SANDBOX_GATEWAYS = new Set([
  'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  'https://openapi.alipaydev.com/gateway.do',
]);

function normalizePrivateKey(input: string): { key: string; keyType: 'PKCS1' | 'PKCS8' } {
  const content = input?.replace(/\\n/g, '\n').trim();
  if (!content) throw new AlipayError('ALIPAY_CONFIGURATION_INVALID', 'Alipay private key is required');
  const attempts: { key: string; keyType: 'PKCS1' | 'PKCS8' }[] = content.startsWith('-----BEGIN ')
    ? [{ key: content, keyType: content.includes('BEGIN RSA PRIVATE KEY') ? 'PKCS1' : 'PKCS8' }]
    : [
      { key: `-----BEGIN PRIVATE KEY-----\n${content}\n-----END PRIVATE KEY-----`, keyType: 'PKCS8' },
      { key: `-----BEGIN RSA PRIVATE KEY-----\n${content}\n-----END RSA PRIVATE KEY-----`, keyType: 'PKCS1' },
    ];
  for (const candidate of attempts) {
    try {
      const key = createPrivateKey(candidate.key);
      if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
      return candidate;
    } catch { /* Try the other documented private-key format without exposing key material. */ }
  }
  throw new AlipayError('ALIPAY_CONFIGURATION_INVALID', 'Alipay requires a valid RSA private key of at least 2048 bits');
}

function normalizePublicKey(input: string): string {
  const content = input?.replace(/\\n/g, '\n').trim();
  if (!content) throw new AlipayError('ALIPAY_CONFIGURATION_INVALID', 'Alipay public key is required for signature verification');
  const pem = content.startsWith('-----BEGIN ')
    ? content : `-----BEGIN PUBLIC KEY-----\n${content}\n-----END PUBLIC KEY-----`;
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
    // The official SDK's formatKey() expects no trailing empty PEM line.
    // A trailing newline retains the original footer and adds a second footer;
    // Node/OpenSSL accepts this, whereas workerd's stricter parser rejects it.
    return key.export({ type: 'spki', format: 'pem' }).toString().trim();
  } catch {
    throw new AlipayError('ALIPAY_CONFIGURATION_INVALID', 'Alipay requires a valid RSA public key of at least 2048 bits');
  }
}

function assertTradeNo(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new TypeError('Invalid merchant order number');
}

function normalizedAmount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) {
    throw new AlipayError('ALIPAY_INVALID_RESPONSE', 'Alipay returned an invalid amount');
  }
  const [integer, fraction = ''] = value.split('.');
  return `${BigInt(integer).toString()}.${fraction.padEnd(2, '0')}`;
}

function httpsCallback(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new TypeError('Alipay callback URLs must use HTTPS');
  return url.toString();
}

function queryPaidAt(value:unknown):string|undefined {
  try {return alipayPaidAt(value);}
  catch {throw new AlipayError('ALIPAY_INVALID_RESPONSE','Alipay returned an invalid payment time');}
}

/** RSA2 operations use the official SDK; HTTP transport uses Worker-native fetch. */
export function createAlipay(env: AlipayEnvironment, fetcher: typeof fetch = globalThis.fetch) {
  if (!/^20\d{14}$/.test(env.ALIPAY_APP_ID ?? '') || !/^2088\d{12}$/.test(env.ALIPAY_SELLER_ID ?? '')) {
    throw new AlipayError('ALIPAY_CONFIGURATION_INVALID', 'Valid Alipay application and seller IDs are required');
  }
  const gateway = env.ALIPAY_GATEWAY ?? (env.PAYMENT_MODE === 'sandbox'
    ? 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' : LIVE_GATEWAY);
  if (gateway !== LIVE_GATEWAY && !SANDBOX_GATEWAYS.has(gateway)) {
    throw new AlipayError('ALIPAY_CONFIGURATION_INVALID', 'Only official Alipay gateways are supported');
  }
  if ((env.PAYMENT_MODE === 'live' && gateway !== LIVE_GATEWAY)
    || (env.PAYMENT_MODE === 'sandbox' && gateway === LIVE_GATEWAY)) {
    throw new AlipayError('ALIPAY_CONFIGURATION_INVALID', 'Alipay gateway does not match payment mode');
  }
  const privateKey = normalizePrivateKey(env.ALIPAY_PRIVATE_KEY);
  const sdk = new AlipaySdk({
    appId: env.ALIPAY_APP_ID,
    privateKey: privateKey.key,
    keyType: privateKey.keyType,
    alipayPublicKey: normalizePublicKey(env.ALIPAY_PUBLIC_KEY),
    gateway,
    signType: 'RSA2',
    charset: 'utf-8',
    camelcase: false,
    timeout: 8000,
  });

  async function tradeRequest(method: 'alipay.trade.query' | 'alipay.trade.close', outTradeNo: string): Promise<Record<string, unknown>> {
    assertTradeNo(outTradeNo);
    // SDK exec() uses urllib's Node transport. Keep the SDK's official RSA2
    // signing and raw-response verification while using fetch on Cloudflare.
    const url = sdk.pageExecute(method, 'GET', {
      timestamp: alipayTimestamp(Date.now()),
      bizContent: { out_trade_no: outTradeNo },
    });
    let raw: string;
    let traceId: string;
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new AlipayError('ALIPAY_HTTP_ERROR');
      }
      raw = await response.text();
      if (raw.length > 1024 * 1024) throw new AlipayError('ALIPAY_INVALID_RESPONSE');
      traceId = response.headers.get('trace_id') ?? '';
    } catch (error) {
      if (error instanceof AlipayError) throw error;
      throw new AlipayError('ALIPAY_NETWORK_ERROR');
    }
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      envelope = parsed as Record<string, unknown>;
    } catch {
      throw new AlipayError('ALIPAY_INVALID_RESPONSE');
    }
    const expectedKey = `${method.replaceAll('.', '_')}_response`;
    const responseKey = Object.hasOwn(envelope, expectedKey) ? expectedKey : 'error_response';
    const signature = envelope.sign;
    const data = envelope[responseKey];
    if (typeof signature !== 'string' || !signature || !data || typeof data !== 'object' || Array.isArray(data)) {
      throw new AlipayError('ALIPAY_SIGNATURE_INVALID', 'Alipay returned an unsigned response');
    }
    try {
      // This validates the original response text, never a JSON reserialization.
      sdk.checkResponseSign(raw, responseKey, signature, traceId);
    } catch {
      throw new AlipayError('ALIPAY_SIGNATURE_INVALID', 'Alipay response signature is invalid');
    }
    return data as Record<string, unknown>;
  }

  return {
    paymentUrl(order: PayableOrder, options: PaymentUrlOptions): string {
      assertTradeNo(order.id);
      const totalAmount = normalizedAmount(order.totalAmount);
      if (totalAmount === '0.00' || !order.subject || order.subject.length > 128) throw new TypeError('Invalid payable order');
      if (order.expiresAt && (!Number.isFinite(Date.parse(order.expiresAt)) || Date.parse(order.expiresAt) <= Date.now())) {
        throw new TypeError('Cannot pay an expired order');
      }
      // Both current page and WAP APIs prioritize this absolute China-time
      // deadline. Relative WAP deadlines may be rounded up by Alipay to 5m.
      const expiry = order.expiresAt ? {
        time_expire: alipayTimestamp(Date.parse(order.expiresAt)),
      } : { timeout_express: '10m' };
      if (options.channel !== 'page' && options.channel !== 'wap') throw new TypeError('Unsupported Alipay channel');
      return sdk.pageExecute(options.channel === 'page' ? 'alipay.trade.page.pay' : 'alipay.trade.wap.pay', 'GET', {
        timestamp: alipayTimestamp(Date.now()),
        notifyUrl: httpsCallback(options.notifyUrl),
        returnUrl: httpsCallback(options.pageReturnUrl),
        bizContent: {
          out_trade_no: order.id,
          total_amount: totalAmount,
          subject: order.subject,
          product_code: options.channel === 'page' ? 'FAST_INSTANT_TRADE_PAY' : 'QUICK_WAP_WAY',
          seller_id: env.ALIPAY_SELLER_ID,
          ...expiry,
        },
      });
    },

    async query(outTradeNo: string): Promise<AlipayQueryResult | null> {
      const data = await tradeRequest('alipay.trade.query', outTradeNo);
      if (data.sub_code === 'ACQ.TRADE_NOT_EXIST') return null;
      if (data.code !== '10000') throw new AlipayError('ALIPAY_QUERY_REJECTED');
      if (data.out_trade_no !== outTradeNo || typeof data.trade_no !== 'string' || !/^\d{16,64}$/.test(data.trade_no)
        || !['WAIT_BUYER_PAY', 'TRADE_CLOSED', 'TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(data.trade_status))) {
        throw new AlipayError('ALIPAY_INVALID_RESPONSE');
      }
      const paymentTime = ['TRADE_SUCCESS','TRADE_FINISHED'].includes(String(data.trade_status)) ? queryPaidAt(data.send_pay_date) : undefined;
      return {
        outTradeNo,
        tradeNo: data.trade_no,
        tradeStatus: data.trade_status as AlipayQueryResult['tradeStatus'],
        totalAmount: normalizedAmount(data.total_amount),
        ...(typeof data.seller_id === 'string' ? { sellerId: data.seller_id } : {}),
        ...(typeof data.buyer_user_id === 'string' ? { buyerId: data.buyer_user_id } : {}),
        ...(paymentTime ? { paidAt: paymentTime } : {}),
      };
    },

    async close(outTradeNo: string): Promise<void> {
      const data = await tradeRequest('alipay.trade.close', outTradeNo);
      // A missing trade or a state race is not a successful close. The caller
      // must query again before deciding whether the order is closed or paid.
      if (data.code !== '10000') throw new AlipayError('ALIPAY_CLOSE_REJECTED');
      if (data.out_trade_no !== outTradeNo || (data.trade_no !== undefined
        && (typeof data.trade_no !== 'string' || !/^\d{16,64}$/.test(data.trade_no)))) {
        throw new AlipayError('ALIPAY_INVALID_RESPONSE');
      }
    },

    verifyNotification(form: Record<string, string>): boolean {
      if (form.sign_type !== 'RSA2' || typeof form.sign !== 'string' || !form.sign
        || Object.values(form).some(value => typeof value !== 'string')) return false;
      try {
        // URLSearchParams has already decoded each field once. V2 preserves '%' and '+' bytes.
        return sdk.checkNotifySignV2(form);
      } catch {
        return false;
      }
    },
  };
}

export type AlipayAdapter = ReturnType<typeof createAlipay>;
