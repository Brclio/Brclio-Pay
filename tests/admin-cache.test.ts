import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

const source = readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-21T04:00:00.000Z');
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
  children: Element[] = []; hidden = false; disabled = false; checked = false; required = false; value = ''; textContent = ''; className = ''; readOnly = false;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  classList = { add: (..._names: string[]) => {}, remove: (..._names: string[]) => {}, toggle: (_name: string, _force?: boolean) => {} };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  reset() {} reportValidity() { return true; } focus() {} select() {} scrollIntoView() {} click() {} remove() {}
}
type Call = { path: string; options: RequestInit };
type Reply = { body?: unknown; status?: number };
type RequestOptions = { method?: string; body?: unknown; fresh?: boolean };
type Probe = { request(path: string, options?: RequestOptions): Promise<unknown> };
const billReport = (path: string, changes: Record<string, unknown> = {}) => {
  const query = new URL(path, 'https://pay.example.test').searchParams;
  const provider = query.get('provider') || 'alipay', offset = query.get('cursor') ? 25 : 0;
  const items = Array.from({ length: 27 }, (_, index) => ({
    orderId: `pay_${String(index).padStart(32, '0')}`, attemptId: `attempt-${index}`, provider,
    clientId: query.get('clientId') || 'product', productOrderId: `business-${index}`, sku: 'pro', subject: '会员',
    tradeNo: `trade-${index}`, paidAt: '2026-10-20T04:00:00.000Z', amount: '19.90', amountCents: 1990,
    currency: 'CNY', kind: 'primary', fulfillmentStatus: 'delivered',
  }));
  return { mode: 'live', provider, month: query.get('month') || '2026-10',
    ...(query.get('clientId') ? { clientId: query.get('clientId') } : {}), currency: 'CNY', basis: 'payment-confirmed', timezone: 'Asia/Shanghai',
    paidCount: 27, paidAmountCents: 53730, items: items.slice(offset, offset + 25), nextCursor: offset ? null : 'next-25',
    coverage: { scope: 'ledger', source: 'canonical', complete: true, sourceOrders: 27, scannedOrders: 27, checkedAt: new Date(NOW).toISOString() }, revision: 'a'.repeat(64), ...changes };
};
const guide = () => ({ document: { schema: 1, title: '环境变量说明', updatedAt: new Date(NOW).toISOString(), intro: [], groups: [], notes: [] },
  variables: [], source: { repository: 'BrclioData/BrclioPay-Data', path: 'maintenance/environment/guide.json', url: 'https://github.com/BrclioData/BrclioPay-Data/blob/main/maintenance/environment/guide.json', revision: 'a'.repeat(64) }, storageTypeBasis: 'maintenance-convention' });
