import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createPaymentCompletionWatcher } = await import(new URL('../examples/payment-completion.mjs', import.meta.url).href);
const businessId = 'business-order-123';
const order = (paymentStatus = 'PENDING', entitlementStatus = 'pending') => ({
  productOrderId: businessId, mode: 'live', paymentStatus, entitlementStatus,
});
const deferred = <T = unknown>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class DocumentTarget extends EventTarget { hidden = false; }
const watchers: Array<{ dispose: () => void }> = [];
function fixture(overrides: Record<string, unknown> = {}) {
  const windowTarget = new EventTarget();
  const documentTarget = new DocumentTarget();
  const queryOrder = vi.fn(async () => order());
  const refreshAccount = vi.fn(async () => {});
  const onState = vi.fn();
  const options = { productOrderId: businessId, queryOrder, refreshAccount, onState,
    windowTarget, documentTarget, ...overrides };
  const watcher = createPaymentCompletionWatcher(options);
  watchers.push(watcher);
  return { watcher, queryOrder: options.queryOrder, refreshAccount: options.refreshAccount,
    onState: options.onState, windowTarget, documentTarget };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.dispose();
  vi.useRealTimers();
});

describe('browser-safe payment completion watcher', () => {
  it('keeps PAID pending in progress and confirms only after actual entitlement and account refresh', async () => {
    const accountRefresh = deferred();
    const f = fixture({ refreshAccount: vi.fn(() => accountRefresh.promise) });
    f.queryOrder.mockResolvedValueOnce(order()).mockResolvedValueOnce(order('PAID')).mockResolvedValueOnce(order('PAID', 'active'));
    await f.watcher.start();
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'pending' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'confirming' });
    expect(f.refreshAccount).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'confirming' });
    accountRefresh.resolve(undefined);
    await f.watcher.check();
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'confirmed' });
    await vi.advanceTimersByTimeAsync(60_000);
    await f.watcher.start();
    expect(f.queryOrder).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('immediately checks focus/visibility, pauses hidden polling, and coalesces concurrent checks', async () => {
    const f = fixture();
    await f.watcher.start();
    const request = deferred();
    f.queryOrder.mockImplementationOnce(() => request.promise as Promise<ReturnType<typeof order>>);
    f.windowTarget.dispatchEvent(new Event('focus'));
    const sameCheck = f.watcher.check();
    expect(f.watcher.check()).toBe(sameCheck);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.queryOrder).toHaveBeenCalledTimes(2);
    request.resolve(order('PAID'));
    await sameCheck;
    f.documentTarget.hidden = true;
    f.documentTarget.dispatchEvent(new Event('visibilitychange'));
    f.windowTarget.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.queryOrder).toHaveBeenCalledTimes(2);
    f.documentTarget.hidden = false;
    f.documentTarget.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.queryOrder).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ ...order('PAID', 'active'), productOrderId: 'another-user-order' }, 'ORDER_MISMATCH'],
    [{ ...order('PAID', 'active'), mode: 'sandbox' }, 'ENVIRONMENT_MISMATCH'],
    [order('PENDING', 'active'), 'INVALID_ORDER_STATUS'],
    [order('PAID', 'delivered'), 'INVALID_ORDER_STATUS'],
    [null, 'ORDER_MISMATCH'],
  ])('rejects untrusted completion response without refreshing an account: %j', async (response, code) => {
    const f = fixture({ queryOrder: vi.fn(async () => response) });
    await f.watcher.start();
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'error', code });
    expect(f.refreshAccount).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403])('stops authorization failure %s and can manually restart after session recovery', async status => {
    const f = fixture();
    f.queryOrder.mockRejectedValueOnce(Object.assign(new Error('Do not expose token or upstream text'), { status }));
    await f.watcher.start();
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'error', code: 'AUTH_REQUIRED' });
    expect(vi.getTimerCount()).toBe(0);
    await f.watcher.start();
    expect(f.queryOrder).toHaveBeenCalledTimes(2);
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'pending' });
  });

  it('retries transient network failure without exposing its raw error', async () => {
    const f = fixture();
    f.queryOrder.mockRejectedValueOnce(new Error('private upstream response'));
    await f.watcher.start();
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'pending', code: 'RETRYABLE_ERROR' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.queryOrder).toHaveBeenCalledTimes(2);
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'pending' });
  });

  it('times out a hung request, aborts it, and ignores a late paid response', async () => {
    const hung = deferred();
    const queryOrder = vi.fn((_id: string, _options: { signal: AbortSignal }) => hung.promise);
    const f = fixture({ queryOrder });
    const first = f.watcher.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    expect(queryOrder.mock.calls[0][1].signal.aborted).toBe(true);
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'pending', code: 'REQUEST_TIMEOUT' });
    hung.resolve(order('PAID', 'active'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.refreshAccount).not.toHaveBeenCalled();
  });

  it('stops at the total deadline while hidden and allows a manual fresh window', async () => {
    const f = fixture();
    f.documentTarget.hidden = true;
    await f.watcher.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.queryOrder).not.toHaveBeenCalled();
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'timeout', code: 'AUTOMATIC_CHECKS_STOPPED' });
    expect(vi.getTimerCount()).toBe(0);
    f.documentTarget.hidden = false;
    f.documentTarget.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.queryOrder).not.toHaveBeenCalled();
    await f.watcher.start();
    expect(f.queryOrder).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight request at the total deadline before its own timeout', async () => {
    const f = fixture({ timeoutMs: 5_000, queryOrder: vi.fn(() => new Promise(() => {})) });
    const first = f.watcher.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'timeout', code: 'AUTOMATIC_CHECKS_STOPPED' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a closed order and removes focus listeners', async () => {
    const f = fixture();
    f.queryOrder.mockResolvedValueOnce(order('CLOSED'));
    await f.watcher.start();
    f.windowTarget.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.queryOrder).toHaveBeenCalledTimes(1);
    expect(f.onState).toHaveBeenLastCalledWith({ productOrderId: businessId, status: 'closed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes before logout/account switch and ignores late responses permanently', async () => {
    const late = deferred();
    const queryOrder = vi.fn((_id: string, _options: { signal: AbortSignal }) => late.promise);
    const f = fixture({ queryOrder });
    const first = f.watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    const published = f.onState.mock.calls.length;
    f.watcher.dispose();
    expect(queryOrder.mock.calls[0][1].signal.aborted).toBe(true);
    late.resolve(order('PAID', 'active'));
    await first;
    f.windowTarget.dispatchEvent(new Event('focus'));
    f.documentTarget.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.refreshAccount).not.toHaveBeenCalled();
    expect(f.onState).toHaveBeenCalledTimes(published);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => f.watcher.start()).toThrow('disposed');
  });

  it('ignores a late account refresh completion after disposal', async () => {
    const refresh = deferred();
    const refreshAccount = vi.fn((_options: { signal: AbortSignal }) => refresh.promise);
    const f = fixture({ queryOrder: vi.fn(async () => order('PAID', 'active')), refreshAccount });
    const first = f.watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshAccount).toHaveBeenCalledTimes(1);
    f.watcher.dispose();
    expect(refreshAccount.mock.calls[0][0].signal.aborted).toBe(true);
    refresh.resolve(undefined);
    await first;
    expect(f.onState.mock.calls.some(([state]) => state.status === 'confirmed')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not refresh the account when rendering the confirming state disposes the watcher', async () => {
    let dispose = () => {};
    const f = fixture({ queryOrder: vi.fn(async () => order('PAID', 'active')),
      onState: (state: { status: string }) => { if (state.status === 'confirming') dispose(); } });
    dispose = f.watcher.dispose;
    await f.watcher.start();
    expect(f.refreshAccount).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
