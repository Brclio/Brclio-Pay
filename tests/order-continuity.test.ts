import { describe, expect, it } from 'vitest';
import type { Order, PaymentAttempt } from '../src/types';

const source = () => import(new URL('../scripts/verify-migration.mjs', import.meta.url).href);
const ID = 'pay_' + 'a'.repeat(32), NEXT = 'pay_' + 'b'.repeat(32);
const START = Date.parse('2026-10-19T00:00:00.000Z');
const time = (offset: number) => new Date(START + offset).toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const TRADE = '2026101922001400000000000000', EXTRA = '2026101922001400000000000001';
function original(status: Order['status'] = 'CLOSED'): Order {
  return { id: ID, mode: 'live', clientId: 'product', productOrderId: 'purchase-1', sku: 'pro',
    subject: 'Original item', amount: '9.90', status, createdAt: time(0), expiresAt: time(600_000),
    returnUrl: 'https://product.example/return', requestHash: 'c'.repeat(64), fulfillmentStatus: 'pending', attemptTrackingVersion: 1,
    ...(status === 'PAID' ? { tradeNo: TRADE, paidAt: time(60_000) } : {}) };
}
function reopened() {
  const before = original(), after = clone(before);
  const first: PaymentAttempt = { id: ID, createdAt: time(0), expiresAt: time(600_000), status: 'CLOSED', closedAt: time(600_000), closeConfirmed: false };
  const next: PaymentAttempt = { id: NEXT, createdAt: time(1_200_000), expiresAt: time(1_800_000), status: 'PENDING' };
  after.status = 'PENDING'; after.activeAttemptId = NEXT; after.paymentAttempts = [first, next]; after.recentActionIds = ['reopen_request_1'];
  const action = { requestId: 'reopen_request_1', action: 'reopen', actor: 'admin@example.com', reason: 'User asked to continue the purchase',
    fingerprint: 'd'.repeat(64), status: 'completed', beforeStatus: 'CLOSED', afterStatus: 'PENDING',
    startedAt: time(1_199_000), completedAt: time(1_200_000), attemptId: NEXT };
  const actionRecords = [action], mappings = new Map([[NEXT, { orderId: ID, mode: 'live' }]]);
  return { before, after, action, actionRecords, mappings };
}
function paidWithRemaining(): Order {
  const { after } = reopened();
  after.status = 'PAID'; after.tradeNo = TRADE; after.paidAt = time(60_000);
  Object.assign(after.paymentAttempts![0], { status: 'PAID', tradeNo: TRADE, paidAt: after.paidAt });
  Object.assign(after.paymentAttempts![1], { linkIssuedAt: time(1_200_000), linkExpiresAt: time(1_800_000) });
  return after;
}