async function page(initialPage = 'bills', handler?: (call: Call) => Reply | undefined | Promise<Reply | undefined>) {
  const nodes: Element[] = [], ui: Record<string, Element> = {};
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(); node.hidden = /\bhidden\b/.test(match[0]); node.required = /\brequired\b/.test(match[0]);
    if (/\bdata-busy-lock\b/.test(match[0])) node.setAttribute('data-busy-lock', '');
    const dataPage = match[0].match(/data-admin-page="([^"]+)"/); if (dataPage) node.dataset.adminPage = dataPage[1];
    ui[match[1]] = node; nodes.push(node);
  }
  const links = [...html.matchAll(/<a[^>]*data-page-link="([^"]+)"[^>]*>/g)].map(match => { const node = new Element(); node.dataset.pageLink = match[1]; return node; });
  ui.grantDomainMode.value = 'auto'; ui.grantPricingMode.value = 'detect';
  const descendants = (node: Element): Element[] => [node, ...node.children.flatMap(descendants)];
  const document = { title: '', body: new Element(), getElementById: (id: string) => ui[id],
    createElement: () => { const node = new Element(); nodes.push(node); return node; },
    createElementNS: () => { const node = new Element(); nodes.push(node); return node; },
    querySelectorAll: (selector: string) => selector === '[data-page-link]' ? links : selector === '[data-admin-page]' ? Object.values(ui).filter(node => node.dataset.adminPage)
      : selector === '[data-busy-lock]' ? [...new Set(nodes.flatMap(descendants))].filter(node => node.attributes.has('data-busy-lock')) : [],
  };
  const calls: Call[] = [];
  const fetcher = async (path: string, options: RequestInit) => {
    const call = { path, options }; calls.push(call);
    let reply = await handler?.(call);
    if (!reply && ['/api/admin/session', '/api/admin/login'].includes(path)) reply = { body: { user: { email: 'admin@example.test' }, csrfToken: 'isolated-csrf' } };
    if (!reply && path === '/api/admin/clients') reply = { body: { clients: [] } };
    if (!reply && path === '/api/admin/grants' && options.method === 'GET') reply = { body: { grants: [] } };
    if (!reply && path === '/api/admin/audit') reply = { body: { entries: [] } };
    if (!reply && path.startsWith('/api/admin/reports/bills')) reply = { body: billReport(path) };
    if (!reply && path === '/api/admin/environment') reply = { body: guide() };
    const status = reply?.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(reply?.body || {}) };
  };
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
  const exportBlobs: { text(): Promise<string> }[] = [];
  class BrowserURL extends URL {}
  Object.defineProperty(BrowserURL, 'createObjectURL', { value: (blob: { text(): Promise<string> }) => { exportBlobs.push(blob); return 'blob:isolated-export'; } });
  Object.defineProperty(BrowserURL, 'revokeObjectURL', { value: () => {} });
  const window = Object.assign(new Target(), { matchMedia: () => ({ matches: true }), setTimeout, clearTimeout, localStorage: storage, sessionStorage: storage, cacheProbe: null as Probe | null });
  // Only this VM receives a probe. The deployed script exposes no administrator internals.
  const instrumented = source.replace(/\}\)\(\);\s*$/, 'window.cacheProbe = { request };})();');
  runInNewContext(instrumented, { document, window, location: { hash: `#${initialPage}`, origin: 'https://pay.example.test' }, history: { replaceState() {} },
    navigator: { clipboard: { writeText: vi.fn(async () => {}) } }, fetch: fetcher, crypto: { randomUUID }, URL: BrowserURL, Blob, URLSearchParams, AbortController,
    Date, Intl, TextEncoder, structuredClone, localStorage: storage, sessionStorage: storage }, { filename: 'public/admin.js' });
  await vi.advanceTimersByTimeAsync(0);
  return { ui, calls, window, storage, exportBlobs, probe: window.cacheProbe!,
    navigate: async (name: string) => { await links.find(link => link.dataset.pageLink === name)!.emit('click'); } };
}
const matching = (calls: Call[], prefix: string) => calls.filter(call => call.path.startsWith(`/api/admin${prefix}`));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('administrator page memory cache', () => {
  it('reuses bill pages and payment channel queries, including already loaded CSV pages', async () => {
    const p = await page();
    expect(matching(p.calls, '/reports/bills')).toHaveLength(1);
    await p.ui.nextBillsButton.emit('click'); expect(p.ui.billsRows.children).toHaveLength(2);
    await p.ui.previousBillsButton.emit('click'); expect(p.ui.billsRows.children).toHaveLength(25);
    expect(matching(p.calls, '/reports/bills')).toHaveLength(2);
    await p.ui.billsWechatButton.emit('click'); await p.ui.billsAlipayButton.emit('click');
    expect(matching(p.calls, '/reports/bills')).toHaveLength(3);
    await p.ui.exportBillsButton.emit('click'); expect(p.exportBlobs).toHaveLength(1);
    expect(matching(p.calls, '/reports/bills')).toHaveLength(3);
    expect(await p.exportBlobs[0].text()).toContain('business-26');
  });

  it('refreshes the visible page after checking the session and discards old paginated results', async () => {
    let changed = false;
    const p = await page('bills', call => call.path.includes('/reports/bills') ? { body: billReport(call.path, changed ? { revision: 'b'.repeat(64) } : {}) } : undefined);
    await p.ui.nextBillsButton.emit('click');
    const start = p.calls.length; changed = true; await p.ui.refreshDataButton.emit('click');
    expect(p.calls.slice(start).map(call => call.path)).toEqual(expect.arrayContaining(['/api/admin/session', '/api/admin/clients']));
    expect(p.calls[start].path).toBe('/api/admin/session'); expect(p.ui.billsPageLabel.textContent).toContain('第 1 页');
    expect(matching(p.calls.slice(start), '/reports/bills')).toHaveLength(1);
    await p.ui.nextBillsButton.emit('click'); expect(matching(p.calls.slice(start), '/reports/bills')).toHaveLength(2);
    expect(p.ui.billsRows.children).toHaveLength(2);
    expect(matching(p.calls.slice(start), '/grants')).toHaveLength(0); expect(matching(p.calls.slice(start), '/audit')).toHaveLength(0);
  });

  it.each(['next-page-409', 'next-page-revision', 'export-409'])('recovers from %s by dropping old cursors and refreshing before exporting', async failure => {
    let refreshed = false;
    const p = await page('bills', call => {
      if (!call.path.includes('/reports/bills')) return undefined;
      const query = new URL(call.path, 'https://pay.example.test').searchParams;
      if (!refreshed && query.has('cursor')) {
        return failure === 'next-page-revision'
          ? { body: billReport(call.path, { revision: 'b'.repeat(64) }) }
          : { status: 409, body: { error: { code: 'REPORTING_SNAPSHOT_CHANGED', message: '账本已变化' } } };
      }
      const result = billReport(call.path, refreshed ? { revision: 'b'.repeat(64), nextCursor: query.has('cursor') ? null : 'new-snapshot-cursor' } : {});
      if (refreshed) result.items = result.items.map(item => ({ ...item, subject: '刷新后账单' }));
      return { body: result };
    });
    expect(p.ui.nextBillsButton.disabled).toBe(false); expect(p.ui.exportBillsButton.disabled).toBe(false);
    await p.ui[failure === 'export-409' ? 'exportBillsButton' : 'nextBillsButton'].emit('click');
    expect(p.ui.nextBillsButton.disabled).toBe(true); expect(p.ui.exportBillsButton.disabled).toBe(true);
    expect(p.ui.billsRows.children).toHaveLength(0); expect(p.exportBlobs).toHaveLength(0);
    expect(p.ui.billsMessage.textContent).toContain('刷新数据');
    const start = p.calls.length; refreshed = true; await p.ui.refreshDataButton.emit('click');
    expect(p.ui.billsPageLabel.textContent).toContain('第 1 页'); expect(p.ui.exportBillsButton.disabled).toBe(false);
    await p.ui.exportBillsButton.emit('click'); expect(p.exportBlobs).toHaveLength(1);
    const newQueries = matching(p.calls.slice(start), '/reports/bills').map(call => new URL(call.path, 'https://pay.example.test').searchParams.get('cursor'));
    expect(newQueries).toEqual([null, 'new-snapshot-cursor']);
    expect(await p.exportBlobs[0].text()).toContain('刷新后账单'); expect(p.ui.billsMessage.textContent).toContain('共 27 笔');
  });

  it('loads only data required by a page, retains it on navigation and only revalidates the session on focus', async () => {
    const p = await page('environment');
    expect(p.calls.map(call => call.path)).toEqual(['/api/admin/session', '/api/admin/environment']);
    await p.navigate('platforms');
    expect(matching(p.calls, '/clients')).toHaveLength(1); expect(matching(p.calls, '/grants')).toHaveLength(1); expect(matching(p.calls, '/audit')).toHaveLength(1);
    await p.navigate('environment'); await p.navigate('platforms');
    expect(matching(p.calls, '/environment')).toHaveLength(1); expect(matching(p.calls, '/clients')).toHaveLength(1); expect(matching(p.calls, '/audit')).toHaveLength(1);
    const start = p.calls.length; await p.window.emit('focus');
    expect(p.calls.slice(start).map(call => call.path)).toEqual(['/api/admin/session']);
  });

  it('does not cache failed reads and explicit refresh buttons bypass successful cached data', async () => {
    let reads = 0;
    const p = await page('environment', call => call.path === '/api/admin/environment' && ++reads === 1
      ? { status: 503, body: { error: { code: 'TEMPORARY', message: '请稍后重试' } } } : undefined);
    expect(p.ui.environmentMessage.textContent).toContain('请稍后重试');
    await p.navigate('platforms'); await p.navigate('environment'); expect(reads).toBe(2);
    await p.ui.reloadEnvironmentButton.emit('click'); expect(reads).toBe(3);
  });

  it.each(['environment', 'bills'])('discards a successful HTTP response with an invalid %s schema before retry', async kind => {
    let reads = 0;
    const p = await page(kind, call => {
      if (kind === 'environment' && call.path === '/api/admin/environment' && ++reads === 1) {
        return { body: { ...guide(), document: { ...guide().document, groups: 'invalid' } } };
      }
      if (kind === 'bills' && call.path.includes('/reports/bills') && ++reads === 1) {
        return { body: billReport(call.path, { currency: 'invalid' }) };
      }
      return undefined;
    });
    expect(reads).toBe(1);
    expect(p.ui[kind === 'environment' ? 'environmentMessage' : 'billsMessage'].textContent).toMatch(/暂时无法读取|数据不完整/);
    await p.navigate(kind); expect(reads).toBe(2);
    if (kind === 'environment') expect(p.ui.environmentSource.textContent).toContain('maintenance/environment/guide.json');
    else expect(p.ui.billsRows.children).toHaveLength(25);
  });

  it('discards invalid daily summary entries so querying again recovers through a new read', async () => {
    let reads = 0;
    const p = await page('overview', call => {
      if (!call.path.includes('/reports/summary')) return undefined;
      return { body: { mode: 'live', paidAmountCents: 0, paidCount: 0, pendingCount: 0, closedCount: 0, deliveryPendingCount: 0,
        allTime: { paidAmountCents: 0, paidCount: 0 }, daily: ++reads === 1 ? [null] : [],
        coverage: { complete: true, sourceOrders: 0, indexedOrders: 0, missingOrders: 0 } } };
    });
    expect(reads).toBe(1); expect(p.ui.summaryMessage.textContent).toContain('每日统计暂时无法读取');
    expect(p.ui.revenueChart.children).toHaveLength(0);
    await p.ui.summaryFilters.emit('submit');
    expect(reads).toBe(2); expect(p.ui.summaryMessage.textContent).toBe(''); expect(p.ui.revenueChart.children).toHaveLength(1);
    await p.ui.summaryFilters.emit('submit'); expect(reads).toBe(2);
  });

  it('merges simultaneous read requests without reusing non-cacheable credentials, sessions or order details', async () => {
    let release!: (reply: Reply) => void;
    const p = await page('environment', call => call.path === '/api/admin/audit' ? new Promise<Reply>(resolve => { release = resolve; }) : undefined);
    const first = p.probe.request('/audit'), second = p.probe.request('/audit');
    await vi.advanceTimersByTimeAsync(0); expect(matching(p.calls, '/audit')).toHaveLength(1);
    release({ body: { entries: [] } }); expect(await first).toEqual({ entries: [] }); expect(await second).toEqual({ entries: [] });
    await p.probe.request('/audit'); expect(matching(p.calls, '/audit')).toHaveLength(1);
    for (const path of ['/session', '/orders/pay_fixture', '/skill?variant=brclio-pay-integrate']) {
      const before = matching(p.calls, path).length;
      await p.probe.request(path); await p.probe.request(path);
      expect(matching(p.calls, path)).toHaveLength(before + 2);
    }
  });

  it('invalidates cached results before a write even when the write fails', async () => {
    const p = await page('environment', call => call.options.method === 'POST' ? { status: 409, body: { error: { code: 'CONFLICT', message: '版本已变化' } } } : undefined);
    await p.probe.request('/audit');
    await expect(p.probe.request('/grants/revoke', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 409 });
    await p.probe.request('/audit'); expect(matching(p.calls, '/audit')).toHaveLength(2);
    await p.navigate('environment'); expect(matching(p.calls, '/environment')).toHaveLength(2);
  });

  it('does not let a pre-write in-flight read repopulate the invalidated cache', async () => {
    let release!: (reply: Reply) => void, reads = 0;
    const p = await page('environment', call => call.path === '/api/admin/audit' && ++reads === 1 ? new Promise<Reply>(resolve => { release = resolve; }) : undefined);
    const old = p.probe.request('/audit'); await vi.advanceTimersByTimeAsync(0);
    await p.probe.request('/clients', { method: 'POST', body: {} });
    release({ body: { entries: [{ previous: true }] } }); await expect(old).rejects.toThrow('页面状态已变化');
    await p.probe.request('/audit'); expect(matching(p.calls, '/audit')).toHaveLength(2);
  });

  it('clears data on logout and pagehide, and never writes it to browser storage', async () => {
    const p = await page('environment'); await p.probe.request('/audit');
    await p.window.emit('pagehide'); await p.probe.request('/audit'); expect(matching(p.calls, '/audit')).toHaveLength(2);
    await p.ui.logoutButton.emit('click'); expect(p.ui.dashboardView.hidden).toBe(true);
    p.ui.loginEmail.value = 'admin@example.test'; p.ui.loginPassword.value = 'fixture-password'; await p.ui.loginForm.emit('submit');
    expect(matching(p.calls, '/environment')).toHaveLength(2);
    expect(p.storage.getItem).not.toHaveBeenCalled(); expect(p.storage.setItem).not.toHaveBeenCalled();
    expect(p.storage.removeItem).not.toHaveBeenCalled(); expect(p.storage.clear).not.toHaveBeenCalled();
  });

  it('rejects an expired session before using cached data during manual refresh', async () => {
    let expired = false;
    const p = await page('environment', call => expired && call.path === '/api/admin/session' ? { status: 401, body: { error: { code: 'UNAUTHORIZED' } } } : undefined);
    const start = p.calls.length; expired = true; await p.ui.refreshDataButton.emit('click');
    expect(p.calls.slice(start).map(call => call.path)).toEqual(['/api/admin/session']); expect(p.ui.dashboardView.hidden).toBe(true);
    expect(p.ui.environmentGroups.children).toHaveLength(0);
  });

  it('revalidates an aged session before showing a previously loaded page and clears visible data on 401', async () => {
    let expired = false;
    const p = await page('environment', call => expired && call.path === '/api/admin/session' ? { status: 401, body: { error: { code: 'UNAUTHORIZED' } } } : undefined);
    expect(p.ui.environmentSource.textContent).toContain('guide.json');
    await vi.advanceTimersByTimeAsync(60_001); const start = p.calls.length; expired = true;
    await p.navigate('environment');
    expect(p.calls.slice(start).map(call => call.path)).toEqual(['/api/admin/session']);
    expect(p.ui.dashboardView.hidden).toBe(true); expect(p.ui.environmentSource.textContent).toBe('');
  });

  it('clears cached administrator data when session identity changes in another tab', async () => {
    let changed = false;
    const p = await page('environment', call => changed && call.path === '/api/admin/session'
      ? { body: { user: { email: 'different@example.test' }, csrfToken: 'different-session' } } : undefined);
    const start = p.calls.length; changed = true; await p.window.emit('focus');
    expect(p.calls.slice(start).map(call => call.path)).toEqual(['/api/admin/session']);
    expect(p.ui.dashboardView.hidden).toBe(true); expect(p.ui.environmentSource.textContent).toBe('');
  });

  it('bounds cache entries and bytes while keeping a frequently read result available', async () => {
    const p = await page('environment');
    const path = (index: number) => `/reports/bills?provider=alipay&month=2026-10&clientId=fixture-${index}`;
    await p.probe.request(path(0));
    for (let index = 1; index < 115; index++) { await p.probe.request(path(index)); if (index % 10 === 0) await p.probe.request(path(0)); }
    let start = p.calls.length; await p.probe.request(path(0)); expect(p.calls).toHaveLength(start);
    await p.probe.request(path(1)); expect(p.calls).toHaveLength(start + 1);
    const oversize = `/reports/bills?provider=alipay&month=2026-10&clientId=oversize`;
    // A single response larger than the total byte budget must not displace the cache.
    // The fetch stub is replaced through the normal handler in a separate page.
    const large = await page('environment', call => call.path.endsWith('clientId=oversize') ? { body: { content: 'x'.repeat(4 * 1024 * 1024 + 1) } } : undefined);
    await large.probe.request(oversize); await large.probe.request(oversize); expect(matching(large.calls, '/reports/bills')).toHaveLength(2);
    start = p.calls.length; await p.probe.request(path(0)); expect(p.calls).toHaveLength(start);
  });

  it('evicts older responses when their combined size reaches the memory budget', async () => {
    const p = await page('environment', call => call.path.includes('clientId=budget-') ? { body: { content: 'x'.repeat(400_000) } } : undefined);
    const path = (index: number) => `/reports/bills?provider=alipay&month=2026-10&clientId=budget-${index}`;
    for (let index = 0; index < 6; index++) await p.probe.request(path(index));
    const start = p.calls.length; await p.probe.request(path(5)); expect(p.calls).toHaveLength(start);
    await p.probe.request(path(0)); expect(p.calls).toHaveLength(start + 1);
  });
});
