// Read-only account-migration continuity checks. Never print source records or credentials.
import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto';
import { readFileSync, existsSync, realpathSync, openSync, writeFileSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch, ProxyAgent } from 'undici';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'BrclioData/Brclio-Alipay-Data';
const BRANCH = 'main';
const REGISTRY_PATH = 'system/clients.enc.json';
const DEFAULT_BASELINE = 'secrets/account-migration-rollback-final-20261018122743838.json';
const SHA = /^[a-f0-9]{40}$/;
const ORDER_PATH = /^orders\/(pay_[a-f0-9]{32})\.json$/;
const EVENT_PATH = /^events\/(evt_pay_[a-f0-9]{32})\.json$/;
const ATTEMPT_PATH = /^payment-attempts\/(pay_[a-f0-9]{32})\.json$/;
const ACTION_PATH = /^order-actions\/(pay_[a-f0-9]{32})\/([a-f0-9]{64})\.json$/;
const PAYMENT_WINDOW_MS = 10 * 60_000;
const MAX_RECORD_BYTES = 256 * 1024;
const REQUIRED_RUNTIME = ['GITHUB_TOKEN', 'CHECKOUT_SECRET', 'REGISTRY_ENCRYPTION_KEY'];
const mutableOrderFields = new Set(['status', 'fulfillmentStatus', 'lastCheckedAt', 'tradeNo', 'paidAt',
  'activeAttemptId', 'attemptTrackingVersion', 'paymentAttempts', 'adminOperation', 'recentActionIds', 'duplicatePayments']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest('hex');

class VerificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireCheck(condition, code) {
  if (!condition) throw new VerificationError(code);
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isRecord(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function same(a, b) { return stable(a) === stable(b); }
function gitBlobSha(bytes) { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
function validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new VerificationError('INVALID_BASE_URL'); }
  requireCheck(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/'
    && !url.search && !url.hash, 'INVALID_BASE_URL');
  return url.origin;
}
function jsonFile(filename) {
  try {
    const bytes = readFileSync(filename);
    requireCheck(bytes.length <= 32 * 1024 * 1024, 'LOCAL_FILE_TOO_LARGE');
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('LOCAL_FILE_UNREADABLE');
  }
}

async function boundedJson(response, maxBytes) {
  requireCheck(Number(response.headers.get('content-length') || 0) <= maxBytes, 'RESPONSE_TOO_LARGE');
  const chunks = [];
  let length = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) { await reader.cancel(); throw new VerificationError('RESPONSE_TOO_LARGE'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new VerificationError('INVALID_JSON_RESPONSE'); }
}

function checkedOrder(value, id) {
  requireCheck(isRecord(value) && /^pay_[a-f0-9]{32}$/.test(id) && value.id === id && ['live', 'sandbox'].includes(value.mode)
    && typeof value.clientId === 'string' && typeof value.productOrderId === 'string'
    && typeof value.sku === 'string' && typeof value.subject === 'string'
    && typeof value.returnUrl === 'string' && /^[a-f0-9]{64}$/.test(value.requestHash)
    && typeof value.amount === 'string' && /^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(value.amount)
    && value.amount !== '0.00' && validTime(value.createdAt) && validTime(value.expiresAt)
    && ['PENDING', 'PAID', 'CLOSED'].includes(value.status)
    && ['pending', 'delivered'].includes(value.fulfillmentStatus), 'ORDER_INVALID');
  requireCheck(value.lastCheckedAt === undefined || validTime(value.lastCheckedAt), 'ORDER_INVALID');
  requireCheck(value.status !== 'PAID' || (typeof value.tradeNo === 'string' && /^\d{10,64}$/.test(value.tradeNo)
    && validTime(value.paidAt)), 'ORDER_INVALID');
  requireCheck(value.fulfillmentStatus !== 'delivered' || value.status === 'PAID', 'ORDER_INVALID');
  requireCheck(value.attemptTrackingVersion === undefined || value.attemptTrackingVersion === 1, 'ORDER_ATTEMPTS_INVALID');
  if (value.paymentAttempts !== undefined) {
    const attempts = value.paymentAttempts;
    requireCheck(Array.isArray(attempts) && attempts.length > 0 && attempts.length <= 20
      && attempts[0]?.id === id && new Set(attempts.map(attempt => attempt?.id)).size === attempts.length
      && value.activeAttemptId === attempts.at(-1)?.id, 'ORDER_ATTEMPTS_INVALID');
    for (const [index, attempt] of attempts.entries()) {
      requireCheck(isRecord(attempt) && /^pay_[a-f0-9]{32}$/.test(attempt.id)
        && validTime(attempt.createdAt) && validTime(attempt.expiresAt)
        && ['PENDING', 'PAID', 'CLOSED'].includes(attempt.status)
        && (attempt.closedAt === undefined || validTime(attempt.closedAt))
        && (attempt.closeConfirmed === undefined || typeof attempt.closeConfirmed === 'boolean'), 'ORDER_ATTEMPTS_INVALID');
      const start = Date.parse(attempt.createdAt), deadline = Date.parse(attempt.expiresAt);
      requireCheck(index === 0 ? attempt.createdAt === value.createdAt
        && deadline === Math.min(Date.parse(value.expiresAt), start + PAYMENT_WINDOW_MS)
        : start >= Date.parse(attempts[index - 1].createdAt) && deadline === start + PAYMENT_WINDOW_MS, 'ORDER_ATTEMPT_WINDOW_INVALID');
      requireCheck((attempt.linkIssuedAt === undefined || validTime(attempt.linkIssuedAt)
        && Date.parse(attempt.linkIssuedAt) >= start && Date.parse(attempt.linkIssuedAt) <= deadline)
        && (attempt.linkExpiresAt === undefined || attempt.linkIssuedAt !== undefined && validTime(attempt.linkExpiresAt)
          && (attempt.linkExpiresAt === attempt.expiresAt || index === 0 && attempt.linkExpiresAt === value.expiresAt)), 'ORDER_ATTEMPT_LINK_INVALID');
      requireCheck(attempt.status !== 'PAID' || value.status === 'PAID'
        && typeof attempt.tradeNo === 'string' && /^\d{10,64}$/.test(attempt.tradeNo) && validTime(attempt.paidAt), 'ORDER_ATTEMPT_PAYMENT_INVALID');
    }
    const active = attempts.at(-1);
    requireCheck(value.status === 'PAID' ? attempts.some(attempt => attempt.status === 'PAID'
      && attempt.tradeNo === value.tradeNo && attempt.paidAt === value.paidAt) : active.status === value.status, 'ORDER_ATTEMPT_STATUS_MISMATCH');
  } else requireCheck(value.activeAttemptId === undefined, 'ORDER_ATTEMPTS_INVALID');
  if (value.adminOperation !== undefined) {
    const operation = value.adminOperation;
    requireCheck(isRecord(operation) && /^[A-Za-z0-9_-]{8,100}$/.test(operation.requestId)
      && /^op_[a-f0-9]{32}$/.test(operation.token) && ['close', 'reopen', 'reconcile'].includes(operation.action)
      && validTime(operation.expiresAt), 'ORDER_OPERATION_INVALID');
  }
  requireCheck(value.recentActionIds === undefined || Array.isArray(value.recentActionIds)
    && value.recentActionIds.length <= 20 && new Set(value.recentActionIds).size === value.recentActionIds.length
    && value.recentActionIds.every(requestId => typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(requestId)), 'ORDER_ACTION_REFERENCES_INVALID');
  if (value.duplicatePayments !== undefined) {
    const payments = value.duplicatePayments;
    requireCheck(value.status === 'PAID' && Array.isArray(payments) && payments.length <= 19
      && new Set(payments.map(payment => payment?.tradeNo)).size === payments.length, 'ORDER_DUPLICATE_PAYMENTS_INVALID');
    for (const payment of payments) requireCheck(isRecord(payment) && payment.amount === value.amount
      && payment.tradeNo !== value.tradeNo && typeof payment.tradeNo === 'string' && /^\d{10,64}$/.test(payment.tradeNo)
      && validTime(payment.paidAt) && value.paymentAttempts?.some(attempt => attempt.id === payment.attemptId
        && attempt.status === 'PAID' && attempt.tradeNo === payment.tradeNo && attempt.paidAt === payment.paidAt), 'ORDER_DUPLICATE_PAYMENTS_INVALID');
  }
  return value;
}
function orderAttempts(order) {
  return order.paymentAttempts ?? [{ id: order.id, createdAt: order.createdAt,
    expiresAt: new Date(Math.min(Date.parse(order.expiresAt), Date.parse(order.createdAt) + PAYMENT_WINDOW_MS)).toISOString(),
    status: order.status, ...(!order.attemptTrackingVersion ? { linkIssuedAt: order.createdAt, linkExpiresAt: order.expiresAt } : {}),
    ...(order.tradeNo ? { tradeNo: order.tradeNo } : {}), ...(order.paidAt ? { paidAt: order.paidAt } : {}) }];
}
function checkedAction(record, orderId, digest) {
  requireCheck(isRecord(record) && typeof record.requestId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(record.requestId)
    && sha256(record.requestId) === digest && /^pay_[a-f0-9]{32}$/.test(orderId)
    && ['close', 'reopen', 'reconcile'].includes(record.action)
    && typeof record.actor === 'string' && record.actor.length > 0 && record.actor.length <= 254
    && typeof record.reason === 'string' && record.reason.trim().length > 0 && record.reason.length <= 500
    && /^[a-f0-9]{64}$/.test(record.fingerprint) && validTime(record.startedAt)
    && ['running', 'completed', 'failed'].includes(record.status)
    && ['PENDING', 'PAID', 'CLOSED'].includes(record.beforeStatus)
    && (record.completedAt === undefined || validTime(record.completedAt)
      && Date.parse(record.completedAt) >= Date.parse(record.startedAt))
    && (record.afterStatus === undefined || ['PENDING', 'PAID', 'CLOSED'].includes(record.afterStatus))
    && (record.status !== 'completed' || validTime(record.completedAt) && record.afterStatus !== undefined), 'ORDER_ACTION_INVALID');
  return record;
}
function auditedAttempt(attempt, actionRecords) {
  return actionRecords.some(record => record.status === 'completed' && record.action === 'reopen'
    && record.beforeStatus === 'CLOSED' && record.afterStatus === 'PENDING' && record.attemptId === attempt.id
    && record.completedAt === attempt.createdAt && Date.parse(record.startedAt) <= Date.parse(attempt.createdAt));
}
export function needsPaidAttemptCleanup(order) {
  checkedOrder(order, order?.id);
  return order.status === 'PAID' && orderAttempts(order).some(attempt => attempt.status !== 'PAID'
    && !attempt.closeConfirmed && !!attempt.linkIssuedAt);
}
export function verifyAttemptEvidence(order, { mappings = new Map(), actionRecords = [] } = {}) {
  checkedOrder(order, order?.id);
  for (const action of actionRecords) checkedAction(action, order.id, sha256(action?.requestId ?? ''));
  for (const attempt of (order.paymentAttempts ?? []).slice(1)) {
    requireCheck(mappings.has(attempt.id), 'PAYMENT_ATTEMPT_MAPPING_MISSING');
    requireCheck(same(mappings.get(attempt.id), { orderId: order.id, mode: order.mode }), 'PAYMENT_ATTEMPT_MAPPING_INVALID');
    requireCheck(auditedAttempt(attempt, actionRecords), 'ORDER_REOPEN_AUDIT_MISSING');
  }
  requireCheck((order.recentActionIds ?? []).every(requestId => actionRecords.some(action => action.requestId === requestId)), 'ORDER_ACTION_REFERENCES_INVALID');
  requireCheck(!order.adminOperation || actionRecords.some(action => action.requestId === order.adminOperation.requestId
    && action.action === order.adminOperation.action && action.status === 'running'), 'ORDER_OPERATION_AUDIT_MISSING');
  return true;
}
function advances(before, after) {
  return before === after || (before === 'PENDING' && ['CLOSED', 'PAID'].includes(after))
    || (before === 'CLOSED' && after === 'PAID');
}
export function verifyOrderContinuity(before, after, { actionRecords = [] } = {}) {
  checkedOrder(before, before?.id); checkedOrder(after, before.id);
  requireCheck(Array.isArray(actionRecords), 'ORDER_ACTION_INVALID');
  for (const record of actionRecords) checkedAction(record, before.id, sha256(record?.requestId ?? ''));
  const immutable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !mutableOrderFields.has(key)));
  requireCheck(same(immutable(before), immutable(after)), 'ORDER_IMMUTABLE_FIELDS_CHANGED');
  const originalAttempts = orderAttempts(before), currentAttempts = orderAttempts(after);
  requireCheck(currentAttempts.length >= originalAttempts.length, 'ORDER_ATTEMPTS_REMOVED');
  for (const [index, attempt] of originalAttempts.entries()) {
    const current = currentAttempts[index];
    requireCheck(current?.id === attempt.id && current.createdAt === attempt.createdAt
      && current.expiresAt === attempt.expiresAt, 'ORDER_ATTEMPT_IMMUTABLE_FIELDS_CHANGED');
    requireCheck(advances(attempt.status, current.status), 'ORDER_ATTEMPT_STATUS_REGRESSED');
    for (const key of ['tradeNo', 'paidAt', 'linkIssuedAt', 'linkExpiresAt', 'closedAt']) {
      requireCheck(attempt[key] === undefined || current[key] === attempt[key], 'ORDER_ATTEMPT_HISTORY_CHANGED');
    }
  }
  const addedAttempts = currentAttempts.slice(originalAttempts.length);
  for (const attempt of addedAttempts) requireCheck(auditedAttempt(attempt, actionRecords), 'ORDER_REOPEN_AUDIT_MISSING');
  const reopened = addedAttempts.length > 0 && after.activeAttemptId === currentAttempts.at(-1).id;
  requireCheck(!reopened || before.status !== 'PAID', 'ORDER_STATUS_REGRESSED');
  requireCheck(advances(before.status, after.status) || before.status === 'CLOSED' && after.status === 'PENDING' && reopened, 'ORDER_STATUS_REGRESSED');
  requireCheck(before.attemptTrackingVersion === undefined || after.attemptTrackingVersion === before.attemptTrackingVersion, 'ORDER_ATTEMPT_TRACKING_REGRESSED');
  requireCheck(before.fulfillmentStatus !== 'delivered' || after.fulfillmentStatus === 'delivered', 'FULFILLMENT_REGRESSED');
  for (const key of ['tradeNo', 'paidAt']) requireCheck(before[key] === undefined || before[key] === after[key], 'ORDER_PAYMENT_FIELDS_CHANGED');
  requireCheck(before.lastCheckedAt === undefined || reopened && after.lastCheckedAt === undefined || (validTime(after.lastCheckedAt)
    && Date.parse(after.lastCheckedAt) >= Date.parse(before.lastCheckedAt)), 'ORDER_CHECK_TIME_REGRESSED');
  for (const payment of before.duplicatePayments ?? []) requireCheck(after.duplicatePayments?.some(current => same(current, payment)), 'ORDER_DUPLICATE_PAYMENT_REMOVED');
  return before.status !== after.status;
}

