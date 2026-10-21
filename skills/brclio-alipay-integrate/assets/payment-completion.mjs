/**
 * BROWSER SAFE. This module contains no payment credentials or payment-center calls.
 *
 * Adapt queryOrder(productOrderId, { signal }) to YOUR authenticated product backend.
 * That backend must check the current user's ownership of the business order and return:
 * { productOrderId, mode: 'live', paymentStatus: 'PENDING' | 'PAID' | 'CLOSED',
 *   entitlementStatus: 'pending' | 'active' }
 *
 * `active` means this order's real entitlement transaction has committed. A browser
 * return, PAID, or a delivered payment-center notification alone does not prove that.
 * Never expose an API/webhook secret, scoped integration Bearer, or center credential.
 * Throw an error with status 401/403 when the product session is no longer authorized.
 * Both adapters should respect signal and verify the session before updating local
 * account state. Call dispose() BEFORE logout/account switch or replacing this order.
 * This wait timeout is separate from the center's 10-minute payment deadline.
 * CLOSED ends this wait; keep the old order for late valid paid events/manual checks.
 * A normal repurchase uses a new business order ID. Administrator-only reopening
 * preserves this logical ID; reopen checkout or start() to resume manual waiting.
 */
export function createPaymentCompletionWatcher({
  productOrderId,
  queryOrder,
  refreshAccount,
  onState = () => {},
  intervalMs = 15_000,
  timeoutMs = 300_000,
  requestTimeoutMs = 15_000,
  windowTarget = typeof window === 'undefined' ? null : window,
  documentTarget = typeof document === 'undefined' ? null : document,
}) {
  if (typeof productOrderId !== 'string' || !productOrderId.trim() || productOrderId.length > 128
      || typeof queryOrder !== 'function' || typeof refreshAccount !== 'function' || typeof onState !== 'function'
      || [intervalMs, timeoutMs, requestTimeoutMs].some(value => !Number.isFinite(value) || value <= 0)) {
    throw new TypeError('Invalid payment completion watcher options');
  }

  let active = false;
  let disposed = false;
  let confirmed = false;
  let generation = 0;
  let inFlight = null;
  let controller = null;
  let pollTimer = null;
  let deadlineTimer = null;
  let lastPhase = 'pending';
  let state = null;
  const hidden = () => documentTarget?.hidden === true;

  function publish(status, code) {
    state = Object.freeze({ productOrderId, status, ...(code ? { code } : {}) });
    // A UI rendering error must not restart a successful account refresh or a request.
    try { onState(state); } catch { /* The caller owns errors in its rendering callback. */ }
  }

  function clearPoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function stop(status, code) {
    active = false;
    generation += 1;
    clearPoll();
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
    controller?.abort();
    controller = null;
    inFlight = null;
    windowTarget?.removeEventListener('focus', resume);
    documentTarget?.removeEventListener('visibilitychange', visibilityChanged);
    if (status) publish(status, code);
  }

  function schedule() {
    clearPoll();
    if (active && !hidden()) pollTimer = setTimeout(() => { void check(); }, intervalMs);
  }

  function resume() {
    if (active && !hidden()) void check();
  }

  function visibilityChanged() {
    if (hidden()) clearPoll();
    else resume();
  }

  function validate(order) {
    if (!order || order.productOrderId !== productOrderId) return 'ORDER_MISMATCH';
    if (order.mode !== 'live') return 'ENVIRONMENT_MISMATCH';
    if (!['PENDING', 'PAID', 'CLOSED'].includes(order.paymentStatus)
        || !['pending', 'active'].includes(order.entitlementStatus)
        || (order.paymentStatus !== 'PAID' && order.entitlementStatus === 'active')) return 'INVALID_ORDER_STATUS';
    return null;
  }

  // An adapter that ignores abort cannot block disposal/restart or publish a late result.
  // It should still pass signal to fetch so the network request itself is also cancelled.
  function abortable(action, signal) {
    return new Promise((resolve, reject) => {
      const aborted = () => {
        signal.removeEventListener('abort', aborted);
        const error = new Error('Payment completion request aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) { aborted(); return; }
      signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => {
        if (signal.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
        return action();
      }).then(value => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      }, error => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      });
    });
  }

  /** Check immediately while running. Concurrent focus/manual checks share one request. */
  function check() {
    if (!active || disposed || hidden()) return Promise.resolve(state);
    if (inFlight) return inFlight;
    clearPoll();
    const currentGeneration = generation;
    const currentController = new AbortController();
    controller = currentController;
    const { signal } = currentController;
    let requestTimedOut = false;
    const requestTimer = setTimeout(() => {
      requestTimedOut = true;
      currentController.abort();
    }, requestTimeoutMs);
    const current = () => active && !disposed && generation === currentGeneration;

    inFlight = (async () => {
      try {
        const order = await abortable(() => queryOrder(productOrderId, { signal }), signal);
        if (!current()) return state;
        const invalid = validate(order);
        if (invalid) { stop('error', invalid); return state; }
        if (order.paymentStatus === 'CLOSED') { stop('closed'); return state; }
        lastPhase = order.paymentStatus === 'PAID' ? 'confirming' : 'pending';
        publish(lastPhase);
        if (!current()) return state;
        if (order.paymentStatus === 'PAID' && order.entitlementStatus === 'active') {
          await abortable(() => refreshAccount({ productOrderId, signal }), signal);
          if (!current()) return state;
          confirmed = true;
          stop('confirmed');
        }
      } catch (error) {
        if (!current()) return state;
        if (error?.status === 401 || error?.status === 403) stop('error', 'AUTH_REQUIRED');
        else publish(lastPhase, requestTimedOut ? 'REQUEST_TIMEOUT' : 'RETRYABLE_ERROR');
      } finally {
        clearTimeout(requestTimer);
        if (generation === currentGeneration) {
          controller = null;
          inFlight = null;
          schedule();
        }
      }
      return state;
    })();
    return inFlight;
  }

  /**
   * Start on opening the purchase UI, after creating/restoring an order, or on return.
   * A manual button may call start() again after timeout/auth recovery; check() while
   * running triggers an immediate check. Confirmed watchers do not refresh twice.
   * The five-minute deadline includes hidden time and hanging requests; a timeout
   * means automatic checks stopped, never that payment failed. Keep a manual check.
   */
  function start() {
    if (disposed) throw new Error('Payment completion watcher disposed');
    if (confirmed) return Promise.resolve(state);
    if (active) return check();
    active = true;
    generation += 1;
    publish(lastPhase);
    if (!active || disposed) return Promise.resolve(state);
    windowTarget?.addEventListener('focus', resume);
    documentTarget?.addEventListener('visibilitychange', visibilityChanged);
    deadlineTimer = setTimeout(() => stop('timeout', 'AUTOMATIC_CHECKS_STOPPED'), timeoutMs);
    return check();
  }

  /** Final cleanup for logout/account switch/unmount. Create a new watcher to reuse. */
  function dispose() {
    disposed = true;
    stop();
  }

  // onState statuses: pending, confirming, confirmed, closed, error, timeout.
  // Codes are fixed safe strings; no upstream exception or sensitive response leaks.
  return { start, check, dispose };
}
