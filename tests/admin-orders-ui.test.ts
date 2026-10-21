import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

const source = readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-19T04:00:00.000Z');
const ID = 'pay_' + 'a'.repeat(32);
type Listener = (event: Record<string, unknown>) => unknown;
class Target {
  listeners = new Map<string, Listener[]>();
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]); }
  async emit(name: string, event: Record<string, unknown> = {}) {
    await Promise.all((this.listeners.get(name) || []).map(listener => listener({ preventDefault() {}, ...event })));
    await vi.advanceTimersByTimeAsync(0);
  }
}
class Element extends Target {
  children: Element[] = [];
  hidden = false; disabled = false; checked = false; value = ''; textContent = ''; className = ''; readOnly = false;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  classList = { add: (..._names: string[]) => {}, remove: (..._names: string[]) => {}, toggle: (_name: string, _force?: boolean) => {} };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  reset() {}
  reportValidity() { return true; }
  focus() {}
  select() {}
  scrollIntoView() {}
  click() {}
  remove() {}
}
const order = (changes: Record<string, unknown> = {}) => ({
  id: ID, productOrderId: 'member-123', clientId: 'product', sku: 'pro', subject: '会员一年', amount: '19.90', amountCents: 1990,
  status: 'CLOSED', mode: 'live', createdAt: new Date(NOW - 20 * 60_000).toISOString(),
  expiresAt: new Date(NOW - 10 * 60_000).toISOString(), fulfillmentStatus: 'pending', ...changes,
});
const detail = (changes: Record<string, unknown> = {}) => ({
  order: order(), version: 'a'.repeat(64), actions: { close: false, reopen: true, reconcile: true }, audit: [], ...changes,
});
type BrowserRequest = RequestInit & { credentials?: string };
type Call = { path: string; options: BrowserRequest };
type Reply = { body: unknown; status?: number };
async function page(actionHandler: (call: Call) => Reply | Promise<Reply> = () => ({ body: detail() }), initial = detail()) {
  const ui = Object.fromEntries([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].map(match => {
    const node = new Element(); node.hidden = /\bhidden\b/.test(match[0]);
    if (/\bdata-busy-lock\b/.test(match[0])) node.setAttribute('data-busy-lock', '');
    return [match[1], node];
  }));
  ui.orderActionForm.reset = () => { ui.orderActionReason.value = ''; ui.orderActionAcknowledged.checked = false; };
  const nodes: Element[] = Object.values(ui);
  const descendants = (node: Element): Element[] => [node, ...node.children.flatMap(descendants)];
  const document = {
    title: '', body: new Element(), getElementById: (id: string) => ui[id],
    createElement: () => { const node = new Element(); nodes.push(node); return node; },
    querySelectorAll: (selector: string) => selector === '[data-busy-lock]' ? [...new Set(nodes.flatMap(descendants))].filter(node => node.attributes.has('data-busy-lock')) : [],
  };
  const calls: Call[] = [];
  const fetcher = async (path: string, options: BrowserRequest) => {
    const call = { path, options }; calls.push(call);
    let reply: Reply;
    if (path === '/api/admin/session') reply = { body: { user: { email: 'admin@example.test' }, csrfToken: 'isolated-session-csrf' } };
    else if (path === '/api/admin/clients') reply = { body: { clients: [] } };
    else if (path === '/api/admin/grants') reply = { body: { grants: [] } };
    else if (path.startsWith('/api/admin/reports/orders')) reply = { body: { items: [initial.order], nextCursor: null, coverage: { complete: true, sourceOrders: 1, indexedOrders: 1, missingOrders: 0 } } };
    else if (path === `/api/admin/orders/${ID}`) reply = { body: initial };
    else reply = await actionHandler(call);
    const status = reply.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(reply.body) };
  };
  const location = { hash: '#orders', origin: 'https://pay.example.test' };
  const clipboard = { writeText: vi.fn(async (_value: string) => {}) };
  const storage = { setItem: vi.fn(() => { throw new Error('Order capabilities must not be stored'); }) };
  const exportBlobs: { text(): Promise<string> }[] = [];
  class BrowserURL extends URL {}
  Object.defineProperty(BrowserURL, 'createObjectURL', { value: (blob: { text(): Promise<string> }) => { exportBlobs.push(blob); return 'blob:isolated-export'; } });
  Object.defineProperty(BrowserURL, 'revokeObjectURL', { value: () => {} });
  const window = Object.assign(new Target(), { matchMedia: () => ({ matches: true }), setTimeout, clearTimeout });
  runInNewContext(source, { document, window, location, history: { replaceState() {} }, navigator: { clipboard },
    localStorage: storage, sessionStorage: storage, fetch: fetcher, crypto: { randomUUID }, URL: BrowserURL, Blob, URLSearchParams, AbortController, Date, Intl }, { filename: 'public/admin.js' });
  await vi.advanceTimersByTimeAsync(0);
  expect(ui.ordersRows.children).toHaveLength(1);
  await ui.ordersRows.children[0].children[5].children[0].emit('click');
  return { ui, calls, window, clipboard, storage, exportBlobs };
}
const posts = (calls: Call[]) => calls.filter(call => call.options.method === 'POST');
async function confirm(ui: Record<string, Element>, reason = '用户请求重新付款') {
  ui.orderActionReason.value = reason; ui.orderActionAcknowledged.checked = true;
  await ui.orderActionForm.emit('submit');
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('administrative order action UI', () => {
  it('reads current details and never changes payment state until explicit reason and confirmation', async () => {
    const p = await page();
    expect(p.calls.some(call => call.path === `/api/admin/orders/${ID}` && call.options.method === 'GET')).toBe(true);
    expect(posts(p.calls)).toHaveLength(0);
    await p.ui.reopenPaymentOrderButton.emit('click');
    expect(p.ui.orderActionForm.hidden).toBe(false); expect(posts(p.calls)).toHaveLength(0);
    p.ui.orderActionReason.value = '用户申请'; await p.ui.orderActionForm.emit('submit');
    expect(posts(p.calls)).toHaveLength(0);
    p.ui.orderActionAcknowledged.checked = true; p.ui.orderActionReason.value = '   '; await p.ui.orderActionForm.emit('submit');
    expect(posts(p.calls)).toHaveLength(0);
    await p.ui.cancelOrderActionButton.emit('click');
    expect(posts(p.calls)).toHaveLength(0); expect(p.ui.orderActionForm.hidden).toBe(true);
  });

  it('retains the same confirmed request after an uncertain failure and sends session CSRF on retry', async () => {
    let attempt = 0;
    const p = await page(() => { if (++attempt === 1) throw new TypeError('network lost'); return { body: detail() }; });
    await p.ui.reconcilePaymentOrderButton.emit('click'); await confirm(p.ui, '用户反馈已付款，请核实');
    expect(posts(p.calls)).toHaveLength(1); expect(p.ui.orderActionReason.readOnly).toBe(true);
    expect(p.ui.confirmOrderActionButton.textContent).toBe('重试并核对结果');
    expect(p.ui.reloadOrderDetailsButton.disabled).toBe(true);
    await p.ui.orderActionForm.emit('submit');
    const [first, second] = posts(p.calls);
    expect(first.options.body).toBe(second.options.body);
    expect(JSON.parse(String(first.options.body))).toMatchObject({ expectedVersion: 'a'.repeat(64), reason: '用户反馈已付款，请核实' });
    expect(JSON.parse(String(first.options.body)).requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.options.headers).toMatchObject({ 'X-CSRF-Token': 'isolated-session-csrf' });
    expect(first.options.credentials).toBe('same-origin'); expect(first.options.cache).toBe('no-store');
    expect(p.ui.orderActionForm.hidden).toBe(true);
  });

  it('requires fresh details after a version conflict instead of silently resubmitting', async () => {
    const p = await page(() => ({ status: 409, body: { error: { code: 'ORDER_VERSION_CONFLICT' } } }));
    await p.ui.reopenPaymentOrderButton.emit('click'); await confirm(p.ui);
    expect(p.ui.orderDetailMessage.textContent).toContain('刷新状态');
    expect(p.ui.orderActionForm.hidden).toBe(true); expect(p.ui.orderActionButtons.hidden).toBe(true);
    await p.ui.orderActionForm.emit('submit'); expect(posts(p.calls)).toHaveLength(1);
    await p.ui.reloadOrderDetailsButton.emit('click'); expect(p.ui.reopenPaymentOrderButton.hidden).toBe(false);
  });

  it.each(['ORDER_ACTION_FAILED', 'ORDER_OPERATION_IN_PROGRESS'])('resolves %s through a new state read instead of trapping the administrator in an old request', async code => {
    const p = await page(() => ({ status: 409, body: { error: { code } } }));
    await p.ui.reconcilePaymentOrderButton.emit('click'); await confirm(p.ui, '核对此前操作结果');
    expect(p.ui.orderActionForm.hidden).toBe(true); expect(p.ui.reloadOrderDetailsButton.disabled).toBe(false);
    expect(p.ui.orderDetailMessage.textContent).toContain('刷新状态');
    await p.ui.orderActionForm.emit('submit'); expect(posts(p.calls)).toHaveLength(1);
    await p.ui.reloadOrderDetailsButton.emit('click');
    expect(p.calls.filter(call => call.path === `/api/admin/orders/${ID}`)).toHaveLength(2);
  });

  it('keeps the renewed checkout capability only in the current page, copies its full fragment and clears it on expiry', async () => {
    const checkoutUrl = `https://pay.example.test/checkout/${ID}#token=isolated_new_capability`;
    const renewed = order({ status: 'PENDING', expiresAt: new Date(NOW + 10 * 60_000).toISOString() });
    const p = await page(() => ({ body: detail({ order: renewed, checkoutUrl }) }));
    await p.ui.reopenPaymentOrderButton.emit('click'); await confirm(p.ui);
    expect(p.ui.orderCheckoutPanel.hidden).toBe(false); expect(p.ui.orderCheckoutUrl.value).toBe(checkoutUrl);
    expect(p.ui.orderCheckoutMessage.textContent).toContain('重新发送');
    await p.ui.copyOrderCheckoutButton.emit('click'); expect(p.clipboard.writeText).toHaveBeenCalledWith(checkoutUrl);
    expect(p.storage.setItem).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(p.ui.orderCheckoutUrl.value).toBe(''); expect(p.ui.orderCheckoutPanel.hidden).toBe(true);
    expect(p.ui.orderDetailMessage.textContent).toContain('期限已结束');
  });

  it('clears a copied checkout capability on page exit and displays duplicate payment warnings without another mutation', async () => {
    const current = order({ status: 'PAID', paidAt: new Date(NOW).toISOString(), cleanupPending: true, duplicatePayments: [{ attemptId: 'old', tradeNo: 'extra-payment', amount: '19.90', paidAt: new Date(NOW).toISOString() }] });
    const p = await page(() => ({ body: detail() }), detail({ order: current, actions: { close: false, reopen: false, reconcile: true } }));
    expect(p.ui.orderPaymentWarning.textContent).toContain('额外到账'); expect(p.ui.orderPaymentWarning.textContent).toContain('不会重复开通权益');
    expect(p.ui.orderPaymentWarning.textContent).toContain('其他付款记录待关闭');
    expect(p.ui.orderPaymentWarning.textContent).toContain('extra-payment'); expect(posts(p.calls)).toHaveLength(0);
    p.ui.orderCheckoutUrl.value = 'transient'; p.ui.orderCheckoutPanel.hidden = false;
    await p.window.emit('pagehide'); expect(p.ui.orderCheckoutUrl.value).toBe(''); expect(p.ui.orderCheckoutPanel.hidden).toBe(true);
  });

  it('exports additional confirmed payments separately while preserving the historical order price', async () => {
    const current = order({ status: 'PAID', duplicatePayments: [
      { attemptId: 'old-1', tradeNo: 'extra-1', amount: '19.90', paidAt: new Date(NOW).toISOString() },
      { attemptId: 'old-2', tradeNo: 'extra-2', amount: '19.90', paidAt: new Date(NOW).toISOString() },
    ] });
    const p = await page(() => ({ body: detail() }), detail({ order: current }));
    await p.ui.exportOrdersButton.emit('click');
    expect(p.exportBlobs).toHaveLength(1);
    const csv = await p.exportBlobs[0].text();
    expect(csv).toContain('"金额（元）","额外实付笔数","额外实付金额（元）"');
    expect(csv).toContain('"19.90","2","39.80","已付款"');
    expect(posts(p.calls)).toHaveLength(0);
  });
});