async function decryptRegistry(envelope, key) {
  requireCheck(isRecord(envelope) && envelope.schema === 1 && envelope.algorithm === 'AES-256-GCM'
    && typeof envelope.iv === 'string' && typeof envelope.ciphertext === 'string', 'REGISTRY_ENVELOPE_INVALID');
  requireCheck(/^[a-f0-9]{64}$/i.test(key), 'REGISTRY_KEY_INVALID');
  const iv = Buffer.from(envelope.iv, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  requireCheck(iv.length === 12 && ciphertext.length >= 16 && ciphertext.length <= MAX_RECORD_BYTES, 'REGISTRY_ENVELOPE_INVALID');
  let state;
  try {
    const material = await webcrypto.subtle.importKey('raw', Buffer.from(key, 'hex'), 'AES-GCM', false, ['decrypt']);
    const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv,
      additionalData: Buffer.from(`brclio-pay:registry:v1:${REGISTRY_PATH}`) }, material, ciphertext);
    requireCheck(plaintext.byteLength <= 128 * 1024, 'REGISTRY_TOO_LARGE');
    state = JSON.parse(Buffer.from(plaintext).toString('utf8'));
  } catch { throw new VerificationError('REGISTRY_DECRYPT_FAILED'); }
  requireCheck(isRecord(state) && state.schema === 1 && Number.isSafeInteger(state.revision)
    && state.revision >= 0 && Array.isArray(state.clients) && state.clients.length > 0
    && state.clients.length <= 100 && Array.isArray(state.grants) && Array.isArray(state.plans)
    && Array.isArray(state.audit), 'REGISTRY_INVALID');
  const ids = new Set();
  for (const client of state.clients) {
    requireCheck(isRecord(client) && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(client.id)
      && !ids.has(client.id) && typeof client.apiSecret === 'string' && client.apiSecret.length >= 32
      && typeof client.webhookSecret === 'string' && client.webhookSecret.length >= 32
      && typeof client.name === 'string' && typeof client.webhookUrl === 'string'
      && typeof client.enabled === 'boolean' && Array.isArray(client.returnOrigins)
      && isRecord(client.skus) && Object.keys(client.skus).length > 0, 'REGISTRY_CLIENT_INVALID');
    ids.add(client.id);
  }
  return state;
}

