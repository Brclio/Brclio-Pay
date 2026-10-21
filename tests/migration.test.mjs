import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildMigration, canonical, decodeRecord, normalizeWechat, normalizeWechatClient, month, compareTarget, applyMigration, Github, TARGET_REPOSITORY } from '../scripts/migrate-data.mjs';
const test = process.env.VITEST ? (await import('vitest')).test : (await import('node:test')).default;
const hash = value => createHash('sha256').update(value).digest('hex');
const key = Buffer.alloc(32, 7), id = 'a'.repeat(32), oldWechatId = 'b'.repeat(32);
const createdAt = '2026-09-30T16:20:00.000Z', paidAt = '2026-10-01T10:00:00.000Z';
function envelope(value, aad, alipay = false) {
  const iv = Buffer.alloc(12, 3), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return { [alipay ? 'schema' : 'version']: 1, algorithm: 'AES-256-GCM', iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function file(path, data, kind = 'alipay') {
  const value = kind === 'wechat' && path.endsWith('.json') ? envelope(data, `Brclio-WeChatPay:encrypted-json:v1\nBrclioData/Brclio-WeChatPay-Data:${path}`) : path === 'system/clients.enc.json' ? envelope(data, 'brclio-pay:registry:v1:system/clients.enc.json', true) : data;
  const bytes = Buffer.from(path.endsWith('.json') ? JSON.stringify(value) : data);
  return { path, bytes, sha: createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex') };
}
function fixture(overrides = {}) {
  const order = { id: 'pay_' + id, mode: 'live', clientId: 'alipay-product', productOrderId: 'business-ali', sku: 'monthly', subject: 'Subscription', amount: '3.00', status: 'PAID', createdAt, expiresAt: '2026-10-01T00:00:00.000Z', paidAt, tradeNo: '202610010000123456', returnUrl: 'https://app.example.com/paid', requestHash: 'original-alipay-hash', fulfillmentStatus: 'delivered' };
  const wechatOrder = { version: 1, id: oldWechatId, clientId: 'wechat-product', clientName: 'WeChat product', merchantOrderId: 'business-wx', sku: 'monthly', quantity: 1, description: 'WeChat subscription', total: 300, currency: 'CNY', appId: 'wx-fixture', channel: 'native', status: 'SUCCESS', createdAt, expiresAt: order.expiresAt, paidAt, transactionId: '420000100000123456', returnUrl: 'https://wx.example.com/paid', requestHash: 'original-wechat-hash', delivery: { status: 'delivered', attempts: 1, nextAt: paidAt, deliveredAt: paidAt }, ...overrides };
  const client = { id: 'alipay-product', name: 'Alipay', apiSecret: 'a'.repeat(64), webhookSecret: 'b'.repeat(64), webhookUrl: 'https://app.example.com/webhook', returnOrigins: ['https://app.example.com'], skus: { monthly: { amount: '3.00', subject: 'Subscription' } }, enabled: true };
  const wxClient = { id: wechatOrder.clientId, name: 'WeChat', apiKey: 'c'.repeat(64), webhookSecret: 'd'.repeat(64), webhookUrl: 'https://wx.example.com/webhook', returnOrigins: ['https://wx.example.com'], products: { monthly: { amount: 300, description: 'WeChat subscription' } }, channels: ['native'] };
  const state = { schema: 1, revision: 4, clients: [client], grants: [{ id: 'grant_' + id, clientId: client.id, expiresAt: paidAt }], plans: [{ planId: 'plan_' + id, clientId: client.id }], audit: [{ id: 'audit_' + id, at: createdAt, clientId: client.id }] };
  const delivery = { event: { id: 'evt_' + order.id, type: 'payment.paid', mode: 'live', createdAt: paidAt, data: { orderId: order.id } }, attempts: 1, nextAttemptAt: paidAt, deliveredAt: paidAt };
  return {
    alipay: { repository: 'BrclioData/Brclio-Alipay-Data', revision: '1'.repeat(40), branch: 'main', config: { REGISTRY_ENCRYPTION_KEY: key.toString('hex') }, files: [file('README.md', 'legacy source\n'), file('orders/' + order.id + '.json', order), file('events/' + delivery.event.id + '.json', delivery), file('indexes/' + client.id + '/' + hash(order.productOrderId) + '.json', { id: order.id }), file('system/clients.enc.json', state), file('system/queue.json', { orders: [], deliveries: [] }), file('reporting/v1/live/summary/all/total.json', { old: true })] },
    wechat: { repository: 'BrclioData/Brclio-WeChatPay-Data', revision: '2'.repeat(40), branch: 'main', config: { ENCRYPTION_KEY: key.toString('base64') }, files: [file('config/clients.json', { version: 1, clients: [wxClient] }, 'wechat'), file('orders/bb/' + oldWechatId + '.json', wechatOrder, 'wechat')] },
  };
}
const options = { wechatMode: 'live' };
test('Shanghai month selects local month at UTC boundary', () => {
  assert.equal(month(createdAt), '2026/10'); assert.throws(() => month('bad'), { code: 'INVALID_RECORD_TIME' });
});
test('decrypts both historical envelopes with their exact associated data', () => {
  const source = fixture(), alipay = source.alipay.files.find(item => item.path === 'system/clients.enc.json'), wechat = source.wechat.files.at(-1);
  assert.equal(decodeRecord('alipay', alipay.path, alipay.bytes, source.alipay.config).revision, 4);
  assert.equal(decodeRecord('wechat', wechat.path, wechat.bytes, source.wechat.config).id, oldWechatId);
  assert.throws(() => decodeRecord('wechat', 'orders/bb/wrong.json', wechat.bytes, source.wechat.config), { code: 'SOURCE_DECRYPTION_FAILED' });
  assert.throws(() => decodeRecord('wechat', wechat.path, wechat.bytes, { ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') }), { code: 'SOURCE_DECRYPTION_FAILED' });
});
test('canonical migration preserves Alipay hashes and normalizes WeChat without losing original record', () => {
  const plan = buildMigration(fixture(), options), ali = plan.records.get(`orders/2026/10/pay_${id}.json`), wx = plan.records.get(`orders/2026/10/pay_${oldWechatId}.json`);
  assert.equal(ali.provider, 'alipay'); assert.equal(ali.requestHash, 'original-alipay-hash');
  assert.equal(wx.provider, 'wechat'); assert.equal(wx.wechatOrderId, oldWechatId); assert.equal(wx.amount, '3.00'); assert.equal(wx.status, 'PAID'); assert.equal(wx.fulfillmentStatus, 'delivered');
  assert.equal(wx.legacyWechatRequestHash, 'original-wechat-hash'); assert.notEqual(wx.requestHash, wx.legacyWechatRequestHash);
  assert.equal(plan.records.get(`archives/wechat/${'2'.repeat(40)}/orders/bb/${oldWechatId}.json`).data.id, oldWechatId);
  assert.equal(plan.records.get(`order-locations/${hash(wx.id).slice(0, 2)}/${wx.id}.json`).path, `orders/2026/10/${wx.id}.json`);
  assert.equal(plan.records.get(`event-locations/${hash('evt_' + ali.id).slice(0, 2)}/evt_${ali.id}.json`).path, `events/2026/10/evt_${ali.id}.json`);
});
test('splits registries and business idempotency indexes into independent plaintext files', () => {
  const plan = buildMigration(fixture(), options), manifest = plan.records.get('system/registry.json');
  assert.deepEqual(manifest.clients, ['alipay-product', 'wechat-product']); assert.equal(manifest.schema, 2);
  assert.equal(plan.records.get('registry/clients/wechat-product.json').apiSecret, 'c'.repeat(64));
  assert.equal(plan.records.get('registry/clients/wechat-product.json').webhookSecret, 'd'.repeat(64));
  assert.deepEqual(plan.records.get('registry/clients/wechat-product.json').providers, ['wechat']);
  assert.equal(plan.records.has('system/clients.enc.json'), false);
  assert.equal(plan.records.has(`registry/audit/2026/10/audit_${id}.json`), true);
  assert.equal(plan.records.get(`indexes/wechat-product/${hash('business-wx').slice(0, 2)}/${hash('business-wx')}.json`).id, 'pay_' + oldWechatId);
});
test('combined revenue indexes include both providers and client totals', () => {
  const plan = buildMigration(fixture(), options);
  assert.deepEqual(plan.records.get('reporting/v1/live/summary/all/total.json'), { schema: 1, mode: 'live', paidAmountCents: 600, paidCount: 2 });
  assert.equal(plan.records.get('reporting/v1/live/summary/clients/wechat-product/total.json').paidAmountCents, 300);
  assert.equal(plan.records.get('reporting/v1/live/summary/all/months/2026-10.json').daily['2026-10-01'].paidCount, 2);
});
test('complete per-source checksum inventory is stable and source objects are not mutated', () => {
  const source = fixture(), before = JSON.stringify(source), a = buildMigration(source, options), b = buildMigration(source, options);
  assert.equal(a.digest, b.digest); assert.equal(a.entries.length, 9); assert.equal(JSON.stringify(source), before);
  for (const item of a.entries) { assert.match(item.sha256, /^[a-f0-9]{64}$/); assert.match(item.plaintextSha256, /^[a-f0-9]{64}$/); }
  assert.equal(a.records.get(`archives/alipay/${'1'.repeat(40)}/README.md.json`).data.text, 'legacy source\n');
});
test('requires verified WeChat environment, rejects collisions and supports explicit client mapping', () => {
  assert.throws(() => buildMigration(fixture()), { code: 'WECHAT_MODE_REQUIRED' });
  assert.throws(() => buildMigration(fixture({ clientId: 'alipay-product' }), options), { code: 'CLIENT_COLLISION' });
  const plan = buildMigration(fixture({ clientId: 'alipay-product' }), { ...options, wechatClientMap: { 'alipay-product': 'wechat-mapped' } });
  assert.equal(plan.records.get(`orders/2026/10/pay_${oldWechatId}.json`).clientId, 'wechat-mapped');
});
test('unfinished old payment and delivery remain explicit blockers', () => {
  const plan = buildMigration(fixture({ status: 'PENDING', delivery: { status: 'pending', attempts: 0, nextAt: createdAt } }), options);
  assert.deepEqual(plan.blockers.map(item => item.code), ['WECHAT_PAYMENT_UNFINISHED', 'WECHAT_DELIVERY_UNFINISHED']);
});
test('invalid amounts, status and unsupported files stop migration', () => {
  assert.throws(() => buildMigration(fixture({ total: 1.2 }), options), { code: 'INVALID_AMOUNT' });
  assert.throws(() => buildMigration(fixture({ status: 'UNKNOWN' }), options), { code: 'INVALID_WECHAT_STATUS' });
  const source = fixture(); source.alipay.files.push(file('unexpected.txt', 'text'));
  assert.throws(() => buildMigration(source, options), { code: 'NON_JSON_SOURCE_FILE' });
});
test('comparison is idempotent but refuses all conflicting existing target records', async () => {
  const plan = buildMigration(fixture(), options), [path, value] = [...plan.records][0];
  const target = { files: [{ path, sha: 'fixture' }] };
  const identical = await compareTarget(plan, target, { bytes: async () => Buffer.from(JSON.stringify(value)) });
  assert.equal(identical.identical.length, 1); assert.equal(identical.additions.length, plan.records.size - 1);
  await assert.rejects(compareTarget(plan, target, { bytes: async () => Buffer.from('{"conflicting":true}') }), { code: 'TARGET_CONFLICT' });
});
test('apply rejects an unexpected plan or changed source before any mutation', async () => {
  const plan = buildMigration(fixture(), options), writes = [];
  const github = { bytes: async () => null, request: async (...args) => { writes.push(args); }, revision: async () => 'target' };
  await assert.rejects(applyMigration(plan, { files: [], revision: 'target', branch: 'main' }, github, {}, 'wrong'), { code: 'PLAN_DIGEST_MISMATCH' });
  await assert.rejects(applyMigration(plan, { files: [], revision: 'target', branch: 'main' }, github, { alipay: { repository: 'source', revision: 'old', branch: 'main', github: { revision: async () => 'changed' } } }, plan.digest), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(writes, []);
});
test('apply refuses unresolved legacy notifications before writes', async () => {
  const plan = buildMigration(fixture({ delivery: { status: 'manual', attempts: 1, nextAt: createdAt } }), options);
  await assert.rejects(applyMigration(plan, {}, {}, {}, plan.digest), { code: 'CUTOVER_BLOCKED' });
});
test('apply writes only target blobs and advances a single non-forced commit after verification', async () => {
  const value = { schema: 1, data: 'fixture' }, path = 'fixture/record.json';
  const plan = { digest: 'e'.repeat(64), blockers: [], records: new Map([[path, value]]) };
  const target = { files: [], revision: 'old-target', tree: 'old-tree', branch: 'main' }, operations = [], blobs = new Map();
  let treeEntries, ref = target.revision;
  const github = {
    revision: async repository => { assert.equal(repository, TARGET_REPOSITORY); return ref; },
    bytes: async (_repository, file) => blobs.get(file.sha),
    request: async (url, method, body) => {
      operations.push({ url, method, body }); assert.ok(url.startsWith(`/repos/${TARGET_REPOSITORY}/git/`));
      if (url.endsWith('/blobs')) { const blobSha = hash(body.content); blobs.set(blobSha, Buffer.from(body.content)); return { sha: blobSha }; }
      if (url.endsWith('/trees')) { assert.equal(body.base_tree, target.tree); treeEntries = body.tree; return { sha: 'new-tree' }; }
      if (url.endsWith('/commits')) { assert.deepEqual(body.parents, ['old-target']); return { sha: 'new-target' }; }
      if (method === 'PATCH') { assert.equal(body.force, false); ref = body.sha; return {}; }
      assert.fail('unexpected mutation');
    },
    snapshot: async () => ({ files: treeEntries, revision: ref, tree: 'new-tree', branch: 'main' }),
  };
  const sources = { alipay: { repository: 'BrclioData/Brclio-Alipay-Data', revision: 'source-revision', branch: 'main', github: { revision: async () => 'source-revision' } } };
  const result = await applyMigration(plan, target, github, sources, plan.digest);
  assert.equal(result.commit, 'new-target'); assert.equal(result.verified, 1); assert.equal(operations.filter(item => item.method === 'PATCH').length, 1);
});
test('GitHub blob verification rejects changed bytes', async () => {
  const gh = new Github('fixture-only', async () => new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('changed').toString('base64') }), { status: 200 }));
  await assert.rejects(gh.bytes(TARGET_REPOSITORY, { sha: '1'.repeat(40) }), { code: 'SOURCE_BLOB_SHA_MISMATCH' });
});
test('CLI cannot apply without a reviewed digest and never prints config values', () => {
  const result = spawnSync(process.execPath, ['scripts/migrate-data.mjs', '--apply'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /EXPECTED_PLAN_REQUIRED/); assert.equal(result.stdout, '');
});
