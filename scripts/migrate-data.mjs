#!/usr/bin/env node
/** Read-only by default. Never writes to either legacy repository. */
import { createHash, createDecipheriv, createSign } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TARGET_REPOSITORY = 'BrclioData/BrclioPay-Data';
const SOURCES = { alipay: 'BrclioData/Brclio-Alipay-Data', wechat: 'BrclioData/Brclio-WeChatPay-Data' };
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const LEGACY_ROOT = resolve(ROOT, '..');
const PRIVATE_KEY = '/Users/bornforthis/cert/brcliopay.2026-10-21.private-key.pem';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message = code) => { const error = new Error(message); error.code = code; throw error; };
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  if (value === undefined) fail('UNDEFINED_JSON');
  return JSON.stringify(value);
}
export function month(value) {
  const time = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(time)) fail('INVALID_RECORD_TIME');
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 7).replace('-', '/');
}
function validPath(path) {
  if (typeof path !== 'string' || path.length > 1000 || !/^[A-Za-z0-9][A-Za-z0-9_.\/-]*$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('INVALID_PATH');
}
function checkedId(id, pattern = /^pay_[a-f0-9]{32}$/) { if (typeof id !== 'string' || !pattern.test(id)) fail('INVALID_RECORD_ID'); return id; }
function decrypt(key, envelope, aad) {
  try {
    if (!plain(envelope) || envelope.algorithm !== 'AES-256-GCM' || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') fail('INVALID_ENVELOPE');
    const iv = Buffer.from(envelope.iv, 'base64'), ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    if (key.length !== 32 || iv.length !== 12 || ciphertext.length < 16) fail('INVALID_ENVELOPE');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(ciphertext.subarray(-16));
    return JSON.parse(utf8.decode(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])));
  } catch { fail('SOURCE_DECRYPTION_FAILED', 'Source record authentication failed; values withheld'); }
}
export function decodeRecord(kind, path, bytes, config) {
  let value; try { value = JSON.parse(utf8.decode(bytes)); } catch { fail('INVALID_SOURCE_JSON'); }
  if (kind === 'wechat') {
    if (value.version !== 1 || !config.ENCRYPTION_KEY) fail('WECHAT_ENCRYPTION_KEY_REQUIRED');
    return decrypt(Buffer.from(config.ENCRYPTION_KEY, 'base64'), value, `Brclio-WeChatPay:encrypted-json:v1\n${SOURCES.wechat}:${path}`);
  }
  if (path === 'system/clients.enc.json') {
    if (value.schema !== 1 || !/^[a-fA-F0-9]{64}$/.test(config.REGISTRY_ENCRYPTION_KEY || '')) fail('ALIPAY_REGISTRY_KEY_REQUIRED');
    return decrypt(Buffer.from(config.REGISTRY_ENCRYPTION_KEY, 'hex'), value, 'brclio-pay:registry:v1:system/clients.enc.json');
  }
  return value;
}
function money(cents) {
  if (!Number.isSafeInteger(cents) || cents < 1) fail('INVALID_AMOUNT');
  return Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0');
}
export function normalizeWechat(order, mode, clientMap = {}) {
  checkedId(order.id, /^[a-f0-9]{32}$/);
  if (!['live', 'sandbox'].includes(mode)) fail('WECHAT_MODE_REQUIRED', 'Specify verified --wechat-mode live or sandbox; legacy records have no mode');
  if (!['CREATING', 'PENDING', 'SUCCESS', 'CLOSED', 'PAYERROR'].includes(order.status)) fail('INVALID_WECHAT_STATUS');
  const status = order.status === 'SUCCESS' ? 'PAID' : ['CLOSED', 'PAYERROR'].includes(order.status) ? 'CLOSED' : 'PENDING';
  if (status === 'PAID' && (!order.transactionId || !order.paidAt)) fail('INCOMPLETE_PAID_ORDER');
  month(order.createdAt); month(order.expiresAt);
  const returnUrl = order.returnUrl || '';
  const requestHash = sha(JSON.stringify({ productOrderId: order.merchantOrderId, sku: order.sku, returnUrl, amount: money(order.total), subject: order.description, provider: 'wechat' }));
  return {
    id: 'pay_' + order.id, provider: 'wechat', channel: order.channel, wechatOrderId: order.id,
    mode, clientId: clientMap[order.clientId] || order.clientId, productOrderId: order.merchantOrderId,
    sku: order.sku, subject: order.description, amount: money(order.total), status,
    createdAt: order.createdAt, expiresAt: order.expiresAt, returnUrl, requestHash,
    fulfillmentStatus: order.delivery?.status === 'delivered' ? 'delivered' : 'pending',
    ...(order.transactionId ? { tradeNo: order.transactionId } : {}), ...(order.paidAt ? { paidAt: order.paidAt } : {}),
    ...(order.lastQueryAt ? { lastCheckedAt: order.lastQueryAt } : {}),
    wechatAppId: order.appId, wechatQuantity: order.quantity, legacyWechatRequestHash: order.requestHash,
    ...(order.delivery ? { legacyWechatDelivery: order.delivery } : {}),
  };
}
export function normalizeWechatClient(client, clientMap = {}) {
  return {
    id: clientMap[client.id] || client.id, name: client.name, apiSecret: client.apiKey,
    webhookSecret: client.webhookSecret, webhookUrl: client.webhookUrl, returnOrigins: client.returnOrigins,
    skus: Object.fromEntries(Object.entries(client.products || {}).map(([sku, product]) => [sku, { subject: product.description, amount: money(product.amount) }])),
    enabled: client.disabled !== true, providers: ['wechat'], wechatChannels: client.channels,
    legacyWechat: { id: client.id, ...(client.integrationBootstrapHash ? { integrationBootstrapHash: client.integrationBootstrapHash } : {}) },
  };
}
function physical(path, value) {
  if (/^orders\/pay_[a-f0-9]{32}\.json$/.test(path)) return `orders/${month(value.createdAt)}/${value.id}.json`;
  if (/^events\/[A-Za-z0-9_-]+\.json$/.test(path)) return `events/${month(value.event.createdAt)}/${value.event.id}.json`;
  const index = /^indexes\/([^/]+)\/([a-f0-9]{64})\.json$/.exec(path);
  if (index) return `indexes/${index[1]}/${index[2].slice(0, 2)}/${index[2]}.json`;
  const attempt = /^payment-attempts\/([^/]+)\.json$/.exec(path);
  if (attempt) return `payment-attempts/${sha(attempt[1]).slice(0, 2)}/${attempt[1]}.json`;
  return path;
}
function addRegistry(records, state, wechatClients, clientMap) {
  state ||= { schema: 1, revision: 0, clients: [], grants: [], plans: [], audit: [] };
  if (state.schema !== 1 || !Number.isSafeInteger(state.revision) || !['clients', 'grants', 'plans', 'audit'].every(key => Array.isArray(state[key]))) fail('INVALID_SOURCE_REGISTRY');
  const clients = new Map();
  for (const client of state.clients) {
    if (clients.has(client.id)) fail('CLIENT_COLLISION');
    clients.set(client.id, { ...client, providers: client.providers || ['alipay'] });
  }
  for (const original of wechatClients) {
    const client = normalizeWechatClient(original, clientMap);
    if (clients.has(client.id)) fail('CLIENT_COLLISION', 'Legacy client IDs overlap; provide an explicit --wechat-client-map file');
    clients.set(client.id, client);
  }
  const put = (path, value) => { validPath(path); if (records.has(path)) fail('DESTINATION_COLLISION'); records.set(path, value); };
  for (const client of clients.values()) put(`registry/clients/${client.id}.json`, client);
  for (const grant of state.grants) put(`registry/grants/${grant.id}.json`, grant);
  for (const plan of state.plans) put(`registry/plans/${plan.planId}.json`, plan);
  for (const audit of state.audit) put(`registry/audit/${month(audit.at)}/${audit.id}.json`, audit);
  put('system/registry.json', { schema: 2, revision: state.revision, clients: [...clients.keys()].sort(), grants: state.grants.map(item => item.id), plans: state.plans.map(item => item.planId), audit: state.audit.map(({ id, at }) => ({ id, at })) });
}
/** All transformations are deterministic; the plan contains credentials and must never be printed. */
export function buildMigration(sources, options = {}) {
  const records = new Map(), entries = [], blockers = [], orders = [];
  let registry, wechatClients = [];
  const put = (path, value) => { validPath(path); if (records.has(path) && canonical(records.get(path)) !== canonical(value)) fail('DESTINATION_COLLISION'); records.set(path, value); };
  for (const kind of ['alipay', 'wechat']) {
    const source = sources[kind];
    if (source.repository !== SOURCES[kind] || !/^[a-f0-9]{40}$/.test(source.revision)) fail('INVALID_SOURCE');
    for (const file of [...source.files].sort((a, b) => a.path.localeCompare(b.path))) {
      validPath(file.path);
      const textFile = file.path === 'README.md';
      if (!textFile && !file.path.endsWith('.json')) fail('NON_JSON_SOURCE_FILE', 'Unexpected non-JSON source file requires explicit review');
      const bytes = Buffer.from(file.bytes), data = textFile ? { text: utf8.decode(bytes) } : decodeRecord(kind, file.path, bytes, source.config);
      const archivePath = `archives/${kind}/${source.revision}/${file.path}${textFile ? '.json' : ''}`;
      const provenance = { repository: source.repository, commit: source.revision, path: file.path, blobSha: file.sha, sha256: sha(bytes), encoding: textFile ? 'utf8' : kind === 'wechat' || file.path === 'system/clients.enc.json' ? 'AES-256-GCM' : 'utf8-json' };
      put(archivePath, { schema: 1, source: provenance, plaintextSha256: sha(canonical(data)), data });
      const targets = [archivePath];
      if (textFile) { /* Immutable README bytes are preserved as plaintext archive data.text. */ }
      else if (kind === 'alipay') {
        if (file.path === 'system/clients.enc.json') registry = data;
        else if (file.path.startsWith('reporting/')) { /* rebuilt from every canonical order below */ }
        else {
          let value = data;
          if (/^orders\/pay_[a-f0-9]{32}\.json$/.test(file.path)) {
            checkedId(data.id); value = { ...data, provider: data.provider || 'alipay' }; orders.push(value);
            const target = physical(file.path, value), location = `order-locations/${sha(value.id).slice(0, 2)}/${value.id}.json`;
            put(target, value); put(location, { schema: 1, path: target }); targets.push(target, location);
          } else {
            const target = physical(file.path, value); put(target, value); targets.push(target);
            if (file.path.startsWith('events/')) { const location = `event-locations/${sha(data.event.id).slice(0, 2)}/${data.event.id}.json`; put(location, { schema: 1, path: target }); targets.push(location); }
          }
        }
      } else if (/^orders\/[a-f0-9]{2}\/[a-f0-9]{32}\.json$/.test(file.path)) {
        const value = normalizeWechat(data, options.wechatMode, options.wechatClientMap);
        orders.push(value);
        const target = `orders/${month(value.createdAt)}/${value.id}.json`, location = `order-locations/${sha(value.id).slice(0, 2)}/${value.id}.json`;
        put(target, value); put(location, { schema: 1, path: target }); targets.push(target, location);
        const index = `indexes/${value.clientId}/${sha(value.productOrderId).slice(0, 2)}/${sha(value.productOrderId)}.json`;
        put(index, { id: value.id }); targets.push(index);
        if (['CREATING', 'PENDING'].includes(data.status)) blockers.push({ code: 'WECHAT_PAYMENT_UNFINISHED', orderId: value.id });
        if (data.delivery && data.delivery.status !== 'delivered') blockers.push({ code: 'WECHAT_DELIVERY_UNFINISHED', orderId: value.id });
      } else if (file.path === 'config/clients.json') {
        if (data.version !== 1 || !Array.isArray(data.clients)) fail('INVALID_WECHAT_REGISTRY');
        wechatClients = data.clients;
      } else if (file.path.startsWith('work/')) blockers.push({ code: 'WECHAT_WORK_REQUIRES_REVIEW', path: file.path });
      entries.push({ source: kind, ...provenance, plaintextSha256: sha(canonical(data)), targets });
    }
  }
  if (!registry) {
    const baseline = sources.alipay.config.CLIENTS_JSON || '[]';
    registry = { schema: 1, revision: 0, clients: JSON.parse(baseline).map(client => ({ ...client, enabled: client.enabled !== false })), grants: [], plans: [], audit: [] };
  }
  // WeChat merges its legacy CLIENTS_JSON baseline before its saved registry.
  const legacyWechat = JSON.parse(sources.wechat.config.CLIENTS_JSON || '[]');
  const combinedWechat = new Map(legacyWechat.map(client => [client.id, client]));
  for (const client of wechatClients) combinedWechat.set(client.id, client);
  addRegistry(records, registry, [...combinedWechat.values()], options.wechatClientMap || {});
  rebuildReporting(records, orders);
  const totals = {};
  for (const provider of ['alipay', 'wechat']) {
    const list = orders.filter(order => order.provider === provider);
    totals[provider] = { orders: list.length, paid: list.filter(order => order.status === 'PAID').length, paidAmountCents: list.filter(order => order.status === 'PAID').reduce((sum, order) => sum + amountCents(order.amount) + (order.duplicatePayments || []).reduce((a, payment) => a + amountCents(payment.amount), 0), 0), statuses: Object.fromEntries(['PENDING', 'PAID', 'CLOSED'].map(status => [status, list.filter(order => order.status === status).length])) };
  }
  const inventory = [...records].sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => ({ path, sha256: sha(json(value)) }));
  const sourceList = Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, { repository: value.repository, revision: value.revision, files: value.files.length }]));
  const digest = sha(canonical({ schema: 1, sources: sourceList, inventory, blockers, totals }));
  const manifestPath = `migrations/v1/${digest}/manifest.json`;
  for (const entry of entries) put(`migrations/v1/${digest}/entries/${entry.source}/${sha(entry.path).slice(0, 2)}/${sha(entry.path)}.json`, entry);
  for (let offset = 0; offset < inventory.length; offset += 200) put(`migrations/v1/${digest}/inventory/${String(offset / 200).padStart(5, '0')}.json`, { schema: 1, records: inventory.slice(offset, offset + 200) });
  const manifest = { schema: 1, digest, destination: TARGET_REPOSITORY, sources: sourceList, totals, blockers, sourceRecords: entries.length, transformedRecords: inventory.length, inventoryPages: Math.ceil(inventory.length / 200), entryLayout: 'entries/{source}/{sha256(sourcePath)[0:2]}/{sha256(sourcePath)}.json', checksum: 'SHA-256', storage: 'plaintext', timezone: 'Asia/Shanghai' };
  put(manifestPath, manifest);
  return { digest, records, manifest, manifestPath, entries, blockers };
}
function amountCents(amount) {
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(amount)) fail('INVALID_AMOUNT');
  const [yuan, fen] = amount.split('.'), value = Number(yuan) * 100 + Number(fen);
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_AMOUNT');
  return value;
}
/** Same projections and counters consumed by src/reporting.ts; rebuild both providers together. */
function rebuildReporting(records, orders) {
  const zero = () => ({ paidAmountCents: 0, paidCount: 0, pendingCount: 0, closedCount: 0, deliveryPendingCount: 0 });
  for (const order of orders) {
    const amount = amountCents(order.amount);
    if (!['live', 'sandbox'].includes(order.mode) || !['PENDING', 'PAID', 'CLOSED'].includes(order.status)) fail('INVALID_ORDER');
    const view = Object.fromEntries(['id', 'provider', 'mode', 'clientId', 'productOrderId', 'sku', 'subject', 'amount', 'status', 'createdAt', 'expiresAt', 'paidAt', 'tradeNo', 'fulfillmentStatus', 'duplicatePayments'].filter(key => order[key] !== undefined).map(key => [key, order[key]]));
    view.amountCents = amount;
    const createdMonth = month(order.createdAt).replace('/', '-'), timestamp = new Date(order.createdAt).toISOString().replace(/[-:.]/g, '');
    records.set(`reporting/v1/orders/${order.mode}/${createdMonth}/${timestamp}_${order.id}.json`, { schema: 1, order: view });
    for (const scope of ['all', 'clients/' + order.clientId]) {
      const base = `reporting/v1/${order.mode}/summary/${scope}`;
      const contributions = [{ date: order.status === 'PAID' ? order.paidAt : order.createdAt, status: order.status, amount, delivered: order.fulfillmentStatus === 'delivered' }, ...(order.duplicatePayments || []).map(payment => ({ date: payment.paidAt, status: 'PAID', amount: amountCents(payment.amount), delivered: true }))];
      let total = records.get(base + '/total.json') || { schema: 1, mode: order.mode, paidAmountCents: 0, paidCount: 0 };
      for (const [index, contribution] of contributions.entries()) {
        const day = new Date(Date.parse(contribution.date) + 8 * 3600_000).toISOString().slice(0, 10), paidMonth = day.slice(0, 7), path = base + '/months/' + paidMonth + '.json';
        const bucket = records.get(path) || { schema: 1, mode: order.mode, month: paidMonth, ...zero(), daily: {} };
        if (contribution.status === 'PAID') {
          bucket.paidCount++; bucket.paidAmountCents += contribution.amount;
          if (index === 0 && !contribution.delivered) bucket.deliveryPendingCount++;
          const daily = bucket.daily[day] || { paidAmountCents: 0, paidCount: 0 }; daily.paidCount++; daily.paidAmountCents += contribution.amount; bucket.daily[day] = daily;
          total.paidCount++; total.paidAmountCents += contribution.amount;
        } else if (contribution.status === 'PENDING') bucket.pendingCount++;
        else bucket.closedCount++;
        records.set(path, bucket);
      }
      records.set(base + '/total.json', total);
    }
  }
}