export function expectedOrderView(order, client, channels) {
  const returnUrl = new URL(order.returnUrl);
  returnUrl.searchParams.set('payment_order_id', order.id);
  returnUrl.searchParams.set('product_order_id', order.productOrderId);
  return { id: order.id, subject: order.subject, amount: order.amount, currency: 'CNY', status: order.status,
    productName: client.name, expiresAt: order.paymentAttempts ? orderAttempts(order).at(-1).expiresAt
      : order.status === 'PENDING' ? orderAttempts(order)[0].expiresAt : order.expiresAt, returnUrl: returnUrl.toString(),
    fulfillmentStatus: order.fulfillmentStatus, mode: order.mode, channels };
}
function comparePublicOrder(response, order, client, channels, product) {
  requireCheck(isRecord(response), 'PUBLIC_ORDER_INVALID');
  const expected = expectedOrderView(order, client, channels);
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'status') requireCheck(advances(order.status, response.status), 'PUBLIC_ORDER_STATUS_REGRESSED');
    else if (key === 'fulfillmentStatus') requireCheck(['pending', 'delivered'].includes(response[key])
      && (value !== 'delivered' || response[key] === value), 'PUBLIC_FULFILLMENT_REGRESSED');
    else requireCheck(same(value, response[key]), 'PUBLIC_ORDER_FIELDS_CHANGED');
  }
  if (product) {
    requireCheck(response.productOrderId === order.productOrderId && response.sku === order.sku, 'PUBLIC_ORDER_FIELDS_CHANGED');
    if (order.tradeNo !== undefined) requireCheck(response.tradeNo === order.tradeNo, 'PUBLIC_ORDER_PAYMENT_FIELDS_CHANGED');
    if (order.paidAt !== undefined) requireCheck(response.paidAt === order.paidAt, 'PUBLIC_ORDER_PAYMENT_FIELDS_CHANGED');
    requireCheck(response.status !== 'PAID' || (typeof response.tradeNo === 'string' && validTime(response.paidAt)), 'PUBLIC_ORDER_INVALID');
  }
  requireCheck(response.fulfillmentStatus !== 'delivered' || response.status === 'PAID', 'PUBLIC_ORDER_INVALID');
}

