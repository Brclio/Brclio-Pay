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
const textOf = (node: Element): string => [node.textContent, ...node.children.map(textOf)].join(' ');
type Call = { path: string; options: RequestInit };
type Reply = { body: unknown; status?: number };
const bill = (index: number, provider = 'alipay') => ({
  orderId: `pay_${String(index).padStart(32, '0')}`, attemptId: `attempt-${index}`, provider,
  clientId: 'product', productOrderId: `business-${index}`, sku: 'pro', subject: index === 0 ? '=SUM(1,1)' : '年度会员',
  tradeNo: `trade-${index}`, paidAt: '2026-10-20T04:00:00.000Z', amount: '19.90', amountCents: 1990,
  currency: 'CNY', kind: index === 1 ? 'duplicate' : 'primary', fulfillmentStatus: index === 0 ? 'pending' : 'delivered',
});
const guideVariable = (name: string) => ({ name, label: `${name}用途`, description: '仅在服务器端使用', required: true,
  sensitive: true, example: '<your-value>', location: 'Cloudflare Workers 设置', changeNotes: '保存后生效，后续部署保留控制台配置', maintenance: '需要轮换时更新原变量' });
const environment = () => ({ document: { schema: 1, title: '环境变量维护说明', updatedAt: '2026-10-21T04:00:00.000Z',
  intro: ['变量在 Cloudflare Text 中维护。'], groups: [
    { id: 'payment', title: '支付参数', description: '支付运行配置', variables: [guideVariable('CHECKOUT_SECRET')] },
    { id: 'bindings', title: '资源绑定', description: '绑定无需改为 Text', variables: [guideVariable('ASSETS')] },
  ], notes: ['说明保存在私有数据仓库。'] },
  variables: [{ name: 'CHECKOUT_SECRET', configured: true, storageType: 'Text', value: 'never-render-real-value' }, { name: 'ASSETS', configured: true, storageType: 'binding' }],
  source: { repository: 'BrclioData/BrclioPay-Data', path: 'maintenance/environment/guide.json', url: 'https://github.com/BrclioData/BrclioPay-Data/blob/main/maintenance/environment/guide.json', revision: 'a'.repeat(64) }, storageTypeBasis: 'maintenance-convention',
});
const report = (items = Array.from({ length: 27 }, (_, index) => bill(index)), query = new URLSearchParams()) => {
  const provider = query.get('provider') || 'alipay';
  const offset = query.get('cursor') ? 25 : 0;
  return { mode: 'live', provider, month: query.get('month') || '2026-10', currency: 'CNY', basis: 'payment-confirmed', timezone: 'Asia/Shanghai',
    ...(query.get('clientId') ? { clientId: query.get('clientId') } : {}),
    paidCount: items.length, paidAmountCents: items.length * 1990, items: items.slice(offset, offset + 25), nextCursor: items.length > offset + 25 ? 'next-25' : null,
    coverage: { scope: 'ledger', source: 'canonical', complete: true, sourceOrders: 27, scannedOrders: 27, checkedAt: '2026-10-21T04:00:00.000Z' }, revision: 'a'.repeat(64) };
};
async function page(initialPage = 'bills', handler?: (call: Call) => Reply | Promise<Reply>) {
  const nodes: Element[] = [];
  const ui: Record<string, Element> = {};
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(); node.hidden = /\bhidden\b/.test(match[0]); node.required = /\brequired\b/.test(match[0]);
    if (/\bdata-busy-lock\b/.test(match[0])) node.setAttribute('data-busy-lock', '');
    const dataPage = match[0].match(/data-admin-page="([^"]+)"/); if (dataPage) node.dataset.adminPage = dataPage[1];
    ui[match[1]] = node; nodes.push(node);
  }
  const links = [...html.matchAll(/<a[^>]*data-page-link="([^"]+)"[^>]*>/g)].map(match => { const node = new Element(); node.dataset.pageLink = match[1]; nodes.push(node); return node; });
  ui.grantDomainMode.value = 'auto'; ui.grantPricingMode.value = 'detect';
  const allNodes = (node: Element): Element[] => [node, ...node.children.flatMap(allNodes)];
  const document = { title: '', body: new Element(), getElementById: (id: string) => ui[id],
    createElement: () => { const node = new Element(); nodes.push(node); return node; },
    querySelectorAll: (selector: string) => selector === '[data-page-link]' ? links : selector === '[data-admin-page]' ? Object.values(ui).filter(node => node.dataset.adminPage)
      : selector === '[data-busy-lock]' ? [...new Set(nodes.flatMap(allNodes))].filter(node => node.attributes.has('data-busy-lock')) : [],
  };
  const calls: Call[] = [];
  const fetcher = async (path: string, options: RequestInit) => {
    const call = { path, options }; calls.push(call);
    let reply: Reply | undefined;
    if (path === '/api/admin/session') reply = { body: { user: { email: 'admin@example.test' }, csrfToken: 'isolated-csrf' } };
    else if (path === '/api/admin/clients') reply = { body: { clients: [] } };
    else if (path === '/api/admin/grants' && options.method === 'GET') reply = { body: { grants: [] } };
    else reply = await handler?.(call);
    if (!reply && path.startsWith('/api/admin/reports/bills')) {
      const query = new URL(path, 'https://pay.example.test').searchParams;
      reply = { body: report(Array.from({ length: 27 }, (_, index) => ({ ...bill(index, query.get('provider') || 'alipay'), clientId: query.get('clientId') || 'product' })), query) };
    }
    if (!reply && path === '/api/admin/environment') reply = { body: environment() };
    if (!reply && path === '/api/admin/grants' && options.method === 'POST') reply = { body: { prompt: 'Scoped AI integration task', expiresAt: '2026-10-21T05:00:00.000Z', grantId: 'grant-isolated' } };
    const status = reply?.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(reply?.body || {}) };
  };
  const exportBlobs: { text(): Promise<string> }[] = [];
  class BrowserURL extends URL {}
  Object.defineProperty(BrowserURL, 'createObjectURL', { value: (blob: { text(): Promise<string> }) => { exportBlobs.push(blob); return 'blob:isolated-export'; } });
  Object.defineProperty(BrowserURL, 'revokeObjectURL', { value: () => {} });
  const window = Object.assign(new Target(), { matchMedia: () => ({ matches: true }), setTimeout, clearTimeout });
  const clipboard = { writeText: vi.fn(async (_value: string) => {}) };
  runInNewContext(source, { document, window, location: { hash: `#${initialPage}`, origin: 'https://pay.example.test' }, history: { replaceState() {} },
    navigator: { clipboard }, fetch: fetcher, crypto: { randomUUID }, URL: BrowserURL, Blob, URLSearchParams, AbortController, Date, Intl }, { filename: 'public/admin.js' });
  await vi.advanceTimersByTimeAsync(0);
  return { ui, calls, window, exportBlobs, links, clipboard };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('administrative payment bills', () => {
  it('retains navigation, separates payment channels and reports complete monthly totals across server pages', async () => {
    const p = await page();
    expect(p.links.map(link => link.dataset.pageLink)).toEqual(['overview', 'orders', 'bills', 'products', 'ai', 'platforms', 'environment']);
    expect(p.ui.billsPage.hidden).toBe(false); expect(p.ui.environmentPage.hidden).toBe(true);
    expect(p.ui.billsRows.children).toHaveLength(25); expect(p.ui.billsCount.textContent).toBe('27'); expect(p.ui.billsAmount.textContent).toBe('¥537.30');
    expect(textOf(p.ui.billsRows)).toContain('额外到账'); expect(textOf(p.ui.billsRows)).toContain('通知待送达');
    await p.ui.nextBillsButton.emit('click'); expect(p.ui.billsRows.children).toHaveLength(2); expect(p.ui.billsPageLabel.textContent).toContain('第 2 页');
    expect(p.calls.at(-1)?.path).toContain('cursor=next-25');
    await p.ui.previousBillsButton.emit('click'); expect(p.ui.billsRows.children).toHaveLength(25);
    await p.ui.billsWechatButton.emit('click');
    expect(p.calls.at(-1)?.path).toContain('provider=wechat'); expect(p.ui.billsWechatButton.attributes.get('aria-pressed')).toBe('true');
    expect(p.ui.billsAmountLabel.textContent).toContain('微信支付');
    p.ui.billsMonth.value = '2026-09'; p.ui.billsClient.value = 'another-product'; await p.ui.billsFilters.emit('change');
    expect(p.ui.billsRows.children).toHaveLength(0); expect(p.ui.exportBillsButton.disabled).toBe(true);
    await p.ui.billsFilters.emit('submit'); expect(p.calls.at(-1)?.path).toContain('month=2026-09'); expect(p.calls.at(-1)?.path).toContain('clientId=another-product');
  });

  it('exports all monthly server pages, includes extra receipts, and escapes spreadsheet formulas', async () => {
    const p = await page(); await p.ui.exportBillsButton.emit('click');
    expect(p.exportBlobs).toHaveLength(1);
    const csv = await p.exportBlobs[0].text();
    expect(csv.split('\r\n')).toHaveLength(28); expect(csv).toContain('"business-26"'); expect(csv).toContain('"额外到账"'); expect(csv).toContain('"\'=SUM(1,1)"');
    expect(p.ui.billsMessage.textContent).toContain('共 27 笔'); expect(p.calls.filter(call => call.path.includes('cursor=next-25'))).toHaveLength(1);
    expect(p.calls.every(call => call.options.method === 'GET')).toBe(true);
  });

  it.each(['revision', 'cursor', 'count', 'amount'])('does not silently export incomplete or inconsistent %s results', async failure => {
    let billReads = 0;
    const p = await page('bills', call => {
      if (!call.path.includes('/reports/bills')) return { body: {} };
      const query = new URL(call.path, 'https://pay.example.test').searchParams;
      const result = report(undefined, query); billReads++;
      if (billReads > 1) {
        if (failure === 'revision') result.revision = 'b'.repeat(64);
        if (failure === 'cursor') result.nextCursor = 'next-25';
        if (failure === 'count') result.items.pop();
        if (failure === 'amount') result.items[0] = { ...result.items[0], amount: '19.91', amountCents: 1991 };
      }
      return { body: result };
    });
    await p.ui.exportBillsButton.emit('click'); expect(p.exportBlobs).toHaveLength(0); expect(p.ui.billsMessage.hidden).toBe(false);
    expect(p.ui.billsMessage.textContent).toMatch(/变更|重复|不一致/);
  });
});

