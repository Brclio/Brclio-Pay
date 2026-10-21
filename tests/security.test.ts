import { describe, expect, it } from 'vitest';
import { authenticate, authenticateCheckout, checkoutToken } from '../src/auth';
import { allowedReturn, clients, money, requireReady } from '../src/config';
import { hmacSha256, randomId, sha256 } from '../src/crypto';
import type { Env, ProductClient } from '../src/types';

const NOW = Date.UTC(2026, 9, 13, 8);
const product: ProductClient = {
  id: 'brclio', name: 'Brclio', apiSecret: 'api-test-'.repeat(6), webhookSecret: 'webhook-test-'.repeat(5),
  webhookUrl: 'https://brclio.com/api/payment', returnOrigins: ['https://brclio.com', 'https://*.brclio.com'],
  skus: { pro: { subject: 'Brclio Pro', amount: '9.90' } },
};
function env(): Env {
  return {
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    PAY_BASE_URL: 'https://pay.bornforthis.cn', PAYMENT_MODE: 'live', PAYMENT_ENABLED: 'true',
    ALIPAY_CHANNELS: 'page', ALIPAY_APP_ID: '2021007109602288',
    ALIPAY_PRIVATE_KEY: 'fixture-private', ALIPAY_PUBLIC_KEY: 'fixture-public', ALIPAY_SELLER_ID: '2088123456789012',
    GITHUB_TOKEN: 'fixture-token', GITHUB_REPOSITORY: 'owner/private-data', GITHUB_BRANCH: 'main',
    CHECKOUT_SECRET: 'checkout-fixture-'.repeat(4), CLIENTS_JSON: JSON.stringify([product]),
  };
}

function signedRequest(options: { method?: string; path?: string; body?: string; client?: ProductClient; timestamp?: string; nonce?: string } = {}) {
  const method = options.method ?? 'POST';
  const path = options.path ?? '/api/v1/orders';
  const body = options.body ?? '{"productOrderId":"order-1","sku":"pro","returnUrl":"https://brclio.com/account"}';
  const client = options.client ?? product;
  const timestamp = options.timestamp ?? String(Math.floor(NOW / 1000));
  const nonce = options.nonce ?? 'valid_nonce_123456789';
  const pathname = new URL(path, 'https://pay.bornforthis.cn').pathname;
  const canonical = [method, pathname, timestamp, nonce, sha256(body)].join('\n');
  const headers = {
    'X-Brclio-Client': client.id, 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Nonce': nonce,
    'X-Brclio-Signature': hmacSha256(client.apiSecret, canonical),
  };
  const request = new Request('https://pay.bornforthis.cn' + path, { method, headers, ...(method === 'GET' ? {} : { body }) });
  return { request, body };
}

describe('product authentication', () => {
  it('authenticates exact request bytes and empty-body GET', () => {
    const signed = signedRequest();
    expect(authenticate(signed.request, signed.body, env(), NOW).id).toBe(product.id);
    const get = signedRequest({ method: 'GET', path: '/api/v1/orders/pay_' + '1'.repeat(32), body: '' });
    expect(authenticate(get.request, '', env(), NOW).id).toBe(product.id);
  });

  it('rejects reserialized, altered or incorrectly signed request bodies', () => {
    const signed = signedRequest();
    expect(() => authenticate(signed.request, signed.body + '\n', env(), NOW)).toThrowError();
    expect(() => authenticate(signed.request, signed.body.replace('"pro"', '"annual"'), env(), NOW)).toThrowError();
    const headers = new Headers(signed.request.headers);
    headers.set('X-Brclio-Signature', '0'.repeat(64));
    expect(() => authenticate(new Request(signed.request.url, { method: 'POST', headers }), signed.body, env(), NOW)).toThrowError();
  });

  it('binds authentication to the method and path and disallows query strings', () => {
    const signed = signedRequest();
    const headers = signed.request.headers;
    expect(() => authenticate(new Request(signed.request.url + '/other', { method: 'POST', headers }), signed.body, env(), NOW)).toThrowError();
    expect(() => authenticate(new Request(signed.request.url, { method: 'GET', headers }), signed.body, env(), NOW)).toThrowError();
    const query = signedRequest({ path: '/api/v1/orders?client=brclio' });
    expect(() => authenticate(query.request, query.body, env(), NOW)).toThrowError();
  });

  it.each([-301, 301])('rejects a timestamp outside the 5-minute window (%s seconds)', seconds => {
    const signed = signedRequest({ timestamp: String(Math.floor(NOW / 1000) + seconds) });
    expect(() => authenticate(signed.request, signed.body, env(), NOW)).toThrowError();
  });

  it.each(['short', 'has spaces 123456789', 'nonce_with/slash_123456', 'n'.repeat(81)])('rejects malformed request nonce %s', nonce => {
    const signed = signedRequest({ nonce });
    expect(() => authenticate(signed.request, signed.body, env(), NOW)).toThrowError();
  });

  it('cannot authenticate another product using the first product secret', () => {
    const configuration = env();
    const other = { ...product, id: 'second-product', apiSecret: 'different-api-secret-'.repeat(3) };
    configuration.CLIENTS_JSON = JSON.stringify([product, other]);
    const signed = signedRequest();
    const headers = new Headers(signed.request.headers);
    headers.set('X-Brclio-Client', other.id);
    expect(() => authenticate(new Request(signed.request.url, { method: 'POST', headers }), signed.body, configuration, NOW)).toThrowError();
    const validOther = signedRequest({ client: other });
    expect(authenticate(validOther.request, validOther.body, configuration, NOW).id).toBe(other.id);
  });
});