describe('read-only migration verification of administrator order changes', () => {
  it('accepts a reopened logical purchase only with its completed action and persistent attempt mapping', async () => {
    const { verifyOrderContinuity, verifyAttemptEvidence } = await source(), f = reopened();
    expect(verifyOrderContinuity(f.before, f.after, f)).toBe(true);
    expect(verifyAttemptEvidence(f.after, f)).toBe(true);
    expect(() => verifyOrderContinuity(f.before, f.after)).toThrow('ORDER_REOPEN_AUDIT_MISSING');
    expect(() => verifyAttemptEvidence(f.after, { actionRecords: f.actionRecords })).toThrow('PAYMENT_ATTEMPT_MAPPING_MISSING');
    expect(() => verifyAttemptEvidence(f.after, { ...f, mappings: new Map([[NEXT, { orderId: ID, mode: 'sandbox' }]]) })).toThrow('PAYMENT_ATTEMPT_MAPPING_INVALID');
  });
  it.each(['running', 'failed', 'wrong-attempt', 'wrong-time', 'wrong-before', 'wrong-after'])('rejects a %s reopening audit', async mutation => {
    const { verifyOrderContinuity } = await source(), f = reopened();
    if (mutation === 'running' || mutation === 'failed') f.action.status = mutation;
    if (mutation === 'wrong-attempt') f.action.attemptId = ID;
    if (mutation === 'wrong-time') f.action.completedAt = time(1_200_001);
    if (mutation === 'wrong-before') f.action.beforeStatus = 'PENDING';
    if (mutation === 'wrong-after') f.action.afterStatus = 'PAID';
    expect(() => verifyOrderContinuity(f.before, f.after, f)).toThrow('ORDER_REOPEN_AUDIT_MISSING');
  });
  it.each(['amount', 'sku', 'subject', 'createdAt', 'expiresAt', 'productOrderId', 'clientId', 'returnUrl', 'requestHash'] as const)('rejects changes to purchase snapshot %s', async key => {
    const { verifyOrderContinuity } = await source(), f = reopened();
    const changes = { amount: '19.90', sku: 'other', subject: 'Changed item', createdAt: time(1), expiresAt: time(600_001),
      productOrderId: 'different-purchase', clientId: 'different-product', returnUrl: 'https://product.example/changed', requestHash: 'e'.repeat(64) };
    f.after[key] = changes[key];
    expect(() => verifyOrderContinuity(f.before, f.after, f)).toThrow();
  });
  it('rejects reopening the same provider attempt or extending a new attempt beyond ten minutes', async () => {
    const { verifyOrderContinuity } = await source(), f = reopened();
    expect(() => verifyOrderContinuity(f.before, { ...f.before, status: 'PENDING' })).toThrow('ORDER_ATTEMPT_STATUS_REGRESSED');
    f.after.paymentAttempts![1].expiresAt = time(1_800_001);
    expect(() => verifyOrderContinuity(f.before, f.after, f)).toThrow('ORDER_ATTEMPT_WINDOW_INVALID');
  });
  it('preserves legacy thirty-minute signed-link deadlines when adopting attempt tracking', async () => {
    const { verifyOrderContinuity } = await source(), before = original();
    delete before.attemptTrackingVersion; before.expiresAt = time(1_800_000);
    const after = clone(before); after.activeAttemptId = ID;
    after.paymentAttempts = [{ id: ID, createdAt: time(0), expiresAt: time(600_000), status: 'CLOSED',
      linkIssuedAt: time(0), linkExpiresAt: time(1_800_000) }];
    expect(verifyOrderContinuity(before, after)).toBe(false);
    after.paymentAttempts[0].linkExpiresAt = time(600_000);
    expect(() => verifyOrderContinuity(before, after)).toThrow('ORDER_ATTEMPT_HISTORY_CHANGED');
  });
  it('keeps historical paid identity, payment time and already recorded extra payments immutable', async () => {
    const { verifyOrderContinuity } = await source(), before = paidWithRemaining();
    const after = clone(before); after.paymentAttempts![1].status = 'PAID'; after.paymentAttempts![1].tradeNo = EXTRA; after.paymentAttempts![1].paidAt = time(1_250_000);
    after.duplicatePayments = [{ attemptId: NEXT, tradeNo: EXTRA, paidAt: time(1_250_000), amount: '9.90' }];
    expect(verifyOrderContinuity(before, after)).toBe(false);
    const lost = clone(after); delete lost.duplicatePayments;
    expect(() => verifyOrderContinuity(after, lost)).toThrow('ORDER_DUPLICATE_PAYMENT_REMOVED');
    const changed = clone(after); changed.paidAt = time(60_001);
    expect(() => verifyOrderContinuity(after, changed)).toThrow();
    const regressed = clone(after); regressed.status = 'PENDING';
    expect(() => verifyOrderContinuity(after, regressed)).toThrow();
  });
  it('permits clearing the old query throttle only when a new audited attempt was created', async () => {
    const { verifyOrderContinuity } = await source(), f = reopened();
    f.before.lastCheckedAt = time(50_000);
    expect(verifyOrderContinuity(f.before, f.after, f)).toBe(true);
    expect(() => verifyOrderContinuity(f.before, { ...f.before, lastCheckedAt: undefined })).toThrow('ORDER_CHECK_TIME_REGRESSED');
  });
  it('uses the active payment deadline for API comparison while retaining the original ledger deadline', async () => {
    const { expectedOrderView } = await source(), f = reopened();
    const view = expectedOrderView(f.after, { name: 'Product' }, ['page']);
    expect(view.expiresAt).toBe(time(1_800_000)); expect(f.after.expiresAt).toBe(time(600_000));
  });
  it('allows paid orders in maintenance only while another issued attempt still needs safe closure', async () => {
    const { needsPaidAttemptCleanup } = await source(), order = paidWithRemaining();
    expect(needsPaidAttemptCleanup(order)).toBe(true);
    order.paymentAttempts![1].status = 'CLOSED';
    expect(needsPaidAttemptCleanup(order)).toBe(true); // Passing a URL deadline alone is not provider confirmation.
    order.paymentAttempts![1].closeConfirmed = true;
    expect(needsPaidAttemptCleanup(order)).toBe(false);
    delete order.paymentAttempts![1].linkIssuedAt; delete order.paymentAttempts![1].linkExpiresAt;
    order.paymentAttempts![1].closeConfirmed = false;
    expect(needsPaidAttemptCleanup(order)).toBe(false);
  });
});

