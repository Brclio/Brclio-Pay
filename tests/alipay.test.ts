import { describe, expect, it, vi } from 'vitest';
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { createAlipay, type AlipayEnvironment } from '../src/alipay';

// Generated test keys exist only in process memory and are unrelated to the live application.
const app = generateKeyPairSync('rsa', { modulusLength: 2048 });
const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env: AlipayEnvironment = {
  ALIPAY_APP_ID: '2021007109602288',
  ALIPAY_SELLER_ID: '2088123456789012',
  ALIPAY_PRIVATE_KEY: app.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  ALIPAY_PUBLIC_KEY: provider.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  PAYMENT_MODE: 'sandbox',
};
const trade = {
  code: '10000', msg: 'Success', out_trade_no: 'pay_test',
  trade_no: '2026101322001400000000000000', trade_status: 'TRADE_SUCCESS',
  total_amount: '1.00', seller_id: env.ALIPAY_SELLER_ID, send_pay_date: '2026-10-13 20:00:01',
};
const closedTrade = { code: '10000', msg: 'Success', out_trade_no: 'pay_test', trade_no: trade.trade_no };
function signedEnvelope(data: unknown, key = 'alipay_trade_query_response', pretty = false): string {
  const raw = JSON.stringify(data, null, pretty ? 2 : undefined);
  const sign = createSign('RSA-SHA256').update(raw, 'utf8').sign(provider.privateKey, 'base64');
  return `{"${key}":${raw},"sign":${JSON.stringify(sign)}}`;
}
function transport(raw: string, observe?: (url: string, options?: RequestInit) => void): typeof fetch {
  return (async (url: RequestInfo | URL, options?: RequestInit) => {
    observe?.(String(url), options);
    return new Response(raw, { headers: { trace_id: 'fixture-trace' } });
  }) as typeof fetch;
}
function verifyRequest(url: string): URL {
  const request = new URL(url);
  const signature = request.searchParams.get('sign')!;
  const fields = new URLSearchParams(request.searchParams);
  fields.delete('sign');
  const message = [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
  expect(createVerify('RSA-SHA256').update(message, 'utf8').verify(app.publicKey, signature, 'base64')).toBe(true);
  expect(fields.get('sign_type')).toBe('RSA2');
  return request;
}

describe('official Alipay SDK RSA2 adapter', () => {
  it('verifies the raw signed query response including its original whitespace', async () => {
    let requestUrl = '';
    const alipay = createAlipay(env, transport(signedEnvelope(trade, undefined, true), (url, options) => {
      requestUrl = url;
      expect(options?.redirect).toBe('manual');
    }));
    expect(await alipay.query('pay_test')).toEqual({
      outTradeNo: 'pay_test', tradeNo: trade.trade_no, tradeStatus: 'TRADE_SUCCESS',
      totalAmount: '1.00', sellerId: env.ALIPAY_SELLER_ID, paidAt: '2026-10-13T12:00:01.000Z',
    });
    const request = verifyRequest(requestUrl);
    expect(request.hostname).toBe('openapi-sandbox.dl.alipaydev.com');
    expect(request.searchParams.get('method')).toBe('alipay.trade.query');
    expect(JSON.parse(request.searchParams.get('biz_content')!)).toEqual({ out_trade_no: 'pay_test' });
  });

  it('rejects a gateway redirect without following the signed query URL',async()=>{
    const send=vi.fn(async(_url:RequestInfo | URL,options?:RequestInit)=>{expect(options?.redirect).toBe('manual');return new Response(signedEnvelope(trade),{status:302,headers:{Location:'https://untrusted.example/'}});});
    await expect(createAlipay(env,send as typeof fetch).query('pay_test')).rejects.toMatchObject({code:'ALIPAY_HTTP_ERROR'});
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects unsigned and tampered responses before trusting business fields', async () => {
    const unsigned = JSON.stringify({ alipay_trade_query_response: trade });
    await expect(createAlipay(env, transport(unsigned)).query('pay_test')).rejects.toMatchObject({ code: 'ALIPAY_SIGNATURE_INVALID' });
    const tampered = signedEnvelope(trade).replace('TRADE_SUCCESS', 'TRADE_FINISHED');
    await expect(createAlipay(env, transport(tampered)).query('pay_test')).rejects.toMatchObject({ code: 'ALIPAY_SIGNATURE_INVALID' });
    const unsignedMissing = JSON.stringify({ alipay_trade_query_response: { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' } });
    await expect(createAlipay(env, transport(unsignedMissing)).query('pay_test')).rejects.toMatchObject({ code: 'ALIPAY_SIGNATURE_INVALID' });
  });

  it('returns null only for a verified trade-not-found response', async () => {
    const missing = signedEnvelope({ code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' }, 'error_response');
    expect(await createAlipay(env, transport(missing)).query('pay_test')).toBeNull();
    const rejected = signedEnvelope({ code: '40004', sub_code: 'ACQ.INVALID_PARAMETER' });
    await expect(createAlipay(env, transport(rejected)).query('pay_test')).rejects.toMatchObject({ code: 'ALIPAY_QUERY_REJECTED' });
  });

  it('verifies the original close response and signs the requested merchant order', async () => {
    let requestUrl = '';
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const alipay = createAlipay(env, transport(signedEnvelope(closedTrade, 'alipay_trade_close_response', true), (url, options) => {
        requestUrl = url;
        expect(options?.redirect).toBe('manual');
        expect(options?.signal).toBeInstanceOf(AbortSignal);
      }));
      await expect(alipay.close('pay_test')).resolves.toBeUndefined();
      const request = verifyRequest(requestUrl);
      expect(request.hostname).toBe('openapi-sandbox.dl.alipaydev.com');
      expect(request.searchParams.get('method')).toBe('alipay.trade.close');
      expect(JSON.parse(request.searchParams.get('biz_content')!)).toEqual({ out_trade_no: 'pay_test' });
      expect(timeout).toHaveBeenCalledWith(8000);
    } finally { timeout.mockRestore(); }
  });

  it('rejects unsigned, tampered, or unrelated close responses', async () => {
    const signed = signedEnvelope(closedTrade, 'alipay_trade_close_response');
    const responses = [
      JSON.stringify({ alipay_trade_close_response: closedTrade }),
      signed.replace('pay_test', 'pay_other'),
      signedEnvelope(closedTrade),
      JSON.stringify({ alipay_trade_close_response: { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' } }),
    ];
    for (const response of responses) {
      await expect(createAlipay(env, transport(response)).close('pay_test')).rejects.toMatchObject({ code: 'ALIPAY_SIGNATURE_INVALID' });
    }
  });

  it('requires the verified close success to match the merchant order', async () => {
    for (const changes of [{ out_trade_no: 'pay_other' }, { out_trade_no: undefined }, { trade_no: 'invalid' }]) {
      const raw = signedEnvelope({ ...closedTrade, ...changes }, 'alipay_trade_close_response');
      await expect(createAlipay(env, transport(raw)).close('pay_test')).rejects.toMatchObject({ code: 'ALIPAY_INVALID_RESPONSE' });
    }
  });

  it.each(['ACQ.TRADE_NOT_EXIST', 'ACQ.TRADE_STATUS_ERROR', 'ACQ.REASON_ILLEGAL_STATUS', 'ACQ.REASON_TRADE_STATUS_INVALID', 'ACQ.SYSTEM_ERROR'])('does not treat a signed close rejection as success: %s', async sub_code => {
    for (const key of ['alipay_trade_close_response', 'error_response']) {
      const raw = signedEnvelope({ code: '40004', sub_code, sub_msg: 'sensitive-provider-detail' }, key);
      let error: unknown;
      try { await createAlipay(env, transport(raw)).close('pay_test'); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: 'ALIPAY_CLOSE_REJECTED' });
      expect(String(error)).not.toContain('sensitive-provider-detail');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('rejects close redirects without following or disclosing the signed request', async () => {
    const send = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      expect(options?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/' } });
    });
    await expect(createAlipay(env, send as typeof fetch).close('pay_test')).rejects.toMatchObject({ code: 'ALIPAY_HTTP_ERROR' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid merchant close numbers before sending any request', async () => {
    const send = vi.fn();
    await expect(createAlipay(env, send as typeof fetch).close('pay_test&other=trade')).rejects.toThrow('Invalid merchant order number');
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['null', '[]', 'invalid-json'])('rejects a malformed trade response: %s', async raw => {
    for (const method of ['query', 'close'] as const) {
      await expect(createAlipay(env, transport(raw))[method]('pay_test')).rejects.toMatchObject({ code: 'ALIPAY_INVALID_RESPONSE' });
    }
  });

  it('rejects a verified response for another order or invalid amount/status', async () => {
    for (const changes of [{ out_trade_no: 'another' }, { total_amount: 'NaN' }, { trade_status: 'UNKNOWN' }]) {
      await expect(createAlipay(env, transport(signedEnvelope({ ...trade, ...changes }))).query('pay_test')).rejects.toMatchObject({ code: 'ALIPAY_INVALID_RESPONSE' });
    }
  });

  it.each(['not-a-time', '', null, '2026-02-30 12:00:00', '2026-10-13 24:00:00'])('rejects a present invalid signed query payment date: %j', async send_pay_date => {
    await expect(createAlipay(env, transport(signedEnvelope({ ...trade, send_pay_date }))).query('pay_test')).rejects.toMatchObject({ code: 'ALIPAY_INVALID_RESPONSE' });
  });

  it('retains compatibility with a verified response without a payment date', async () => {
    const { send_pay_date: _unused, ...withoutPaymentDate } = trade;
    expect(await createAlipay(env, transport(signedEnvelope(withoutPaymentDate))).query('pay_test')).toMatchObject({ tradeStatus: 'TRADE_SUCCESS' });
    expect(await createAlipay(env, transport(signedEnvelope(withoutPaymentDate))).query('pay_test')).not.toHaveProperty('paidAt');
  });

  it.each(['WAIT_BUYER_PAY','TRADE_CLOSED'])('does not interpret an empty payment date for an unpaid query: %s', async trade_status => {
    const result=await createAlipay(env,transport(signedEnvelope({...trade,trade_status,send_pay_date:''}))).query('pay_test');
    expect(result).toMatchObject({tradeStatus:trade_status});expect(result).not.toHaveProperty('paidAt');
  });

  it('produces signed desktop and mobile payment URLs with official product codes', () => {
    const alipay = createAlipay(env);
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    for (const channel of ['page', 'wap'] as const) {
      const url = alipay.paymentUrl({ id: 'pay_test', subject: '中文 100% + 商品', totalAmount: '1.00', expiresAt }, {
        channel, pageReturnUrl: 'https://pay.bornforthis.cn/result', notifyUrl: 'https://pay.bornforthis.cn/v1/alipay/notify',
      });
      const request = verifyRequest(url);
      const business = JSON.parse(request.searchParams.get('biz_content')!);
      expect(business.subject).toBe('中文 100% + 商品');
      expect(business.product_code).toBe(channel === 'page' ? 'FAST_INSTANT_TRADE_PAY' : 'QUICK_WAP_WAY');
      expect(business.seller_id).toBe(env.ALIPAY_SELLER_ID);
      expect(business.time_expire).toBe(new Date(Date.parse(expiresAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '));
      expect(business.timeout_express).toBeUndefined();
    }
  });

  it('preserves the original absolute deadline when the cashier is reopened later', () => {
    const alipay = createAlipay(env);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const order = { id: 'pay_test', subject: 'Test', totalAmount: '1.00', expiresAt: new Date(now + 10 * 60_000).toISOString() };
      const options = { channel: 'wap' as const, pageReturnUrl: 'https://pay.bornforthis.cn/result', notifyUrl: 'https://pay.bornforthis.cn/notify' };
      const first = JSON.parse(new URL(alipay.paymentUrl(order, options)).searchParams.get('biz_content')!);
      clock.mockReturnValue(now + 9 * 60_000);
      const reopened = JSON.parse(new URL(alipay.paymentUrl(order, options)).searchParams.get('biz_content')!);
      expect(reopened.time_expire).toBe(first.time_expire);
      expect(reopened.timeout_express).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it('uses a ten-minute fallback payment deadline for both channels', () => {
    const alipay = createAlipay(env);
    for (const channel of ['page', 'wap'] as const) {
      const url = alipay.paymentUrl({ id: 'pay_test', subject: 'Test', totalAmount: '1.00' }, {
        channel, pageReturnUrl: 'https://pay.bornforthis.cn/result', notifyUrl: 'https://pay.bornforthis.cn/notify',
      });
      expect(JSON.parse(verifyRequest(url).searchParams.get('biz_content')!).timeout_express).toBe('10m');
    }
  });

  it('rejects expired orders and non-HTTPS callbacks', () => {
    const alipay = createAlipay(env);
    const options = { channel: 'page' as const, pageReturnUrl: 'https://pay.bornforthis.cn/result', notifyUrl: 'https://pay.bornforthis.cn/notify' };
    expect(() => alipay.paymentUrl({ id: 'pay_test', subject: 'Test', totalAmount: '1.00', expiresAt: '2000-01-01T00:00:00Z' }, options)).toThrow('expired');
    expect(() => alipay.paymentUrl({ id: 'pay_test', subject: 'Test', totalAmount: '1.00' }, { ...options, notifyUrl: 'http://pay.bornforthis.cn/notify' })).toThrow('HTTPS');
  });

  it('verifies decoded notification fields once and enforces RSA2', () => {
    const fields: Record<string, string> = {
      app_id: env.ALIPAY_APP_ID, seller_id: env.ALIPAY_SELLER_ID, subject: '中文 100% + 商品', out_trade_no: 'pay_test', sign_type: 'RSA2',
    };
    const canonical = Object.keys(fields).filter(key => key !== 'sign_type').sort().map(key => `${key}=${fields[key]}`).join('&');
    fields.sign = createSign('RSA-SHA256').update(canonical, 'utf8').sign(provider.privateKey, 'base64');
    const alipay = createAlipay(env);
    expect(alipay.verifyNotification(fields)).toBe(true);
    expect(alipay.verifyNotification({ ...fields, subject: 'tampered' })).toBe(false);
    expect(alipay.verifyNotification({ ...fields, sign_type: 'RSA' })).toBe(false);
    expect(alipay.verifyNotification({ ...fields, sign: '' })).toBe(false);
  });

  it('rejects untrusted gateways, inconsistent modes, and invalid keys without exposing them', () => {
    expect(() => createAlipay({ ...env, ALIPAY_GATEWAY: 'https://attacker.example/gateway.do' })).toThrow('official');
    expect(() => createAlipay({ ...env, PAYMENT_MODE: 'live', ALIPAY_GATEWAY: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' })).toThrow('mode');
    expect(() => createAlipay({ ...env, ALIPAY_PUBLIC_KEY: '' })).toThrow('public key');
    let message = '';
    try { createAlipay({ ...env, ALIPAY_PRIVATE_KEY: 'sensitive-bad-key-fixture' }); } catch (error) { message = String(error); }
    expect(message).not.toContain('sensitive-bad-key-fixture');
  });

  it.each(['query', 'close'] as const)('sanitizes %s network errors without retaining authenticated request details', async method => {
    const alipay = createAlipay(env, (async () => { throw new Error('sensitive-provider-detail'); }) as typeof fetch);
    let error: unknown;
    try { await alipay[method]('pay_test'); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'ALIPAY_NETWORK_ERROR' });
    expect(String(error)).not.toContain('sensitive-provider-detail');
    expect((error as Error).cause).toBeUndefined();
  });
});