describe('repository-backed environment maintenance guide', () => {
  it('loads source and status, supports category/search and ignores unexpected runtime values', async () => {
    const p = await page('environment');
    expect(p.ui.environmentPage.hidden).toBe(false); expect(p.ui.environmentGroups.children).toHaveLength(2);
    expect(p.ui.environmentSource.textContent).toContain('maintenance/environment/guide.json');
    expect(p.ui.environmentSource.children).toHaveLength(1);
    const displayed = textOf(p.ui.environmentGroups);
    expect(displayed).toContain('Cloudflare Text（明文）'); expect(displayed).toContain('Cloudflare 资源绑定'); expect(displayed).toContain('已配置');
    expect(displayed).toContain('保存后生效'); expect(displayed).toContain('需要轮换时'); expect(displayed).not.toContain('never-render-real-value');
    p.ui.environmentGroup.value = 'bindings'; await p.ui.environmentGroup.emit('change'); expect(p.ui.environmentGroups.children).toHaveLength(1); expect(textOf(p.ui.environmentGroups)).toContain('ASSETS');
    p.ui.environmentGroup.value = ''; p.ui.environmentSearch.value = 'checkout_secret'; await p.ui.environmentSearch.emit('input');
    expect(p.ui.environmentGroups.children).toHaveLength(1); expect(textOf(p.ui.environmentGroups)).not.toContain('ASSETS');
    p.ui.environmentSearch.value = 'not-existing'; await p.ui.environmentSearch.emit('input'); expect(p.ui.environmentEmpty.hidden).toBe(false);
  });

  it('clears stale guide on a failed refresh and never falls back to embedded instructions', async () => {
    let reads = 0;
    const p = await page('environment', call => call.path === '/api/admin/environment' ? ++reads === 1 ? { body: environment() }
      : { status: 503, body: { error: { code: 'ENVIRONMENT_GUIDE_MISSING', message: '私有仓库说明尚未准备' } } } : { body: {} });
    expect(p.ui.environmentGroups.children).toHaveLength(2);
    await p.ui.reloadEnvironmentButton.emit('click'); expect(p.ui.environmentGroups.children).toHaveLength(0); expect(p.ui.environmentSource.textContent).toBe('');
    expect(p.ui.environmentMessage.hidden).toBe(false); expect(p.ui.environmentMessage.textContent).toContain('尚未准备');
  });
});