describe('independent reporting verification of additional real receipts', () => {
  it('recomputes cross-month extra receipts once without adding another product notification', async () => {
    const { verifyReporting } = await source(), order = paidWithRemaining();
    order.paidAt = '2026-10-31T15:59:00.000Z'; order.paymentAttempts![0].paidAt = order.paidAt;
    const extraAt = '2026-10-31T16:01:00.000Z';
    Object.assign(order.paymentAttempts![1], { status: 'PAID', tradeNo: EXTRA, paidAt: extraAt });
    order.duplicatePayments = [{ attemptId: NEXT, tradeNo: EXTRA, paidAt: extraAt, amount: '9.90' }];
    const projected = { id: ID, mode: 'live', clientId: 'product', productOrderId: order.productOrderId, sku: order.sku,
      subject: order.subject, amount: '9.90', amountCents: 990, status: 'PAID', createdAt: order.createdAt,
      expiresAt: order.expiresAt, paidAt: order.paidAt, tradeNo: TRADE, fulfillmentStatus: 'pending', duplicatePayments: order.duplicatePayments };
    const records = new Map<string, unknown>([[`reporting/v1/orders/live/2026-10/20261019T000000000Z_${ID}.json`, { schema: 1, order: projected }]]);
    for (const scope of ['all', 'clients/product']) {
      const prefix = `reporting/v1/live/summary/${scope}/`;
      records.set(prefix + 'months/2026-10.json', { schema: 1, mode: 'live', month: '2026-10', paidAmountCents: 990, paidCount: 1,
        pendingCount: 0, closedCount: 0, deliveryPendingCount: 1, daily: { '2026-10-31': { paidAmountCents: 990, paidCount: 1 } } });
      records.set(prefix + 'months/2026-11.json', { schema: 1, mode: 'live', month: '2026-11', paidAmountCents: 990, paidCount: 1,
        pendingCount: 0, closedCount: 0, deliveryPendingCount: 0, daily: { '2026-11-01': { paidAmountCents: 990, paidCount: 1 } } });
      records.set(prefix + 'total.json', { schema: 1, mode: 'live', paidAmountCents: 1980, paidCount: 2 });
    }
    const run = () => verifyReporting(records, async (name: string) => records.get(name), new Map([[ID, order]]));
    expect(await run()).toMatchObject({ reportingVerified: true, indexedOrderCount: 1 });
    records.set('reporting/v1/live/summary/all/total.json', { schema: 1, mode: 'live', paidAmountCents: 990, paidCount: 1 });
    await expect(run()).rejects.toThrow('REPORTING_COUNTER_MISMATCH');
  });
});
