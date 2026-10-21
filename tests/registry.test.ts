import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createDecipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Env, ProductClient, Store, Transaction } from '../src/types';
import { Registry, REGISTRY_PATH, type ClientConfig, type ClientView, type RegistryEnvironment } from '../src/registry';
import { handleIntegration } from '../src/integration';

const alpha: ProductClient = {
  id: 'alpha', name: 'Alpha', apiSecret: 'alpha-api-secret-'.repeat(4), webhookSecret: 'alpha-hook-secret-'.repeat(4),
  webhookUrl: 'https://alpha.brclio.com/api/payment', returnOrigins: ['https://alpha.brclio.com', 'https://old.alpha.example'],
  skus: { pro: { subject: 'Alpha Pro', amount: '9.90' } },
};
const beta: ProductClient = {
  id: 'beta', name: 'Beta', apiSecret: 'beta-api-secret-'.repeat(4), webhookSecret: 'beta-hook-secret-'.repeat(4),
  webhookUrl: 'https://beta.brclio.com/api/payment', returnOrigins: ['https://beta.brclio.com'],
  skus: { annual: { subject: 'Beta Annual', amount: '19.90' } },
};
function env(seed: ProductClient[] = [alpha, beta]): RegistryEnvironment {
  return {
    ASSETS: { fetch: async () => new Response('fixture') } as unknown as Fetcher,
    PAY_BASE_URL: 'https://pay.bornforthis.cn', PAYMENT_MODE: 'sandbox', PAYMENT_ENABLED: 'false',
    ALIPAY_CHANNELS: 'page,wap', ALIPAY_APP_ID: '2021007109602288', ALIPAY_PRIVATE_KEY: 'merchant-private-fixture',
    ALIPAY_PUBLIC_KEY: 'merchant-public-fixture', ALIPAY_SELLER_ID: '2088123456789012',
    GITHUB_TOKEN: 'private-github-token-fixture', GITHUB_REPOSITORY: 'owner/private-data', GITHUB_BRANCH: 'main',
    CHECKOUT_SECRET: 'checkout-secret-fixture-'.repeat(3), CLIENTS_JSON: JSON.stringify(seed), REGISTRY_ENCRYPTION_KEY: '5a'.repeat(32),
  } as Env;
}
function config(client: ProductClient | ClientView): ClientConfig {
  return { id: client.id, name: client.name, webhookUrl: client.webhookUrl,
    returnOrigins: [...client.returnOrigins], skus: structuredClone(client.skus), ...(client.enabled === undefined ? {} : { enabled: client.enabled }) };
}
function newConfig(id = 'gamma'): ClientConfig {
  return { id, name: id.toUpperCase(), webhookUrl: `https://${id}.brclio.com/api/payment`,
    returnOrigins: [`https://${id}.brclio.com`], skus: { pro: { subject: `${id} Pro`, amount: '29.90' } } };
}

/** Models GitHub's optimistic callback retry when another commit advances the ref. */
class MemoryStore implements Store {
  data = new Map<string, unknown>();
  commits = 0;
  callbacks = 0;
  writes: { path: string; value: unknown }[] = [];
  async readJson<T>(path: string): Promise<T | null> { return structuredClone((this.data.get(path) ?? null) as T | null); }
  async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt++) {
      this.callbacks++;
      const base = this.commits;
      const snapshot = structuredClone(this.data);
      const writes = new Map<string, unknown>();
      const result = await callback({
        read: async <V>(path: string) => structuredClone((writes.has(path) ? writes.get(path) : snapshot.get(path) ?? null) as V | null),
        put: (path, value) => { writes.set(path, structuredClone(value)); },
      });
      if (writes.size === 0) return result;
      if (base !== this.commits) continue;
      for (const [path, value] of writes) {
        this.data.set(path, value);
        this.writes.push({ path, value: structuredClone(value) });
      }
      this.commits++;
      return result;
    }
    throw new Error('Fixture transaction retry exhausted');
  }
}

