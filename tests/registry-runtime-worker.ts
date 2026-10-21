// Test-only worker. No production entry point imports this module.
import { Registry, REGISTRY_PATH, type RegistryEnvironment } from '../src/registry';
import type { Store, Transaction } from '../src/types';

export default {
  async fetch(request: Request, bindings: { CLIENTS_JSON: string; REGISTRY_ENCRYPTION_KEY: string }): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).hostname !== 'registry-runtime.test') return new Response(null, { status: 404 });
    const values = new Map<string, unknown>();
    const store: Store = {
      readJson: async <T>(path: string) => structuredClone((values.get(path) ?? null) as T | null),
      transaction: async <T>(callback: (tx: Transaction) => Promise<T>) => {
        const writes = new Map<string, unknown>();
        const result = await callback({
          read: async <V>(path: string) => structuredClone((writes.has(path) ? writes.get(path) : values.get(path) ?? null) as V | null),
          put: (path, value) => { writes.set(path, structuredClone(value)); },
        });
        for (const [path, value] of writes) values.set(path, value);
        return result;
      },
    };
    const environment = {
      ...bindings,
      PAY_BASE_URL: 'https://pay.bornforthis.cn', PAYMENT_MODE: 'sandbox',
    } as RegistryEnvironment;
    const registry = new Registry(environment, store);
    const grant = await registry.createGrant({ clientId: 'gamma', mode: 'create', allowedOrigins: ['https://gamma.brclio.com'] }, 'runtime-admin');
    const firstEnvelope = structuredClone(values.get(REGISTRY_PATH)) as { iv: string };
    const plan = await registry.plan(grant.token, {
      config: { id: 'gamma', name: 'GAMMA', webhookUrl: 'https://gamma.brclio.com/api/payment',
        returnOrigins: ['https://gamma.brclio.com'], skus: { pro: { subject: 'gamma Pro', amount: '29.90' } } },
      expectedVersion: 'absent',
    });
    const result = await registry.apply(grant.token, { planId: plan.planId });
    const replay = await registry.apply(grant.token, { planId: plan.planId });
    const publicClients = await registry.list();
    const context = await registry.grantContext(grant.token);
    const beta = JSON.parse(environment.CLIENTS_JSON).find((client: { id: string }) => client.id === 'beta');
    const envelope = values.get(REGISTRY_PATH) as { iv: string; algorithm: string };
    const encoded = JSON.stringify(envelope);
    return Response.json({
      encrypted: envelope.algorithm === 'AES-256-GCM',
      plaintextAbsent: !encoded.includes(beta.apiSecret) && !encoded.includes(result.credentials.apiSecret) && !encoded.includes(grant.token),
      preserved: publicClients.length === 3 && (await registry.get('beta'))!.apiSecret === beta.apiSecret,
      scoped: context.client?.id === 'gamma' && context.credentials?.apiSecret === result.credentials.apiSecret,
      idempotent: replay.client.version === result.client.version && replay.credentials.apiSecret === result.credentials.apiSecret,
      uniqueIv: firstEnvelope.iv !== envelope.iv,
      paymentMode: context.paymentMode === 'sandbox',
    });
  },
};
