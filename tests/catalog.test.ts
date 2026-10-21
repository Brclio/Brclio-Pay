import { describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { clients } from '../src/config';
import { Registry } from '../src/registry';
import type { ClientConfig } from '../src/registry';
import type { Env, ProductClient, Store, Transaction } from '../src/types';

class CatalogStore implements Store {
  data = new Map<string, unknown>();
  async readJson<T>(path: string): Promise<T | null> { return structuredClone(this.data.get(path) ?? null) as T | null; }
  async list(): Promise<string[]> { return [...this.data.keys()]; }
  async transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T> {
    const pending = new Map(this.data);
    const result = await action({ read: async <R>(path: string) => structuredClone(pending.get(path) ?? null) as R | null,
      put: (path, value) => { pending.set(path, structuredClone(value)); } });
    this.data = pending;
    return result;
  }
}

const product: ProductClient = {
  id: 'catalog-product', name: 'Catalog product', apiSecret: 'a'.repeat(64), webhookSecret: 'b'.repeat(64),
  webhookUrl: 'https://catalog.example/webhook', returnOrigins: ['https://catalog.example'],
  skus: { monthly: { subject: 'Monthly', amount: '9.90' } },
};
const other: ProductClient = { ...product, id: 'other-product', name: 'Other', apiSecret: 'c'.repeat(64), webhookSecret: 'd'.repeat(64) };
const environment = (items = [product, other]) => ({ CLIENTS_JSON: JSON.stringify(items), REGISTRY_ENCRYPTION_KEY: 'e'.repeat(64),
  PAY_BASE_URL: 'https://pay.bornforthis.cn', PAYMENT_MODE: 'live' }) as Env;
const config = (client: ProductClient): ClientConfig => ({ id: client.id, name: client.name, webhookUrl: client.webhookUrl,
  returnOrigins: client.returnOrigins, skus: structuredClone(client.skus), enabled: client.enabled });

describe('backward-compatible managed SKU catalog', () => {
  it('accepts original catalogs and validates optional sale state, description and entitlement metadata', () => {
    expect(clients(environment())[0].skus.monthly).toEqual({ subject: 'Monthly', amount: '9.90' });
    const enriched = { ...product, skus: { monthly: { subject: 'Monthly', amount: '9.90', enabled: false,
      description: 'Monthly product\nNo automatic renewal', entitlement: '30 days and 100 download credits' } } };
    expect(clients(environment([enriched]))[0].skus.monthly).toEqual(enriched.skus.monthly);
  });

  it.each([
    { enabled: 'false' }, { enabled: 0 }, { description: '' }, { description: 'x'.repeat(501) },
    { entitlement: '' }, { entitlement: 'x'.repeat(1001) }, { entitlement: { days: 30 } }, { description: 'bad\u0000value' },
  ])('rejects malformed SKU metadata before it can become a runtime catalog: %j', changes => {
    const malformed = { ...product, skus: { monthly: { ...product.skus.monthly, ...changes } } } as ProductClient;
    expect(() => clients(environment([malformed]))).toThrow();
  });

  it('persists catalog edits with target CAS while preserving all credentials and the other product', async () => {
    const store = new CatalogStore();
    const registry = new Registry(environment(), store);
    const before = (await registry.list()).find(item => item.id === product.id)!;
    const skus = { monthly: { subject: 'Monthly', amount: '12.90', enabled: true,
      description: 'New purchases', entitlement: '30 days; 120 download credits' },
    legacy: { subject: 'Legacy package', amount: '6.90', enabled: false, entitlement: 'Existing buyers retain original rights' } };
    const after = await registry.upsertClient({ ...config(product), skus }, before.version, 'catalog-admin');
    expect(after.skus).toEqual(skus);
    expect(after.version).not.toBe(before.version);
    expect((await registry.get(product.id))!.apiSecret).toBe(product.apiSecret);
    expect((await registry.get(product.id))!.webhookSecret).toBe(product.webhookSecret);
    expect(await registry.get(other.id)).toEqual({ ...other, enabled: true });
    expect(JSON.stringify([...store.data.values()])).not.toContain('120 download credits');
    await expect(registry.upsertClient({ ...config(product), skus }, before.version, 'catalog-admin'))
      .rejects.toMatchObject({ status: 409, code: 'CLIENT_VERSION_CONFLICT' });
    expect((await registry.get(product.id))!.skus).toEqual(skus);
  });

  it('carries metadata through scoped plan/apply and rejects unsupported operational fields', async () => {
    const registry = new Registry(environment(), new CatalogStore());
    const grant = await registry.createGrant({ clientId: product.id, mode: 'update', allowedOrigins: product.returnOrigins }, 'admin');
    const before = (await registry.grantContext(grant.token)).client!;
    const next = { ...config(product), skus: { monthly: { subject: 'Monthly', amount: '9.90', enabled: false,
      description: 'Temporarily unavailable', entitlement: '30 days' } } };
    const plan = await registry.plan(grant.token, { config: next, expectedVersion: before.version });
    expect(plan.before!.skus.monthly.amount).toBe('9.90');
    expect(plan.after.skus.monthly).toEqual(next.skus.monthly);
    const applied = await registry.apply(grant.token, { planId: plan.planId });
    expect(applied.client.skus).toEqual(next.skus);
    expect(applied.credentials).toEqual({ apiSecret: product.apiSecret, webhookSecret: product.webhookSecret });
    await expect(registry.upsertClient({ ...next, skus: { monthly: { ...next.skus.monthly, webhookSecret: 'hidden' } } } as ClientConfig,
      applied.client.version, 'admin')).rejects.toMatchObject({ status: 400 });
  });
});

describe('automatic and fixed domain integration grants', () => {
  it('keeps fixed grants strict and lets auto grants plan then record needed domains for only their target product', async () => {
    const store = new CatalogStore();
    const registry = new Registry(environment(), store);
    const fixed = await registry.createGrant({ clientId: product.id, mode: 'update', allowedOrigins: product.returnOrigins }, 'admin');
    expect(fixed.domainMode).toBe('fixed');
    expect(fixed.pricingMode).toBe('detect');
    const current = (await registry.grantContext(fixed.token)).client!;
    const changed = { ...config(product), webhookUrl: 'https://api.catalog.example/payment/webhook',
      returnOrigins: ['https://new.catalog.example'] };
    await expect(registry.plan(fixed.token, { config: changed, expectedVersion: current.version }))
      .rejects.toMatchObject({ status: 403, code: 'INTEGRATION_SCOPE' });
    const auto = await registry.createGrant({ clientId: product.id, mode: 'update', allowedOrigins: [], domainMode: 'auto', pricingMode: 'manual' }, 'admin');
    const context = await registry.grantContext(auto.token);
    expect(context).toMatchObject({ clientId: product.id, domainMode: 'auto', pricingMode: 'manual', allowedOrigins: [] });
    const plan = await registry.plan(auto.token, { config: changed, expectedVersion: current.version });
    expect(plan.addedOrigins).toEqual(['https://api.catalog.example', 'https://new.catalog.example']);
    expect((await registry.grantContext(auto.token)).allowedOrigins).toEqual([]);
    const applied = await registry.apply(auto.token, { planId: plan.planId });
    expect(applied.client.webhookUrl).toBe(changed.webhookUrl);
    expect((await registry.grantContext(auto.token)).allowedOrigins).toEqual(plan.addedOrigins);
    expect((await registry.listGrants()).find(item => item.id === auto.id)).toMatchObject({ domainMode: 'auto', pricingMode: 'manual', allowedOrigins: plan.addedOrigins });
    expect((await registry.audit()).find(item => item.action === 'integration.applied')!.addedOrigins).toEqual(plan.addedOrigins);
    expect((await registry.grantContext(fixed.token)).allowedOrigins).toEqual(product.returnOrigins);
    expect(await registry.get(other.id)).toEqual({ ...other, enabled: true });
    for (const view of [plan, await registry.listGrants(), await registry.audit()]) {
      for (const secret of [product.apiSecret, product.webhookSecret, other.apiSecret, other.webhookSecret, auto.token]) expect(JSON.stringify(view)).not.toContain(secret);
    }
    const otherVersion = (await registry.list()).find(item => item.id === other.id)!.version;
    await expect(registry.plan(auto.token, { config: config(other), expectedVersion: otherVersion }))
      .rejects.toMatchObject({ status: 403, code: 'INTEGRATION_SCOPE' });
  });

  it('rejects non-public, malformed or overbroad origins and invalid authorization modes without writes', async () => {
    const store = new CatalogStore();
    const registry = new Registry(environment(), store);
    for (const input of [
      { allowedOrigins: [] }, { allowedOrigins: [], domainMode: 'anything' },
      { allowedOrigins: [], domainMode: 'auto', pricingMode: 'invent' },
    ]) await expect(registry.createGrant({ clientId: product.id, mode: 'update', ...input } as Parameters<Registry['createGrant']>[0], 'admin'))
      .rejects.toMatchObject({ status: 400 });
    expect(store.data.size).toBe(0);
    const grant = await registry.createGrant({ clientId: product.id, mode: 'update', domainMode: 'auto', allowedOrigins: [] }, 'admin');
    const current = (await registry.grantContext(grant.token)).client!;
    for (const webhookUrl of ['http://api.catalog.example/hook', 'https://localhost/hook', 'https://127.0.0.1/hook',
      'https://internal/hook', 'https://user:password@api.catalog.example/hook', 'https://api.catalog.example/hook#fragment']) {
      await expect(registry.plan(grant.token, { config: { ...config(product), webhookUrl }, expectedVersion: current.version }))
        .rejects.toMatchObject({ status: 400 });
    }
    await expect(registry.plan(grant.token, { config: { ...config(product), returnOrigins: ['https://*.com'] }, expectedVersion: current.version }))
      .rejects.toMatchObject({ status: 400 });
    expect((await registry.grantContext(grant.token)).allowedOrigins).toEqual([]);
  });

  it('preserves revocation and expiry even when automatic domain expansion was authorized', async () => {
    const store = new CatalogStore();
    let now = Date.now();
    const registry = new Registry(environment(), store, () => now);
    const grant = await registry.createGrant({ clientId: product.id, mode: 'update', domainMode: 'auto', allowedOrigins: [] }, 'admin');
    const current = (await registry.grantContext(grant.token)).client!;
    const plan = await registry.plan(grant.token, { config: { ...config(product), returnOrigins: ['https://new.catalog.example'] }, expectedVersion: current.version });
    await registry.revokeGrant(grant.id, 'admin');
    await expect(registry.apply(grant.token, { planId: plan.planId })).rejects.toMatchObject({ status: 401 });
    const expiring = await registry.createGrant({ clientId: product.id, mode: 'update', domainMode: 'auto', allowedOrigins: [], lifetimeSeconds: 60 }, 'admin');
    now += 60_000;
    await expect(registry.grantContext(expiring.token)).rejects.toMatchObject({ status: 401 });
    expect(await registry.get(product.id)).toEqual({ ...product, enabled: true });
  });
});

describe('server payment client catalog access', () => {
  it('signs GET with an empty body and reads updated directory prices without retaining a stale catalog', async () => {
    const { createPaymentClient } = await import(new URL('../examples/payment-client.mjs', import.meta.url).href);
    let amount = '9.90';
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(url.href).toBe('https://pay.bornforthis.cn/api/v1/catalog');
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe('manual');
      expect(headers.get('X-Brclio-Client')).toBe(product.id);
      const timestamp = headers.get('X-Brclio-Timestamp')!;
      const nonce = headers.get('X-Brclio-Nonce')!;
      const raw = ['GET', '/api/v1/catalog', timestamp, nonce, createHash('sha256').update('').digest('hex')].join('\n');
      expect(headers.get('X-Brclio-Signature')).toBe(createHmac('sha256', product.apiSecret).update(raw).digest('hex'));
      expect(url.href).not.toContain(product.apiSecret);
      return new Response(JSON.stringify({ clientId: product.id, name: product.name, enabled: true, mode: 'live', currency: 'CNY',
        version: amount === '9.90' ? 'a'.repeat(64) : 'b'.repeat(64), skus: { monthly: { subject: 'Monthly', amount, enabled: true } } }),
      { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    });
    const client = createPaymentClient({ clientId: product.id, apiSecret: product.apiSecret, fetcher });
    expect((await client.catalog()).skus.monthly.amount).toBe('9.90');
    amount = '12.90';
    expect((await client.catalog()).skus.monthly.amount).toBe('12.90');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].headers).not.toEqual(fetcher.mock.calls[1][1].headers);
  });

  it('propagates catalog failure instead of fabricating a fallback price', async () => {
    const { createPaymentClient } = await import(new URL('../examples/payment-client.mjs', import.meta.url).href);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'NOT_READY', message: '目录暂不可用' } }), { status: 503 }));
    const client = createPaymentClient({ clientId: product.id, apiSecret: product.apiSecret, fetcher });
    await expect(client.catalog()).rejects.toThrow('目录暂不可用');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves the disabled payment code so a product can stop blind retries', async () => {
    const { createPaymentClient } = await import(new URL('../examples/payment-client.mjs', import.meta.url).href);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'PAYMENTS_DISABLED', message: '收款尚未启用' } }), { status: 503 }));
    const client = createPaymentClient({ clientId: product.id, apiSecret: product.apiSecret, fetcher });
    await expect(client.createOrder({ productOrderId: 'same-business-order', sku: 'monthly', returnUrl: 'https://catalog.example/return' }))
      .rejects.toMatchObject({ code: 'PAYMENTS_DISABLED', status: 503, message: '收款尚未启用' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