function decrypt(store: MemoryStore, environment: RegistryEnvironment): Record<string, any> {
  const envelope = store.data.get(REGISTRY_PATH) as { iv: string; ciphertext: string };
  const payload = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(environment.REGISTRY_ENCRYPTION_KEY!, 'hex'), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(`brclio-pay:registry:v1:${REGISTRY_PATH}`));
  decipher.setAuthTag(payload.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString('utf8'));
}

describe('encrypted tenant registry', () => {
  // This test starts a separate workerd process; shared CI runners can need
  // more than Vitest's five-second unit-test budget for its cold start.
  it('encrypts, decrypts, and applies scoped onboarding inside real workerd', async () => {
    const [{ build }, { convertV4MiniflareOptions, Log, LogLevel, Miniflare }] = await Promise.all([import('esbuild'), import('miniflare')]);
    const root = fileURLToPath(new URL('../', import.meta.url).href);
    const environment = env();
    const compiled = await build({
      absWorkingDir: root, entryPoints: ['tests/registry-runtime-worker.ts'],
      bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], logLevel: 'silent',
    });
    const runtime = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: compiled.outputFiles[0].text,
      compatibilityDate: '2026-10-13', compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0,
      log: new Log(LogLevel.NONE), handleStructuredLogs: () => {},
      bindings: { CLIENTS_JSON: environment.CLIENTS_JSON, REGISTRY_ENCRYPTION_KEY: environment.REGISTRY_ENCRYPTION_KEY! },
    }));
    try {
      const response = await runtime.dispatchFetch('http://registry-runtime.test/', { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ encrypted: true, plaintextAbsent: true, preserved: true, scoped: true, idempotent: true, uniqueIv: true, paymentMode: true });
    } finally { await runtime.dispose(); }
  }, 30_000);

  it('reads legacy clients without mutation and imports every tenant atomically on first update', async () => {
    const store = new MemoryStore();
    const environment = env();
    const registry = new Registry(environment, store);
    const listed = await registry.list();
    expect(listed.map(client => client.id)).toEqual(['alpha', 'beta']);
    expect(JSON.stringify(listed)).not.toContain(alpha.apiSecret);
    expect(store.commits).toBe(0);
    const updated = await registry.upsertClient({ ...config(alpha), name: 'Alpha Updated' }, listed[0].version, 'admin@example.com');
    expect(updated.name).toBe('Alpha Updated');
    expect(updated.version).not.toBe(listed[0].version);
    expect(store.commits).toBe(1);
    expect(await registry.get('beta')).toEqual({ ...beta, enabled: true });
    expect((await registry.get('alpha'))!.apiSecret).toBe(alpha.apiSecret);
    expect((await registry.get('alpha'))!.webhookSecret).toBe(alpha.webhookSecret);
    const persisted = decrypt(store, environment);
    expect(persisted.clients).toHaveLength(2);
    expect(persisted.clients.find((client: ProductClient) => client.id === 'beta')).toEqual({ ...beta, enabled: true });
    expect(persisted.audit[0]).toMatchObject({ action: 'client.updated', clientId: 'alpha' });
    expect(store.writes.every(write => write.path === REGISTRY_PATH)).toBe(true);
    const encrypted = JSON.stringify(store.writes);
    for (const secret of [alpha.apiSecret, alpha.webhookSecret, beta.apiSecret, environment.GITHUB_TOKEN, environment.ALIPAY_PRIVATE_KEY]) {
      expect(encrypted).not.toContain(secret);
    }
    expect(encrypted).not.toContain('Alpha Updated');
  });

  it('uses the encrypted registry after migration even when the legacy secret changes', async () => {
    const store = new MemoryStore();
    const environment = env();
    const registry = new Registry(environment, store);
    await registry.upsertClient(newConfig(), 'absent', 'admin');
    const changedEnv = { ...environment, CLIENTS_JSON: JSON.stringify([{ ...beta, name: 'Wrong Legacy' }]) };
    const authoritative = new Registry(changedEnv, store);
    expect((await authoritative.list()).map(client => client.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect((await authoritative.get('beta'))!.name).toBe('Beta');
  });

  it('requires a registry key for mutation and refuses tampered or wrongly keyed ciphertext without falling back', async () => {
    const store = new MemoryStore();
    const environment = env();
    const missingKey = new Registry({ ...environment, REGISTRY_ENCRYPTION_KEY: '' }, store);
    expect(await missingKey.list()).toHaveLength(2);
    await expect(missingKey.upsertClient(newConfig(), 'absent', 'admin')).rejects.toMatchObject({ status: 503, code: 'REGISTRY_KEY_REQUIRED' });
    expect(store.commits).toBe(0);
    await new Registry(environment, store).upsertClient(newConfig(), 'absent', 'admin');
    await expect(missingKey.list()).rejects.toMatchObject({ status: 503, code: 'REGISTRY_KEY_REQUIRED' });
    await expect(new Registry({ ...environment, REGISTRY_ENCRYPTION_KEY: 'ab'.repeat(32) }, store).list()).rejects.toMatchObject({ code: 'REGISTRY_DECRYPT_FAILED' });
    const envelope = store.data.get(REGISTRY_PATH) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`;
    await expect(new Registry(environment, store).list()).rejects.toMatchObject({ code: 'REGISTRY_DECRYPT_FAILED' });
  });

  it('compares only the target tenant version and preserves unrelated concurrent changes', async () => {
    const store = new MemoryStore();
    const registry = new Registry(env(), store);
    const [a, b] = await registry.list();
    await Promise.all([
      registry.upsertClient({ ...config(alpha), name: 'Concurrent Alpha' }, a.version, 'admin-a'),
      registry.upsertClient({ ...config(beta), name: 'Concurrent Beta' }, b.version, 'admin-b'),
    ]);
    expect((await registry.get('alpha'))!.name).toBe('Concurrent Alpha');
    expect((await registry.get('beta'))!.name).toBe('Concurrent Beta');
    expect(store.callbacks).toBeGreaterThan(store.commits);
    await expect(registry.upsertClient({ ...config(alpha), name: 'Stale Alpha' }, a.version, 'admin')).rejects.toMatchObject({ status: 409, code: 'CLIENT_VERSION_CONFLICT' });
    expect((await registry.get('alpha'))!.name).toBe('Concurrent Alpha');
  });

  it('supports disablement while retaining the same tenant credentials and rejects credential rotation fields', async () => {
    const store = new MemoryStore();
    const registry = new Registry(env(), store);
    const current = (await registry.list())[0];
    const disabled = await registry.upsertClient({ ...config(alpha), enabled: false }, current.version, 'admin');
    expect(disabled.enabled).toBe(false);
    expect((await registry.get('alpha'))!.apiSecret).toBe(alpha.apiSecret);
    const renamed = await registry.upsertClient({ ...config(alpha), name: 'Still Disabled' }, disabled.version, 'admin');
    expect(renamed.enabled).toBe(false);
    await expect(registry.upsertClient({ ...config(alpha), apiSecret: 'attacker'.repeat(8) } as ClientConfig, renamed.version, 'admin')).rejects.toMatchObject({ status: 400 });
  });

  it('validates public client data strictly before saving', async () => {
    const store = new MemoryStore();
    const registry = new Registry(env([]), store);
    for (const changes of [
      { webhookUrl: 'http://gamma.brclio.com/hook' }, { webhookUrl: 'https://127.0.0.1/hook' },
      { returnOrigins: ['https://gamma.brclio.com/path'] }, { enabled: 'true' },
      { skus: { pro: { subject: 'Bad', amount: '0.00' } } },
      { skus: { pro: { subject: 'Bad', amount: '1.00', extra: true } } },
    ]) {
      await expect(registry.upsertClient({ ...newConfig(), ...changes } as ClientConfig, 'absent', 'admin')).rejects.toMatchObject({ status: 400 });
    }
    expect(store.commits).toBe(0);
  });
});

describe('scoped integration grants and plans', () => {
  it('persists only a token hash inside ciphertext and returns only the scoped product context', async () => {
    const store = new MemoryStore();
    const environment = env();
    const registry = new Registry(environment, store);
    const grant = await registry.createGrant({ clientId: 'alpha', mode: 'update', allowedOrigins: ['https://alpha.brclio.com'] }, 'admin');
    expect(grant.token).toMatch(/^brp_int_[a-f0-9]{64}$/);
    const context = await registry.grantContext(grant.token);
    expect(context.client?.id).toBe('alpha');
    expect(context.credentials).toEqual({ apiSecret: alpha.apiSecret, webhookSecret: alpha.webhookSecret });
    for (const secret of [beta.apiSecret, beta.webhookSecret, environment.GITHUB_TOKEN, environment.ALIPAY_PRIVATE_KEY]) {
      expect(JSON.stringify(context)).not.toContain(secret);
    }
    const state = decrypt(store, environment);
    expect(state.grants[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(state)).not.toContain(grant.token);
    expect(JSON.stringify(await registry.listGrants())).not.toContain(state.grants[0].tokenHash);
    expect(JSON.stringify(store.writes)).not.toContain(grant.token);
    await expect(registry.grantContext(`brp_int_${'f'.repeat(64)}`)).rejects.toMatchObject({ status: 401 });
  });

  it('plans and applies creation idempotently and never overwrites another product', async () => {
    const store = new MemoryStore();
    const environment = env();
    let now = Date.now();
    const registry = new Registry(environment, store, () => now);
    const grant = await registry.createGrant({ clientId: 'gamma', mode: 'create', allowedOrigins: ['https://gamma.brclio.com'] }, 'admin');
    expect((await registry.grantContext(grant.token)).credentials).toBeNull();
    const plan = await registry.plan(grant.token, { config: newConfig(), expectedVersion: 'absent' });
    expect(plan.before).toBeNull();
    expect(await registry.get('gamma')).toBeNull();
    const applied = await registry.apply(grant.token, { planId: plan.planId });
    expect(applied.client.id).toBe('gamma');
    expect(applied.credentials.apiSecret).toMatch(/^[a-f0-9]{64}$/);
    const commits = store.commits;
    expect(await registry.apply(grant.token, { planId: plan.planId })).toEqual(applied);
    expect(store.commits).toBe(commits);
    const changed = await registry.upsertClient({ ...newConfig(), name: 'Later Admin Edit' }, applied.client.version, 'admin');
    now += 16 * 60_000;
    expect(await registry.apply(grant.token, { planId: plan.planId })).toEqual(applied);
    expect((await registry.get('gamma'))!.name).toBe(changed.name);
    expect((await registry.grantContext(grant.token)).credentials).toEqual(applied.credentials);
    expect(await registry.get('alpha')).toEqual({ ...alpha, enabled: true });
    expect(await registry.get('beta')).toEqual({ ...beta, enabled: true });
  });

  it('keeps update credentials, allows unchanged old destinations, and limits newly changed destinations', async () => {
    const store = new MemoryStore();
    const registry = new Registry(env(), store);
    const grant = await registry.createGrant({ clientId: 'alpha', mode: 'update', allowedOrigins: ['https://alpha.brclio.com'] }, 'admin');
    const current = (await registry.grantContext(grant.token)).client!;
    const good = await registry.plan(grant.token, { config: { ...config(current), name: 'AI Updated Alpha' }, expectedVersion: current.version });
    expect(good.after.returnOrigins).toContain('https://old.alpha.example');
    const updated = await registry.apply(grant.token, { planId: good.planId });
    expect(updated.credentials).toEqual({ apiSecret: alpha.apiSecret, webhookSecret: alpha.webhookSecret });
    for (const changes of [
      { id: 'beta' }, { webhookUrl: 'https://evil.example/api/payment' },
      { returnOrigins: [...current.returnOrigins, 'https://evil.example'] },
      { returnOrigins: ['https://*.brclio.com'] },
    ]) {
      await expect(registry.plan(grant.token, { config: { ...config(updated.client), ...changes }, expectedVersion: updated.client.version })).rejects.toMatchObject({ status: 403, code: 'INTEGRATION_SCOPE' });
    }
  });

  it('limits wildcard scopes to descendants and rejects the parent or sibling domain', async () => {
    const store = new MemoryStore();
    const registry = new Registry(env([]), store);
    const grant = await registry.createGrant({ clientId: 'gamma', mode: 'create', allowedOrigins: ['https://*.brclio.com'] }, 'admin');
    expect((await registry.plan(grant.token, { config: { ...newConfig(), returnOrigins: ['https://*.gamma.brclio.com'] }, expectedVersion: 'absent' })).after.id).toBe('gamma');
    for (const origin of ['https://brclio.com', 'https://notbrclio.com', 'https://*.com']) {
      await expect(registry.plan(grant.token, { config: { ...newConfig(), returnOrigins: [origin] }, expectedVersion: 'absent' })).rejects.toMatchObject({ status: origin.endsWith('*.com') ? 400 : 403 });
    }
  });

  it('checks grant mode and prevents a create grant from reading a product created by another actor', async () => {
    const store = new MemoryStore();
    const registry = new Registry(env(), store);
    await expect(registry.createGrant({ clientId: 'alpha', mode: 'create', allowedOrigins: ['https://alpha.brclio.com'] }, 'admin')).rejects.toMatchObject({ code: 'GRANT_MODE_CONFLICT' });
    await expect(registry.createGrant({ clientId: 'gamma', mode: 'update', allowedOrigins: ['https://gamma.brclio.com'] }, 'admin')).rejects.toMatchObject({ code: 'GRANT_MODE_CONFLICT' });
    const grant = await registry.createGrant({ clientId: 'gamma', mode: 'create', allowedOrigins: ['https://gamma.brclio.com'] }, 'admin');
    const plan = await registry.plan(grant.token, { config: newConfig(), expectedVersion: 'absent' });
    await registry.upsertClient(newConfig(), 'absent', 'other-admin');
    await expect(registry.grantContext(grant.token)).rejects.toMatchObject({ status: 409 });
    await expect(registry.apply(grant.token, { planId: plan.planId })).rejects.toMatchObject({ status: 409, code: 'CLIENT_VERSION_CONFLICT' });
  });

  it('binds plans to their grant and detects stale target changes while preserving unrelated updates', async () => {
    const store = new MemoryStore();
    const registry = new Registry(env(), store);
    const grant = await registry.createGrant({ clientId: 'alpha', mode: 'update', allowedOrigins: ['https://alpha.brclio.com'] }, 'admin');
    const other = await registry.createGrant({ clientId: 'alpha', mode: 'update', allowedOrigins: ['https://alpha.brclio.com'] }, 'admin');
    const current = (await registry.grantContext(grant.token)).client!;
    const plan = await registry.plan(grant.token, { config: { ...config(current), name: 'Planned Alpha' }, expectedVersion: current.version });
    await expect(registry.apply(other.token, { planId: plan.planId })).rejects.toMatchObject({ status: 404 });
    const b = (await registry.list()).find(client => client.id === 'beta')!;
    await registry.upsertClient({ ...config(b), name: 'Unrelated Beta' }, b.version, 'admin');
    const applied = await registry.apply(grant.token, { planId: plan.planId });
    expect(applied.client.name).toBe('Planned Alpha');
    expect((await registry.get('beta'))!.name).toBe('Unrelated Beta');
    const stale = await registry.plan(grant.token, { config: { ...config(applied.client), name: 'Stale Planned Alpha' }, expectedVersion: applied.client.version });
    await registry.upsertClient({ ...config(applied.client), name: 'Newer Alpha' }, applied.client.version, 'admin');
    await expect(registry.apply(grant.token, { planId: stale.planId })).rejects.toMatchObject({ status: 409, code: 'CLIENT_VERSION_CONFLICT' });
    expect((await registry.get('alpha'))!.name).toBe('Newer Alpha');
  });

  it('merges an AI apply and an unrelated simultaneous admin update through storage retries', async () => {
    const store = new MemoryStore();
    const registry = new Registry(env(), store);
    const grant = await registry.createGrant({ clientId: 'alpha', mode: 'update', allowedOrigins: ['https://alpha.brclio.com'] }, 'admin');
    const current = (await registry.grantContext(grant.token)).client!;
    const plan = await registry.plan(grant.token, { config: { ...config(current), name: 'Concurrent AI Alpha' }, expectedVersion: current.version });
    const b = (await registry.list()).find(client => client.id === 'beta')!;
    const [applied] = await Promise.all([
      registry.apply(grant.token, { planId: plan.planId }),
      registry.upsertClient({ ...config(b), name: 'Concurrent Admin Beta' }, b.version, 'admin'),
    ]);
    expect((await registry.get('alpha'))!.name).toBe('Concurrent AI Alpha');
    expect((await registry.get('beta'))!.name).toBe('Concurrent Admin Beta');
    const commits = store.commits;
    expect(await registry.apply(grant.token, { planId: plan.planId })).toEqual(applied);
    expect(store.commits).toBe(commits);
  });

  it('expires unapplied plans after 15 minutes and grants after two hours, then prunes expired records', async () => {
    const store = new MemoryStore();
    const environment = env();
    let now = Date.now();
    const registry = new Registry(environment, store, () => now);
    const grant = await registry.createGrant({ clientId: 'gamma', mode: 'create', allowedOrigins: ['https://gamma.brclio.com'] }, 'admin');
    const plan = await registry.plan(grant.token, { config: newConfig(), expectedVersion: 'absent' });
    now += 15 * 60_000;
    await expect(registry.apply(grant.token, { planId: plan.planId })).rejects.toMatchObject({ status: 410 });
    now += 2 * 60 * 60_000;
    await expect(registry.grantContext(grant.token)).rejects.toMatchObject({ status: 401 });
    expect(await registry.listGrants()).toEqual([]);
    await registry.upsertClient(newConfig('delta'), 'absent', 'admin');
    expect(decrypt(store, environment).grants).toEqual([]);
    expect(decrypt(store, environment).plans).toEqual([]);
  });

  it('revokes exactly one copied task immediately and preserves other grants and all tenant credentials', async () => {
    const store = new MemoryStore();
    const registry = new Registry(env(), store);
    const revoked = await registry.createGrant({ clientId: 'alpha', mode: 'update', allowedOrigins: ['https://alpha.brclio.com'] }, 'admin');
    const retained = await registry.createGrant({ clientId: 'beta', mode: 'update', allowedOrigins: ['https://beta.brclio.com'] }, 'admin');
    const before = (await registry.grantContext(revoked.token)).client!;
    const input = { config: { ...config(before), name: 'Unapplied change' }, expectedVersion: before.version };
    const plan = await registry.plan(revoked.token, input);
    await registry.revokeGrant(revoked.id, 'admin');
    const commits = store.commits;
    await registry.revokeGrant(revoked.id, 'admin');
    expect(store.commits).toBe(commits);
    await expect(registry.grantContext(revoked.token)).rejects.toMatchObject({ status: 401 });
    await expect(registry.plan(revoked.token, input)).rejects.toMatchObject({ status: 401 });
    await expect(registry.apply(revoked.token, { planId: plan.planId })).rejects.toMatchObject({ status: 401 });
    expect((await registry.grantContext(retained.token)).credentials).toEqual({ apiSecret: beta.apiSecret, webhookSecret: beta.webhookSecret });
    expect((await registry.listGrants()).find(item => item.id === revoked.id)!.revokedAt).toEqual(expect.any(String));
    expect((await registry.listGrants()).find(item => item.id === retained.id)!.revokedAt).toBeUndefined();
    expect(await registry.get('alpha')).toEqual({ ...alpha, enabled: true });
    expect(await registry.get('beta')).toEqual({ ...beta, enabled: true });
    expect((await registry.audit()).filter(item => item.action === 'grant.revoked')).toHaveLength(1);
  });

  it('requires an active scoped grant for Skill bootstrap downloads and never packages credentials', async () => {
    const store = new MemoryStore();
    const environment = env();
    const registry = new Registry(environment, store);
    const grant = await registry.createGrant({ clientId: 'alpha', mode: 'update', allowedOrigins: ['https://alpha.brclio.com'] }, 'admin');
    const download = (token?: string, suffix = 'skill.zip') => new Request(`https://pay.bornforthis.cn/api/integration/v1/${suffix}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const zip = await handleIntegration(download(grant.token), environment, store);
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('cache-control')).toBe('no-store');
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    const markdown = await handleIntegration(download(grant.token, 'skill'), environment, store);
    const text = (await markdown.json() as { content: string }).content;
    expect(text).toContain('Brclio Pay');
    for (const secret of [alpha.apiSecret, alpha.webhookSecret, beta.apiSecret, grant.token, environment.GITHUB_TOKEN, environment.ALIPAY_PRIVATE_KEY]) {
      expect(bytes.toString('utf8')).not.toContain(secret);
      expect(text).not.toContain(secret);
    }
    await expect(handleIntegration(download(), environment, store)).rejects.toMatchObject({ status: 401 });
    const expired = await new Registry(environment, store, () => Date.now() - 120_000).createGrant({
      clientId: 'alpha', mode: 'update', allowedOrigins: ['https://alpha.brclio.com'], lifetimeSeconds: 60,
    }, 'admin');
    await expect(handleIntegration(download(expired.token), environment, store)).rejects.toMatchObject({ status: 401 });
    await registry.revokeGrant(grant.id, 'admin');
    await expect(handleIntegration(download(grant.token), environment, store)).rejects.toMatchObject({ status: 401 });
  });

  it('runs context/plan/apply HTTP routes without exposing bearer tokens in URLs or accepting oversized JSON', async () => {
    const store = new MemoryStore();
    const environment = env();
    const registry = new Registry(environment, store);
    const grant = await registry.createGrant({ clientId: 'gamma', mode: 'create', allowedOrigins: ['https://gamma.brclio.com'] }, 'admin');
    const headers = { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json' };
    const request = (operation: string, value?: unknown) => new Request(`https://pay.bornforthis.cn/api/integration/v1/${operation}`, {
      method: value === undefined ? 'GET' : 'POST', headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const context = await handleIntegration(request('context'), environment, store);
    expect(context.headers.get('cache-control')).toBe('no-store');
    expect((await context.json() as { clientId: string }).clientId).toBe('gamma');
    const planned = await handleIntegration(request('plan', { config: newConfig(), expectedVersion: 'absent' }), environment, store);
    const plan = await planned.json() as { planId: string };
    const applied = await handleIntegration(request('apply', { planId: plan.planId }), environment, store);
    expect((await applied.json() as { client: ClientView }).client.id).toBe('gamma');
    await expect(handleIntegration(new Request('https://pay.bornforthis.cn/api/integration/v1/context?token=ignored', { headers }), environment, store)).rejects.toMatchObject({ status: 400 });
    await expect(handleIntegration(new Request('https://pay.bornforthis.cn/api/integration/v1/context'), environment, store)).rejects.toMatchObject({ status: 401 });
    await expect(handleIntegration(request('apply', { planId: plan.planId, ignored: 'x'.repeat(33 * 1024) }), environment, store)).rejects.toMatchObject({ status: 413 });
    await expect(handleIntegration(new Request('https://pay.bornforthis.cn/api/integration/v1/plan', { method: 'POST', headers, body: 'not json' }), environment, store)).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' });
  });
});