describe('optional AI project domains', () => {
  it('submits an empty origin list in auto mode and grants only the selected platform', async () => {
    const p = await page('ai'); p.ui.grantClientId.value = 'new-product';
    expect(p.ui.grantOrigins.required).toBe(false); expect(p.ui.grantOriginsLabel.textContent).toBe('项目域名（可留空）');
    expect(p.ui.grantOriginsHint.textContent).toContain('项目 AI');
    await p.ui.grantForm.emit('submit');
    const call = p.calls.find(call => call.path === '/api/admin/grants' && call.options.method === 'POST');
    expect(JSON.parse(String(call?.options.body))).toMatchObject({ clientId: 'new-product', allowedOrigins: [], domainMode: 'auto', mode: 'create' });
    expect(p.clipboard.writeText).toHaveBeenCalledWith('Scoped AI integration task');
  });

  it('requires explicit origins in fixed mode even if native validation is bypassed', async () => {
    const p = await page('ai'); p.ui.grantClientId.value = 'new-product'; p.ui.grantDomainMode.value = 'fixed'; await p.ui.grantDomainMode.emit('change');
    expect(p.ui.grantOrigins.required).toBe(true); expect(p.ui.grantOriginsLabel.textContent).toContain('必填');
    await p.ui.grantForm.emit('submit');
    expect(p.calls.filter(call => call.options.method === 'POST')).toHaveLength(0); expect(p.ui.grantMessage.textContent).toContain('至少一个');
    p.ui.grantOrigins.value = 'https://app.example.com'; await p.ui.grantForm.emit('submit');
    const call = p.calls.find(call => call.options.method === 'POST');
    expect(JSON.parse(String(call?.options.body))).toMatchObject({ allowedOrigins: ['https://app.example.com'], domainMode: 'fixed' });
  });
});