export async function verifyReporting(entries, record, orders) {
  const summaries = new Map(), indexed = new Set();
  const dateOf = value => new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 10);
  const zero = () => ({ paidAmountCents: 0, paidCount: 0, pendingCount: 0, closedCount: 0, deliveryPendingCount: 0 });
  const counters = Object.keys(zero());
  function monthBucket(mode, month) { return { schema: 1, mode, month, ...zero(), daily: {} }; }
  function totalBucket(mode) { return { schema: 1, mode, paidAmountCents: 0, paidCount: 0 }; }
  for (const [filename] of entries) if (filename.startsWith('reporting/v1/orders/')) {
    const match = /^reporting\/v1\/orders\/(live|sandbox)\/(\d{4}-\d{2})\/\d{8}T\d{9}Z_(pay_[a-f0-9]{32})\.json$/.exec(filename);
    requireCheck(match && orders.has(match[3]), 'REPORTING_ORDER_INVALID');
    const order = orders.get(match[3]), value = await record(filename);
    const projected = { id: order.id, mode: order.mode, clientId: order.clientId,
      productOrderId: order.productOrderId, sku: order.sku, subject: order.subject, amount: order.amount,
      amountCents: Math.round(Number(order.amount) * 100), status: order.status, createdAt: order.createdAt,
      expiresAt: order.expiresAt, ...(order.paidAt ? { paidAt: order.paidAt } : {}),
      ...(order.tradeNo ? { tradeNo: order.tradeNo } : {}), fulfillmentStatus: order.fulfillmentStatus,
      ...(order.duplicatePayments?.length ? { duplicatePayments: order.duplicatePayments.map(payment => ({ ...payment })) } : {}) };
    const indexKey = new Date(order.createdAt).toISOString().replace(/[-:.]/g, '') + '_' + order.id;
    requireCheck(filename === `reporting/v1/orders/${order.mode}/${dateOf(order.createdAt).slice(0, 7)}/${indexKey}.json`
      && !indexed.has(order.id) && same(value, { schema: 1, order: projected }), 'REPORTING_ORDER_MISMATCH');
    indexed.add(order.id);
    const date = dateOf(order.status === 'PAID' ? order.paidAt : order.createdAt), month = date.slice(0, 7);
    for (const scope of ['all', 'clients/' + order.clientId]) {
      const prefix = `reporting/v1/${order.mode}/summary/${scope}/`, monthPath = prefix + 'months/' + month + '.json';
      if (!summaries.has(monthPath)) summaries.set(monthPath, monthBucket(order.mode, month));
      const bucket = summaries.get(monthPath);
      if (order.status === 'PENDING') bucket.pendingCount++;
      if (order.status === 'CLOSED') bucket.closedCount++;
      if (order.status === 'PAID') {
        bucket.paidCount++; bucket.paidAmountCents += projected.amountCents;
        if (order.fulfillmentStatus !== 'delivered') bucket.deliveryPendingCount++;
        bucket.daily[date] ??= { paidAmountCents: 0, paidCount: 0 };
        bucket.daily[date].paidCount++; bucket.daily[date].paidAmountCents += projected.amountCents;
        const totalPath = prefix + 'total.json';
        if (!summaries.has(totalPath)) summaries.set(totalPath, totalBucket(order.mode));
        summaries.get(totalPath).paidCount++; summaries.get(totalPath).paidAmountCents += projected.amountCents;
      }
      for (const payment of order.duplicatePayments ?? []) {
        const day = dateOf(payment.paidAt), extraMonth = day.slice(0, 7), extraPath = prefix + 'months/' + extraMonth + '.json';
        if (!summaries.has(extraPath)) summaries.set(extraPath, monthBucket(order.mode, extraMonth));
        const extra = summaries.get(extraPath), amount = Math.round(Number(payment.amount) * 100);
        extra.paidCount++; extra.paidAmountCents += amount;
        extra.daily[day] ??= { paidAmountCents: 0, paidCount: 0 };
        extra.daily[day].paidCount++; extra.daily[day].paidAmountCents += amount;
        const totalPath = prefix + 'total.json';
        if (!summaries.has(totalPath)) summaries.set(totalPath, totalBucket(order.mode));
        summaries.get(totalPath).paidCount++; summaries.get(totalPath).paidAmountCents += amount;
      }
    }
  }
  let summaryCount = 0;
  for (const [filename] of entries) if (filename.startsWith('reporting/v1/') && !filename.startsWith('reporting/v1/orders/')) {
    const match = /^reporting\/v1\/(live|sandbox)\/summary\/(?:all|clients\/[a-z0-9][a-z0-9_-]{1,63})\/(?:months\/(\d{4}-\d{2})|total)\.json$/.exec(filename);
    requireCheck(match, 'REPORTING_PATH_INVALID');
    const value = await record(filename), expected = summaries.get(filename)
      ?? (match[2] ? monthBucket(match[1], match[2]) : totalBucket(match[1]));
    requireCheck(isRecord(value) && value.schema === 1 && value.mode === expected.mode
      && (match[2] ? value.month === expected.month : true), 'REPORTING_SUMMARY_INVALID');
    for (const key of match[2] ? counters : ['paidAmountCents', 'paidCount']) {
      requireCheck(Number.isSafeInteger(value[key]) && value[key] === expected[key], 'REPORTING_COUNTER_MISMATCH');
    }
    if (match[2]) {
      requireCheck(isRecord(value.daily), 'REPORTING_DAILY_INVALID');
      for (const [date, actual] of Object.entries(value.daily)) {
        requireCheck(/^\d{4}-\d{2}-\d{2}$/.test(date) && date.startsWith(match[2] + '-')
          && same(actual, expected.daily[date] ?? { paidAmountCents: 0, paidCount: 0 }), 'REPORTING_DAILY_MISMATCH');
      }
      for (const [date, day] of Object.entries(expected.daily)) requireCheck(same(value.daily[date], day), 'REPORTING_DAILY_MISSING');
    }
    summaryCount++;
  }
  for (const filename of summaries.keys()) requireCheck(entries.has(filename), 'REPORTING_SUMMARY_MISSING');
  return { reportingVerified: true, reportingSummaryCount: summaryCount,
    indexedOrderCount: indexed.size, unindexedOrderCount: orders.size - indexed.size,
    reportingCoverageComplete: indexed.size === orders.size };
}