export class Github {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async request(path, method = 'GET', body) {
    const response = await this.fetcher('https://api.github.com' + path, { method, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'BrclioPay-Migration', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); fail('GITHUB_HTTP_' + response.status, `GitHub operation failed (${response.status}); response values withheld`); }
    return response.json();
  }
  async revision(repo, branch) { return (await this.request(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha; }
  async snapshot(repo, branch) {
    const meta = await this.request('/repos/' + repo); if (meta.private !== true) fail('REPOSITORY_NOT_PRIVATE');
    branch ||= meta.default_branch;
    const revision = await this.revision(repo, branch), commit = await this.request(`/repos/${repo}/git/commits/${revision}`);
    const result = await this.request(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
    if (result.truncated) fail('GITHUB_TRUNCATED_TREE');
    const files = [];
    for (const entry of result.tree) {
      if (entry.type === 'tree') continue;
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('UNSUPPORTED_GIT_ENTRY');
      validPath(entry.path); files.push({ path: entry.path, sha: entry.sha });
    }
    return { repository: repo, revision, tree: commit.tree.sha, branch, files };
  }
  async bytes(repo, file) {
    const blob = await this.request(`/repos/${repo}/git/blobs/${file.sha}`);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') fail('INVALID_GITHUB_BLOB');
    const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
    const gitSha = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
    if (gitSha !== file.sha) fail('SOURCE_BLOB_SHA_MISMATCH');
    return bytes;
  }
}
async function mapLimit(values, limit, callback) {
  let next = 0; const result = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => { while (next < values.length) { const i = next++; result[i] = await callback(values[i], i); } }));
  return result;
}
export async function compareTarget(plan, target, github) {
  const existing = new Map(target.files.map(file => [file.path, file]));
  const additions = [], identical = [], conflicts = [];
  const results = await mapLimit([...plan.records], 4, async ([path, value]) => {
    const prior = existing.get(path);
    if (!prior) return { kind: 'new', path, value };
    let parsed;
    try { parsed = JSON.parse(utf8.decode(await github.bytes(TARGET_REPOSITORY, prior))); } catch { return { kind: 'conflict', path }; }
    return { kind: canonical(parsed) !== canonical(value) ? 'conflict' : 'identical', path };
  });
  for (const item of results) {
    if (item.kind === 'new') additions.push({ path: item.path, value: item.value });
    else if (item.kind === 'identical') identical.push(item.path);
    else conflicts.push(item.path);
  }
  if (conflicts.length) fail('TARGET_CONFLICT', `Destination contains ${conflicts.length} conflicting records; no writes performed`);
  return { additions, identical };
}
export async function applyMigration(plan, target, github, sources, expectedDigest) {
  if (expectedDigest !== plan.digest) fail('PLAN_DIGEST_MISMATCH');
  if (plan.blockers.length) fail('CUTOVER_BLOCKED', 'Legacy pending payments or deliveries require review; no writes performed');
  const comparison = await compareTarget(plan, target, github);
  for (const source of Object.values(sources)) if (await source.github.revision(source.repository, source.branch) !== source.revision) fail('SOURCE_CHANGED', 'Source changed after snapshot; repeat dry-run');
  if (await github.revision(TARGET_REPOSITORY, target.branch) !== target.revision) fail('TARGET_CHANGED');
  if (!comparison.additions.length) return { commit: target.revision, written: 0, identical: comparison.identical.length };
  const blobs = await mapLimit(comparison.additions, 4, async ({ path, value }) => ({ path, mode: '100644', type: 'blob', sha: (await github.request(`/repos/${TARGET_REPOSITORY}/git/blobs`, 'POST', { content: json(value), encoding: 'utf-8' })).sha }));
  const tree = await github.request(`/repos/${TARGET_REPOSITORY}/git/trees`, 'POST', { base_tree: target.tree, tree: blobs });
  const commit = await github.request(`/repos/${TARGET_REPOSITORY}/git/commits`, 'POST', { message: `Migrate verified legacy payment data ${plan.digest}`, tree: tree.sha, parents: [target.revision] });
  // A concurrent source write during uploads invalidates cutover; no target ref is changed.
  for (const source of Object.values(sources)) if (await source.github.revision(source.repository, source.branch) !== source.revision) fail('SOURCE_CHANGED', 'Source changed during preparation; target branch unchanged');
  // GitHub ref update without force rejects a concurrent target writer.
  await github.request(`/repos/${TARGET_REPOSITORY}/git/refs/heads/${encodeURIComponent(target.branch)}`, 'PATCH', { sha: commit.sha, force: false });
  const verified = await github.snapshot(TARGET_REPOSITORY, target.branch);
  if (verified.revision !== commit.sha) fail('POST_WRITE_REVISION_CHANGED');
  const verify = await compareTarget(plan, verified, github);
  if (verify.additions.length || verify.identical.length !== plan.records.size) fail('POST_WRITE_VERIFICATION_FAILED');
  return { commit: commit.sha, written: comparison.additions.length, identical: comparison.identical.length, verified: verify.identical.length };
}
function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed); if (!match) fail('INVALID_ENV_FILE');
    let value = match[2];
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { fail('INVALID_ENV_FILE'); } }
    else if (value.startsWith("'")) { if (!value.endsWith("'")) fail('INVALID_ENV_FILE'); value = value.slice(1, -1); }
    else value = value.replace(/\s+#.*$/, '').trim();
    result[match[1]] = value;
  }
  return result;
}
async function optionalFile(path, mode = 'json') {
  try { const text = await readFile(path, 'utf8'); return mode === 'env' ? parseEnv(text) : JSON.parse(text); }
  catch (error) { if (error.code === 'ENOENT') return {}; fail('CONFIG_FILE_INVALID', 'Could not load local configuration; values withheld'); }
}
export async function loadLegacyConfig(kind, override) {
  const folder = resolve(LEGACY_ROOT, kind === 'alipay' ? 'Brclio-Alipay' : 'Brclio-WeChatPay');
  const wrangler = await optionalFile(resolve(folder, 'wrangler.jsonc'));
  const config = { ...wrangler.vars };
  const files = kind === 'alipay' ? ['secrets/initial-worker-secrets.json', 'secrets/admin-worker-secrets.json', 'secrets/runtime-variables-maintenance.json'] : ['secrets/runtime.json'];
  for (const file of files) Object.assign(config, await optionalFile(resolve(folder, file)));
  Object.assign(config, await optionalFile(resolve(folder, '.dev.vars'), 'env'));
  // Fresh Cloudflare Text metadata wins over local backups. Secret binding values
  // cannot be exported and therefore continue using the existing local backups.
  const live = await optionalFile(resolve(ROOT, 'secrets', kind === 'alipay' ? 'brclio-pay-live-backup.json' : 'brclio-wechatpay-live-backup.json'));
  for (const binding of live.settings?.bindings || []) if (binding.type === 'plain_text' && typeof binding.text === 'string') config[binding.name] = binding.text;
  if (override) {
    const supplied = await optionalFile(resolve(override));
    if (Array.isArray(supplied.settings?.bindings)) { for (const binding of supplied.settings.bindings) if (binding.type === 'plain_text' && typeof binding.text === 'string') config[binding.name] = binding.text; }
    else Object.assign(config, supplied);
  }
  return config;
}
export async function installationGithub(privateKeyPath = PRIVATE_KEY) {
  const time = Math.floor(Date.now() / 1000), b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iat: time - 60, exp: time + 540, iss: '5411175' });
  const signature = createSign('RSA-SHA256').update(unsigned).sign(await readFile(privateKeyPath)).toString('base64url');
  const app = new Github(unsigned + '.' + signature);
  const identity = await app.request('/app');
  if (identity.id !== 5411175 || identity.owner?.login !== 'BrclioData') fail('GITHUB_APP_IDENTITY_MISMATCH');
  const installation = await app.request(`/repos/${TARGET_REPOSITORY}/installation`);
  if (installation.suspended_at || installation.permissions?.contents !== 'write') fail('GITHUB_APP_PERMISSION_REQUIRED');
  const access = await app.request(`/app/installations/${installation.id}/access_tokens`, 'POST', { repositories: ['BrclioPay-Data'], permissions: { contents: 'write', metadata: 'read' } });
  if (!access.token) fail('GITHUB_APP_TOKEN_FAILED');
  return { github: new Github(access.token), installationId: installation.id };
}
function argumentsFor(argv) {
  const options = { apply: false };
  const flags = new Map([['--wechat-mode', 'wechatMode'], ['--wechat-client-map', 'wechatClientMapPath'], ['--alipay-config', 'alipayConfig'], ['--wechat-config', 'wechatConfig'], ['--expected-plan', 'expectedDigest'], ['--report', 'report'], ['--private-key', 'privateKeyPath'], ['--target-branch', 'targetBranch']]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--dry-run') options.apply = false;
    else if (argv[i] === '--help') options.help = true;
    else if (flags.has(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[flags.get(argv[i])] = argv[++i];
    else fail('INVALID_ARGUMENT');
  }
  return options;
}
export async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  if (options.help) { process.stdout.write('Usage: node scripts/migrate-data.mjs --wechat-mode live|sandbox [--alipay-config ignored.json] [--wechat-config ignored.json] [--wechat-client-map mapping.json] [--report secrets/migration/report.json] [--apply --expected-plan SHA256]\nDefault is read-only dry-run. Source repositories are never modified. --apply writes only BrclioData/BrclioPay-Data after conflict and frozen-source checks.\n'); return; }
  if (options.apply && !/^[a-f0-9]{64}$/.test(options.expectedDigest || '')) fail('EXPECTED_PLAN_REQUIRED');
  const reportPath = resolve(options.report || resolve(ROOT, 'secrets/migration/report.json'));
  if (!reportPath.startsWith(resolve(ROOT, 'secrets') + '/')) fail('REPORT_LOCATION_REQUIRED', 'Reports must stay inside ignored secrets/');
  const sources = {};
  for (const kind of ['alipay', 'wechat']) {
    const config = await loadLegacyConfig(kind, options[kind + 'Config']);
    if (!config.GITHUB_TOKEN) fail('SOURCE_CREDENTIAL_REQUIRED');
    const github = new Github(config.GITHUB_TOKEN), branch = kind === 'alipay' ? config.GITHUB_BRANCH : config.GITHUB_DATA_BRANCH;
    const source = await github.snapshot(SOURCES[kind], branch);
    source.files = await mapLimit(source.files, 4, async file => ({ ...file, bytes: await github.bytes(source.repository, file) }));
    sources[kind] = { ...source, config, github };
  }
  if (!options.wechatMode && ['live', 'sandbox'].includes(sources.wechat.config.PAYMENT_MODE)) options.wechatMode = sources.wechat.config.PAYMENT_MODE;
  options.wechatClientMap = options.wechatClientMapPath ? await optionalFile(resolve(options.wechatClientMapPath)) : {};
  const plan = buildMigration(sources, options);
  let targetAccess, target, comparison, targetError;
  try {
    targetAccess = await installationGithub(options.privateKeyPath);
    target = await targetAccess.github.snapshot(TARGET_REPOSITORY, options.targetBranch);
    comparison = await compareTarget(plan, target, targetAccess.github);
  } catch (error) { targetError = error.code || 'TARGET_ACCESS_FAILED'; if (options.apply) throw error; }
  const sourcesUnchanged = (await Promise.all(Object.values(sources).map(async source => await source.github.revision(source.repository, source.branch) === source.revision))).every(Boolean);
  const report = { ...plan.manifest, mode: options.apply ? 'apply' : 'dry-run', sourceRevisionsUnchanged: sourcesUnchanged, target: { repository: TARGET_REPOSITORY, private: target ? true : null, installationId: targetAccess?.installationId, revision: target?.revision, newRecords: comparison?.additions.length, identicalRecords: comparison?.identical.length, ...(targetError ? { error: targetError } : {}) } };
  if (options.apply) {
    if (!sourcesUnchanged) fail('SOURCE_CHANGED');
    report.applied = await applyMigration(plan, target, targetAccess.github, sources, options.expectedDigest);
    report.postWriteSources = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([kind, source]) => {
      const current = await source.github.revision(source.repository, source.branch);
      return [kind, { expected: source.revision, current, unchanged: current === source.revision }];
    })));
    report.postWriteSourceRevisionsUnchanged = Object.values(report.postWriteSources).every(value => value.unchanged);
  }
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, json(report), { mode: 0o600 });
  process.stdout.write(json({ mode: report.mode, digest: plan.digest, totals: report.totals, blockers: report.blockers.length, target: report.target, sourceRevisionsUnchanged: sourcesUnchanged, report: reportPath, ...(report.applied ? { applied: report.applied } : {}) }));
  if (targetError || !sourcesUnchanged || plan.blockers.length || report.postWriteSourceRevisionsUnchanged === false) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`Migration failed: ${error.code || 'UNEXPECTED_ERROR'}. Values withheld; no source repository writes were attempted.\n`); process.exitCode = 1; });