describe('checkout capability and return URL boundaries', () => {
  it('binds the checkout token to one order and rejects cross-origin checkout calls', () => {
    const configuration = env();
    const first = randomId('pay_');
    const second = randomId('pay_');
    const headers = { Authorization: 'Bearer ' + checkoutToken(first, configuration), Origin: configuration.PAY_BASE_URL };
    const request = new Request(configuration.PAY_BASE_URL + '/api/checkout/' + first, { headers });
    expect(() => authenticateCheckout(request, first, configuration)).not.toThrow();
    expect(() => authenticateCheckout(request, second, configuration)).toThrowError();
    expect(() => authenticateCheckout(new Request(request.url, { headers: { ...headers, Origin: 'https://brclio.com' } }), first, configuration)).toThrowError();
  });

  it('permits explicitly registered origins and properly bounded subdomains', () => {
    expect(allowedReturn('https://brclio.com/account?tab=billing', product.returnOrigins)).toBe('https://brclio.com/account?tab=billing');
    expect(allowedReturn('https://app.brclio.com/payment', product.returnOrigins)).toBe('https://app.brclio.com/payment');
    expect(allowedReturn('https://deep.app.brclio.com/payment', product.returnOrigins)).toBe('https://deep.app.brclio.com/payment');
    expect(() => allowedReturn('https://brclio.com/payment', ['https://*.brclio.com'])).toThrowError();
  });

  it.each([
    'https://brclio.com.evil.example/payment', 'https://evilbrclio.com/payment',
    'https://brclio.com@evil.example/payment', 'https://evil.example@brclio.com/payment',
    'http://brclio.com/payment', 'javascript:alert(1)', 'https://app.brclio.com:8443/payment',
    'https://brclio.com/payment#pretend-paid', 'https://brclio.com./payment',
  ])('rejects unsafe or unregistered return address %s', value => {
    expect(() => allowedReturn(value, product.returnOrigins)).toThrowError();
  });
});

describe('fail-closed configuration', () => {
  it.each(['0.00', '0.01e3', '-1.00', '1', '1.0', '01.00', '1000000.00', 1.01, null])('rejects invalid monetary input %j', value => {
    expect(() => money(value)).toThrowError();
  });

  it('requires all runtime credentials and a deliberate payment enable switch', () => {
    const configuration = env();
    expect(() => requireReady(configuration, true)).not.toThrow();
    expect(() => requireReady({ ...configuration, ALIPAY_PUBLIC_KEY: '' }, true)).toThrowError();
    expect(() => requireReady({ ...configuration, PAYMENT_ENABLED: 'false' }, true)).toThrowError();
    expect(() => requireReady({ ...configuration, PAYMENT_ENABLED: 'false' }, false)).not.toThrow();
  });

  it('rejects mismatched sandbox and production gateway settings', () => {
    const configuration = env();
    expect(() => requireReady({ ...configuration, PAYMENT_MODE: 'sandbox' })).toThrowError();
    expect(() => requireReady({ ...configuration, PAYMENT_MODE: 'live', ALIPAY_GATEWAY: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' })).toThrowError();
    expect(() => requireReady({ ...configuration, PAYMENT_MODE: 'sandbox', ALIPAY_GATEWAY: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' })).not.toThrow();
  });

  it.each(['https://localhost/payment', 'https://127.0.0.1/payment', 'https://[::1]/payment', 'http://brclio.com/payment', 'https://brclio.com/payment?token=secret'])('rejects unsafe configured webhook %s', webhookUrl => {
    const configuration = env();
    configuration.CLIENTS_JSON = JSON.stringify([{ ...product, webhookUrl }]);
    expect(() => clients(configuration)).toThrowError();
  });

  it('rejects duplicate product IDs', () => {
    const configuration = env();
    configuration.CLIENTS_JSON = JSON.stringify([product, product]);
    expect(() => clients(configuration)).toThrowError();
  });
});