function checkedBaseline(baseline) {
  requireCheck(isRecord(baseline) && baseline.repository?.full_name === REPOSITORY
    && baseline.repository.private === true && baseline.ref?.ref === `refs/heads/${BRANCH}`
    && SHA.test(baseline.ref?.object?.sha) && baseline.commit?.sha === baseline.ref.object.sha
    && SHA.test(baseline.commit?.tree?.sha) && isRecord(baseline.pathBlobShas)
    && Object.keys(baseline.pathBlobShas).length > 0 && Array.isArray(baseline.orders)
    && isRecord(baseline.registry), 'BASELINE_INVALID');
  for (const [key, value] of Object.entries(baseline.pathBlobShas)) {
    requireCheck(typeof key === 'string' && !key.startsWith('/') && !key.split('/').includes('..')
      && SHA.test(value), 'BASELINE_INVALID');
  }
  requireCheck(SHA.test(baseline.pathBlobShas[REGISTRY_PATH]), 'BASELINE_REGISTRY_MISSING');
  return baseline;
}

// The only remote methods used here are GET. Product /refresh and /pay routes are excluded.
export async function verifyMigration({ runtime, baseline = null, baseUrls, expected, fetcher = fetch, dispatcher }) {
  requireCheck(isRecord(runtime) && REQUIRED_RUNTIME.every(key => typeof runtime[key] === 'string'
    && runtime[key].length > 0) && !/[\r\n]/.test(runtime.GITHUB_TOKEN)
    && runtime.CHECKOUT_SECRET.length >= 32, 'RUNTIME_BACKUP_INVALID');
  requireCheck(isRecord(expected) && ['live', 'sandbox'].includes(expected.mode)
    && typeof expected.paymentEnabled === 'boolean' && Array.isArray(expected.channels)
    && expected.channels.every(value => ['page', 'wap'].includes(value)), 'EXPECTED_CONFIGURATION_INVALID');
  const bases = [...new Set(baseUrls.map(origin))];
  requireCheck(bases.length > 0 && bases.length <= 8, 'BASE_URL_COUNT_INVALID');
  if (baseline) checkedBaseline(baseline);
  let getRequestCount = 0;
  const allowedBasePaths = /^\/api\/(?:health|v1\/catalog|v1\/orders\/pay_[a-f0-9]{32}|checkout\/pay_[a-f0-9]{32})$/;
  async function get(url, headers = {}, maxBytes = 1024 * 1024) {
    const parsed = new URL(url);
    const github = parsed.origin === 'https://api.github.com'
      && parsed.pathname.startsWith(`/repos/${REPOSITORY}`);
    requireCheck(github || (bases.includes(parsed.origin) && !parsed.search && allowedBasePaths.test(parsed.pathname)), 'REQUEST_NOT_ALLOWED');
    let response;
    try {
      getRequestCount++;
      response = await fetcher(parsed, { method: 'GET', redirect: 'manual', headers,
        dispatcher, signal: AbortSignal.timeout(30_000) });
    } catch { throw new VerificationError('NETWORK_REQUEST_FAILED'); }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new VerificationError(github ? 'GITHUB_GET_REJECTED' : 'SERVICE_GET_REJECTED');
    }
    return boundedJson(response, maxBytes);
  }
  const github = suffix => get(`https://api.github.com/repos/${REPOSITORY}${suffix}`, {
    Authorization: `Bearer ${runtime.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'brclio-pay-migration-verifier',
  }, 8 * 1024 * 1024);
  const repository = await github('');
  requireCheck(repository.private === true && repository.full_name === REPOSITORY, 'REPOSITORY_BOUNDARY_MISMATCH');
  const ref = await github(`/git/ref/heads/${BRANCH}`);
  requireCheck(ref.ref === `refs/heads/${BRANCH}` && SHA.test(ref.object?.sha), 'REFERENCE_INVALID');
  const commit = await github(`/git/commits/${ref.object.sha}`);
  requireCheck(commit.sha === ref.object.sha && SHA.test(commit.tree?.sha), 'COMMIT_INVALID');
  const tree = await github(`/git/trees/${commit.tree.sha}?recursive=1`);
  requireCheck(tree.sha === commit.tree.sha && tree.truncated === false && Array.isArray(tree.tree)
    && tree.tree.length <= 20_000, 'TREE_INCOMPLETE');
  const entries = new Map();
  for (const entry of tree.tree) {
    requireCheck(isRecord(entry) && typeof entry.path === 'string' && !entry.path.startsWith('/')
      && !entry.path.split('/').includes('..') && SHA.test(entry.sha), 'TREE_INVALID');
    if (entry.type !== 'blob') continue;
    requireCheck(entry.mode === '100644' && Number.isSafeInteger(entry.size) && entry.size >= 0
      && entry.size <= MAX_RECORD_BYTES && !entries.has(entry.path), 'TREE_BLOB_INVALID');
    entries.set(entry.path, entry);
  }
  const blobCache = new Map();
  async function blob(sha) {
    requireCheck(SHA.test(sha), 'BLOB_SHA_INVALID');
    if (!blobCache.has(sha)) blobCache.set(sha, (async () => {
      const result = await github(`/git/blobs/${sha}`);
      requireCheck(result.sha === sha && result.encoding === 'base64' && typeof result.content === 'string'
        && Number.isSafeInteger(result.size) && result.size <= MAX_RECORD_BYTES, 'BLOB_INVALID');
      const bytes = Buffer.from(result.content, 'base64');
      requireCheck(bytes.length === result.size && gitBlobSha(bytes) === sha, 'BLOB_HASH_MISMATCH');
      try { return JSON.parse(bytes.toString('utf8')); }
      catch { throw new VerificationError('BLOB_JSON_INVALID'); }
    })());
    return blobCache.get(sha);
  }
  async function record(filename) {
    requireCheck(entries.has(filename), 'LEDGER_RECORD_MISSING');
    return blob(entries.get(filename).sha);
  }
  requireCheck(entries.has(REGISTRY_PATH), 'ENCRYPTED_REGISTRY_REQUIRED');
  const registry = await decryptRegistry(await record(REGISTRY_PATH), runtime.REGISTRY_ENCRYPTION_KEY);
  const orders = new Map();
  const orderEntries = [...entries].filter(([filename]) => ORDER_PATH.test(filename));
  requireCheck(orderEntries.length <= 2000, 'ORDER_VERIFICATION_LIMIT_EXCEEDED');
  for (const [filename] of orderEntries) {
    const id = ORDER_PATH.exec(filename)[1];
    orders.set(id, checkedOrder(await record(filename), id));
  }
  const orderActions = new Map();
  for (const [filename] of entries) if (filename.startsWith('order-actions/')) {
    const match = ACTION_PATH.exec(filename);
    requireCheck(match && orders.has(match[1]), 'ORDER_ACTION_PATH_INVALID');
    const action = checkedAction(await record(filename), match[1], match[2]);
    if (!orderActions.has(match[1])) orderActions.set(match[1], []);
    orderActions.get(match[1]).push(action);
  }
  const attemptMappings = new Map();
  for (const [filename] of entries) if (filename.startsWith('payment-attempts/')) {
    const match = ATTEMPT_PATH.exec(filename), mapping = await record(filename);
    const order = isRecord(mapping) ? orders.get(mapping.orderId) : undefined;
    requireCheck(match && order && same(mapping, { orderId: order.id, mode: order.mode })
      && match[1] !== order.id && order.paymentAttempts?.some(attempt => attempt.id === match[1]), 'PAYMENT_ATTEMPT_MAPPING_INVALID');
    attemptMappings.set(match[1], mapping);
  }
  for (const order of orders.values()) {
    const actions = orderActions.get(order.id) ?? [];
    verifyAttemptEvidence(order, { mappings: attemptMappings, actionRecords: actions });
  }
  const deliveries = new Map();
  for (const [filename] of entries) if (EVENT_PATH.test(filename)) {
    const delivery = await record(filename);
    requireCheck(isRecord(delivery) && isRecord(delivery.event) && isRecord(delivery.event.data)
      && delivery.event.id === EVENT_PATH.exec(filename)[1] && delivery.event.type === 'payment.paid'
      && Number.isSafeInteger(delivery.attempts) && delivery.attempts >= 0
      && validTime(delivery.nextAttemptAt) && (delivery.deliveredAt === undefined || validTime(delivery.deliveredAt)), 'OUTBOX_INVALID');
    const order = orders.get(delivery.event.data.orderId);
    requireCheck(order && order.status === 'PAID' && delivery.event.mode === order.mode
      && delivery.event.data.clientId === order.clientId && delivery.event.data.productOrderId === order.productOrderId
      && delivery.event.data.sku === order.sku && delivery.event.data.amount === order.amount
      && delivery.event.data.currency === 'CNY' && delivery.event.data.tradeNo === order.tradeNo
      && delivery.event.data.paidAt === order.paidAt, 'OUTBOX_ORDER_MISMATCH');
    deliveries.set(delivery.event.id, delivery);
  }
  const queue = await record('system/queue.json');
  requireCheck(isRecord(queue) && Array.isArray(queue.orders) && Array.isArray(queue.deliveries)
    && queue.orders.length === new Set(queue.orders).size && queue.deliveries.length === new Set(queue.deliveries).size
    && queue.orders.every(id => orders.has(id) && (orders.get(id).status === 'PENDING' || needsPaidAttemptCleanup(orders.get(id))))
    && queue.deliveries.every(id => deliveries.has(id) && !deliveries.get(id).deliveredAt), 'QUEUE_INVALID');
  for (const order of orders.values()) requireCheck(!needsPaidAttemptCleanup(order) || queue.orders.includes(order.id), 'PAID_ATTEMPT_CLEANUP_NOT_QUEUED');
  const reporting = await verifyReporting(entries, record, orders);

  let historicalBlobCount = 0, unchangedHistoricalBlobCount = 0, changedHistoricalOrderCount = 0;
  let advancedHistoricalOrderCount = 0, mutableHistoricalBlobCount = 0;
  let originalRuntimeBackupVerified = false;
  if (baseline) {
    if (Array.isArray(baseline.sourceSettings?.bindings)) {
      const originalVariables = new Map(baseline.sourceSettings.bindings
        .filter(binding => binding.type === 'plain_text').map(binding => [binding.name, binding.text]));
      requireCheck(Object.entries(runtime).every(([name, value]) => originalVariables.get(name) === value), 'ORIGINAL_RUNTIME_BACKUP_MISMATCH');
      originalRuntimeBackupVerified = true;
    }
    const baselineCommitSha = baseline.ref.object.sha;
    const comparison = await github(`/compare/${baselineCommitSha}...${commit.sha}`);
    requireCheck(['identical', 'ahead'].includes(comparison.status)
      && comparison.merge_base_commit?.sha === baselineCommitSha, 'BASELINE_HISTORY_NOT_RETAINED');
    requireCheck(entries.get(REGISTRY_PATH).sha === baseline.pathBlobShas[REGISTRY_PATH]
      && same(registry, baseline.registry), 'ORIGINAL_REGISTRY_CHANGED');
    for (const [filename, oldSha] of Object.entries(baseline.pathBlobShas)) {
      historicalBlobCount++;
      const current = entries.get(filename);
      requireCheck(current, 'HISTORICAL_BLOB_MISSING');
      if (current.sha === oldSha) { unchangedHistoricalBlobCount++; continue; }
      if (ORDER_PATH.test(filename)) {
        changedHistoricalOrderCount++;
        const id = ORDER_PATH.exec(filename)[1];
        if (verifyOrderContinuity(await blob(oldSha), orders.get(id), { actionRecords: orderActions.get(id) ?? [] })) advancedHistoricalOrderCount++;
      } else if (EVENT_PATH.test(filename)) {
        const before = await blob(oldSha), after = await record(filename);
        requireCheck(same(before.event, after.event) && after.attempts >= before.attempts
          && (before.deliveredAt === undefined || before.deliveredAt === after.deliveredAt), 'HISTORICAL_OUTBOX_CHANGED');
        mutableHistoricalBlobCount++;
      } else if (ACTION_PATH.test(filename)) {
        const match = ACTION_PATH.exec(filename), before = checkedAction(await blob(oldSha), match[1], match[2]);
        const after = checkedAction(await record(filename), match[1], match[2]);
        const completed = before.status === 'running' && ['completed', 'failed'].includes(after.status);
        const latePaidProof = before.status === 'failed' && after.status === 'failed'
          && before.errorCode === 'OPERATION_EXPIRED' && after.errorCode === 'OPERATION_EXPIRED'
          && after.afterStatus === 'PAID' && orders.get(match[1]).status === 'PAID'
          && validTime(after.completedAt) && Date.parse(after.completedAt) >= Date.parse(before.completedAt);
        requireCheck((completed || latePaidProof)
          && ['requestId', 'action', 'actor', 'reason', 'fingerprint', 'startedAt', 'beforeStatus'].every(key => same(before[key], after[key])), 'HISTORICAL_ORDER_ACTION_CHANGED');
        mutableHistoricalBlobCount++;
      } else if (filename === 'system/queue.json' || filename.startsWith('reporting/v1/')) {
        // Queue/reporting are mutable projections, not purchase snapshots. Their old blobs
        // remain reachable through the verified ancestor commit. Current orders,
        // outbox, queue references and reporting counters are validated above.
        mutableHistoricalBlobCount++;
      } else throw new VerificationError('HISTORICAL_IMMUTABLE_BLOB_CHANGED');
    }
    for (const item of baseline.orders) {
      requireCheck(isRecord(item) && isRecord(item.entry) && ORDER_PATH.test(item.entry.path)
        && item.entry.sha === baseline.pathBlobShas[item.entry.path], 'BASELINE_ORDER_INVALID');
      const before = await blob(item.entry.sha);
      requireCheck(same(before, item.order), 'BASELINE_ORDER_SNAPSHOT_MISMATCH');
      const id = ORDER_PATH.exec(item.entry.path)[1];
      verifyOrderContinuity(before, orders.get(id), { actionRecords: orderActions.get(id) ?? [] });
    }
  }
  const result = {
    schema: 1, verified: false, allRequestsGet: true, noOrdersCreated: true, noAlipayRequests: true,
    noAdminSessionSynthesized: true, baselineProvided: !!baseline, repositoryPrivate: true,
    ledgerCommitSha: commit.sha, ledgerTreeSha: commit.tree.sha, ledgerBlobCount: entries.size,
    registryBlobSha: entries.get(REGISTRY_PATH).sha, registryPlaintextHash: sha256(stable(registry)),
    registryKeyVerified: true, originalRegistryVerified: !!baseline,
    originalRuntimeBackupVerified,
    registryClientCount: registry.clients.length, registryGrantCount: registry.grants.length,
    registryPlanCount: registry.plans.length, registryAuditCount: registry.audit.length,
    orderCount: orders.size, eventCount: deliveries.size, paymentAttemptCount: attemptMappings.size,
    orderActionCount: [...orderActions.values()].reduce((count, actions) => count + actions.length, 0),
    queuedOrderCount: queue.orders.length, queuedPaidCleanupCount: queue.orders.filter(id => needsPaidAttemptCleanup(orders.get(id))).length,
    queuedDeliveryCount: queue.deliveries.length, historicalBlobCount, unchangedHistoricalBlobCount,
    changedHistoricalOrderCount, advancedHistoricalOrderCount, mutableHistoricalBlobCount,
    ...reporting, targets: [],
  };
  for (const base of bases) {
    const health = await get(base + '/api/health');
    requireCheck(health.service === 'Brclio Pay' && health.version === expected.version
      && health.mode === expected.mode && health.ready === true
      && health.acceptingPayments === expected.paymentEnabled, 'HEALTH_MISMATCH');
    let catalogCount = 0, productOrderCount = 0, checkoutOrderCount = 0, skuCount = 0;
    for (const client of registry.clients) {
      function signedHeaders(route) {
        const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(18).toString('base64url');
        return { 'X-Brclio-Client': client.id, 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Nonce': nonce,
          'X-Brclio-Signature': hmac(client.apiSecret, ['GET', route, timestamp, nonce, sha256('')].join('\n')) };
      }
      const catalog = await get(base + '/api/v1/catalog', signedHeaders('/api/v1/catalog'));
      const skus = Object.fromEntries(Object.entries(client.skus).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, { ...value, enabled: value.enabled !== false }]));
      requireCheck(catalog.clientId === client.id && catalog.name === client.name
        && catalog.enabled === client.enabled && catalog.mode === expected.mode && catalog.currency === 'CNY'
        && catalog.acceptingPayments === (expected.paymentEnabled && client.enabled)
        && same(catalog.skus, skus) && catalog.version === sha256(JSON.stringify(skus)), 'CATALOG_MISMATCH');
      catalogCount++; skuCount += Object.keys(skus).length;
      for (const order of orders.values()) {
        if (order.clientId !== client.id || order.mode !== expected.mode) continue;
        const route = '/api/v1/orders/' + order.id;
        const productOrder = await get(base + route, signedHeaders(route));
        comparePublicOrder(productOrder, order, client, expected.channels, true); productOrderCount++;
        const checkoutOrder = await get(base + '/api/checkout/' + order.id,
          { Authorization: 'Bearer ' + hmac(runtime.CHECKOUT_SECRET, 'brclio-checkout-v1:' + order.id) });
        comparePublicOrder(checkoutOrder, order, client, expected.channels, false); checkoutOrderCount++;
      }
    }
    const relevantOrders = [...orders.values()].filter(order => order.mode === expected.mode);
    requireCheck(productOrderCount === relevantOrders.length, 'ORDER_CLIENT_MISSING_FROM_REGISTRY');
    result.targets.push({ baseUrlHash: sha256(base), healthVerified: true, allCatalogsVerified: true,
      catalogCount, skuCount, productOrderCount, checkoutOrderCount,
      allStoredModeOrdersVerified: productOrderCount === relevantOrders.length,
      existingCheckoutTokensVerified: checkoutOrderCount === relevantOrders.length });
  }
  result.getRequestCount = getRequestCount; result.verified = true;
  return result;
}

function help() {
  return `Usage: node scripts/verify-migration.mjs --base https://TARGET [--base https://SECOND] [options]

Read-only verification of the fixed private GitHub main ledger, AES-GCM registry,
historical purchase snapshots, signed product catalogs/order reads and existing
checkout HMAC tokens. Every remote request is GET; no refresh/pay/admin synthesis,
Alipay call, order creation, registry write or data restore is performed.

  --runtime FILE   Original runtime backup (default secrets/runtime-variables-maintenance.json)
  --baseline FILE  Prior restricted migration snapshot; defaults to ${DEFAULT_BASELINE} if present
  --out FILE       Create sanitized evidence inside secrets/ only, with mode 0600; never overwrite
  --help           Show this help

Use trusted target origins only. Repeating --base verifies every stored order in
the configured payment mode at each target. Supply a baseline to assert the
original registry and historical blobs survived; without one only current
consistency/access is verified. Expected mode, channels, switch and version come
from wrangler.jsonc/package.json. No credentials, personal records, identifiers,
amounts or origin URLs are printed or saved in evidence, only counts/flags/hashes.
Mutable queue/reporting blobs may legitimately change; their old blobs must
remain in ancestor history. Audited reopening preserves the logical purchase,
uses a fresh mapped attempt and has a ten-minute window. PAID orders may remain
queued only for closing other issued attempts. Historical paid identities stay
immutable. Reporting recomputes every unique real receipt, including additional
payments by their own Shanghai date; incomplete legacy coverage is counted.
This check does not verify actual money/entitlements,
DNS ownership, target Cloudflare account, cron execution or deployment triggers.\n`;
}
function parseArgs(args) {
  const result = { bases: [], runtime: 'secrets/runtime-variables-maintenance.json' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help' || key === '-h') { result.help = true; continue; }
    requireCheck(['--base', '--runtime', '--baseline', '--out'].includes(key)
      && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--'), 'INVALID_ARGUMENT');
    const value = args[++i];
    if (key === '--base') result.bases.push(value);
    else result[key.slice(2)] = value;
  }
  return result;
}
function saveEvidence(filename, result) {
  const secrets = realpathSync(path.join(ROOT, 'secrets'));
  const target = path.resolve(ROOT, filename), parent = realpathSync(path.dirname(target));
  const relative = path.relative(secrets, parent);
  requireCheck((relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..'
    && !path.isAbsolute(relative))) && path.basename(target) !== '.', 'EVIDENCE_PATH_OUTSIDE_SECRETS');
  let fd;
  try {
    fd = openSync(target, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(result, null, 2) + '\n');
  } catch { throw new VerificationError('EVIDENCE_WRITE_FAILED'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function main(args = process.argv.slice(2)) {
  let dispatcher;
  try {
    const options = parseArgs(args);
    if (options.help) { console.log(help()); return; }
    requireCheck(options.bases.length > 0, 'BASE_URL_REQUIRED');
    const runtime = jsonFile(path.resolve(ROOT, options.runtime));
    const baselinePath = options.baseline ?? (existsSync(path.join(ROOT, DEFAULT_BASELINE)) ? DEFAULT_BASELINE : null);
    const baseline = baselinePath ? jsonFile(path.resolve(ROOT, baselinePath)) : null;
    const configSource = readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
    // Wrangler's checked-in JSONC currently contains no comments. Use TypeScript's
    // parser so future legal JSONC comments never require unsafe evaluation.
    const { default: ts } = await import('typescript');
    const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', configSource);
    requireCheck(!parsed.error && isRecord(parsed.config?.vars), 'CONFIGURATION_INVALID');
    const vars = parsed.config.vars;
    requireCheck(vars.GITHUB_REPOSITORY === REPOSITORY && vars.GITHUB_BRANCH === BRANCH
      && ['true', 'false'].includes(vars.PAYMENT_ENABLED), 'CONFIGURATION_BOUNDARY_MISMATCH');
    const version = jsonFile(path.join(ROOT, 'package.json')).version;
    requireCheck(typeof version === 'string', 'CONFIGURATION_INVALID');
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
    const result = await verifyMigration({ runtime, baseline, baseUrls: options.bases, dispatcher,
      expected: { version, mode: vars.PAYMENT_MODE, paymentEnabled: vars.PAYMENT_ENABLED === 'true',
        channels: vars.ALIPAY_CHANNELS.split(',') } });
    if (options.out) saveEvidence(options.out, result);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ verified: false, errorCode: error instanceof VerificationError
      ? error.code : 'VERIFICATION_FAILED' }));
    process.exitCode = 1;
  } finally { try { await dispatcher?.close(); } catch { process.exitCode = 1; } }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
