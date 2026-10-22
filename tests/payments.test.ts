import { describe, expect, it, vi } from 'vitest';
import { Payments, type Gateway, type Trade } from '../src/payments';
import { hmacSha256, safeEqualHex, sha256 } from '../src/crypto';
import { checkoutToken } from '../src/auth';
import { handle } from '../src/index';
import type { Delivery, Env, Order, ProductClient, Store, Transaction, WorkQueue } from '../src/types';

const START = Date.UTC(2026, 9, 13, 8);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Immutable snapshots, serial writers and rollback model the Store contract. */
class MemoryStore implements Store {
  data = new Map<string, unknown>();
  commits: string[][] = [];
  private tail: Promise<void> = Promise.resolve();

  async readJson<T>(path: string): Promise<T | null> {
    await this.tail;
    return this.data.has(path) ? clone(this.data.get(path)) as T : null;
  }

  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const snapshot = new Map(this.data);
      const writes = new Map<string, unknown>();
      const tx: Transaction = {
        read: async <V>(path: string): Promise<V | null> => {
          const source = writes.has(path) ? writes : snapshot;
          return source.has(path) ? clone(source.get(path)) as V : null;
        },
        put: (path, value) => { writes.set(path, clone(value)); },
      };
      const value = await callback(tx);
      if (writes.size) {
        for (const [path, content] of writes) this.data.set(path, content);
        this.commits.push([...writes.keys()]);
      }
      return value;
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const client: ProductClient = {
  id: 'brclio', name: 'Brclio', apiSecret: 'a'.repeat(40), webhookSecret: 'b'.repeat(40),
  webhookUrl: 'https://brclio.com/api/payment',
  returnOrigins: ['https://brclio.com', 'https://*.brclio.com'],
  skus: { pro: { subject: 'Brclio Pro', amount: '9.90' }, annual: { subject: 'Brclio 年度', amount: '99.00' } },
};

function environment(): Env {
  return {
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    PAY_BASE_URL: 'https://pay.bornforthis.cn', PAYMENT_MODE: 'live', PAYMENT_ENABLED: 'true',
    ALIPAY_CHANNELS: 'page', ALIPAY_APP_ID: '2021007109602288',
    ALIPAY_PRIVATE_KEY: 'test-fixture-private', ALIPAY_PUBLIC_KEY: 'test-fixture-public',
    ALIPAY_SELLER_ID: '2088123456789012',
    GITHUB_TOKEN: 'test-fixture-token', GITHUB_REPOSITORY: 'owner/private-data', GITHUB_BRANCH: 'main',
    CHECKOUT_SECRET: 'c'.repeat(40), CLIENTS_JSON: JSON.stringify([client]),
  };
}

const notificationSecret = 'fake-gateway-for-business-tests-only';
function signature(data: Record<string, string>): string {
  return hmacSha256(notificationSecret, JSON.stringify(Object.entries(data).filter(([key]) => key !== 'sign').sort(([a], [b]) => a.localeCompare(b))));
}

/** Business-rule tests use a signed fake gateway; RSA2 is covered by adapter tests. */
function fixture(send: typeof fetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch) {
  let now = START;
  const env = environment();
  const store = new MemoryStore();
  const query = vi.fn<Gateway['query']>(async () => null);
  const close = vi.fn<Gateway['close']>(async () => undefined);
  const gateway: Gateway = {
    query,close,
    verifyNotification: data => safeEqualHex(data.sign || '', signature(data)),
    paymentUrl: () => 'https://openapi.alipay.com/gateway.do',
  };
  const payments = new Payments(env, store, gateway, () => now, send);
  const create = (body: Record<string, unknown> = {}) => payments.create(client, {
    productOrderId: 'product-order-1', sku: 'pro', returnUrl: 'https://brclio.com/account', ...body,
  });
  const notify = (id: string, overrides: Record<string, string> = {}) => {
    const data: Record<string, string> = {
      sign_type: 'RSA2', app_id: env.ALIPAY_APP_ID, seller_id: env.ALIPAY_SELLER_ID,
      out_trade_no: id, total_amount: '9.90', trade_no: '2026101322001462921037601726',
      trade_status: 'TRADE_SUCCESS', ...overrides,
    };
    data.sign = signature(data);
    return data;
  };
  return { env, store, query, close, payments, create, notify, setNow: (value: number) => { now = value; } };
}

describe('payment order authority and idempotency', () => {
  it('uses fixed server SKU pricing and generates a usable opaque order ID', async () => {
    const f = fixture();
    const created = await f.create();
    expect(created.id).toMatch(/^pay_[a-f0-9]{32}$/);
    expect(created.amount).toBe('9.90');
    expect(created.expiresAt).toBe(new Date(START+10*60_000).toISOString());
    expect(created.checkoutUrl).toContain(`/checkout/${created.id}#token=`);
    expect(await f.payments.order(created.id as string)).toMatchObject({ status: 'PENDING', clientId: client.id, amount: '9.90' });
  });

  it('rejects a client-supplied price without creating an order', async () => {
    const f = fixture();
    await expect(f.create({ amount: '0.01' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f.store.data.size).toBe(0);
  });

  it('coalesces simultaneous identical business orders', async () => {
    const f = fixture();
    const orders = await Promise.all(Array.from({ length: 8 }, () => f.create()));
    expect(new Set(orders.map(order => order.id)).size).toBe(1);
    expect([...f.store.data.keys()].filter(path => path.startsWith('orders/'))).toHaveLength(1);
    expect(f.store.commits).toHaveLength(1);
  });

  it.each([{ sku: 'annual' }, { returnUrl: 'https://brclio.com/other' }])('rejects changed content for the same product order: %j', async changed => {
    const f = fixture();
    const created = await f.create();
    await expect(f.create(changed)).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect((await f.payments.order(created.id as string)).amount).toBe('9.90');
  });

  it('replays the saved amount, title and hash after catalog repricing without changing new-order pricing', async () => {
    const f = fixture();
    const original = await f.create();
    const before = await f.payments.order(String(original.id));
    const changed = { ...client, skus: { ...client.skus, pro: { subject: 'New title', amount: '15.00' } } };
    const replay = await f.payments.create(changed, { productOrderId: 'product-order-1', sku: 'pro', returnUrl: 'https://brclio.com/account' });
    expect(replay).toMatchObject({ id: original.id, amount: '9.90', subject: 'Brclio Pro' });
    expect(await f.payments.order(String(original.id))).toEqual(before);
    expect(f.store.commits).toHaveLength(1);
    const fresh = await f.payments.create(changed, { productOrderId: 'product-order-2', sku: 'pro', returnUrl: 'https://brclio.com/account' });
    expect(fresh).toMatchObject({ amount: '15.00', subject: 'New title' });
    expect(fresh.id).not.toBe(original.id);
  });

  it('replays an existing SKU snapshot after sale stops or the SKU is removed, while rejecting new orders', async () => {
    const f = fixture();
    const original = await f.create();
    const catalogs:ProductClient[] = [
      { ...client, skus: { ...client.skus, pro: { subject: 'Stopped', amount: '15.00', enabled: false } } },
      { ...client, skus: { annual: client.skus.annual } },
    ];
    for (const changed of catalogs) {
      expect(await f.payments.create(changed, { productOrderId: 'product-order-1', sku: 'pro', returnUrl: 'https://brclio.com/account' })).toMatchObject({ id: original.id, amount: '9.90' });
      await expect(f.payments.create(changed, { productOrderId: 'new-business-order', sku: 'pro', returnUrl: 'https://brclio.com/account' })).rejects.toMatchObject({ code: Object.hasOwn(changed.skus, 'pro') ? 'SKU_DISABLED' : 'INVALID_REQUEST' });
      await expect(f.payments.create(changed, { productOrderId: 'product-order-1', sku: 'annual', returnUrl: 'https://brclio.com/account' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    expect(f.store.commits).toHaveLength(1);
  });

  it('does not reuse a live business-order index after switching to sandbox', async () => {
    const f = fixture();
    await f.create();
    f.env.PAYMENT_MODE = 'sandbox';
    await expect(f.create()).rejects.toMatchObject({ code: 'ENVIRONMENT_MISMATCH' });
    expect(f.store.commits).toHaveLength(1);
  });
});

describe('verified payment transitions and atomic outbox', () => {
  it('commits PAID and one event atomically, including concurrent duplicate notifications', async () => {
    const f = fixture();
    const created = await f.create();
    const id = created.id as string;
    await Promise.all(Array.from({ length: 6 }, () => f.payments.notification(f.notify(id))));
    expect((await f.payments.order(id)).status).toBe('PAID');
    const events = [...f.store.data.keys()].filter(path => path.startsWith('events/'));
    expect(events).toEqual([`events/evt_${id}.json`]);
    expect(f.store.commits).toHaveLength(2);
    expect(f.store.commits[1]).toEqual(expect.arrayContaining([`orders/${id}.json`, events[0], 'system/queue.json']));
    const queue = await f.store.readJson<WorkQueue>('system/queue.json');
    expect(queue).toEqual({ orders: [], deliveries: [`evt_${id}`] });
  });

  it.each([
    { app_id: '2021007109602299' },
    { seller_id: '2088999999999999' },
    { total_amount: '0.01' },
  ])('rejects a validly signed notification with mismatched business fields: %j', async changed => {
    const f = fixture();
    const id = (await f.create()).id as string;
    await expect(f.payments.notification(f.notify(id, changed as unknown as Record<string, string>))).rejects.toMatchObject({ code: 'PAYMENT_MISMATCH' });
    expect((await f.payments.order(id)).status).toBe('PENDING');
    expect([...f.store.data.keys()].some(path => path.startsWith('events/'))).toBe(false);
  });

  it('rejects a tampered signature and RSA downgrade', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    const changed = f.notify(id);
    changed.sign = '0'.repeat(64);
    await expect(f.payments.notification(changed)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(f.payments.notification(f.notify(id, { sign_type: 'RSA' }))).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect((await f.payments.order(id)).status).toBe('PENDING');
  });

  it('accepts TRADE_FINISHED but does not downgrade after late pending or closed notifications', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    await f.payments.notification(f.notify(id, { trade_status: 'TRADE_FINISHED' }));
    expect(await f.payments.notification(f.notify(id, { trade_status: 'WAIT_BUYER_PAY' }))).toBeNull();
    await f.payments.notification(f.notify(id, { trade_status: 'TRADE_CLOSED' }));
    expect((await f.payments.order(id)).status).toBe('PAID');
    expect([...f.store.data.keys()].filter(path => path.startsWith('events/'))).toHaveLength(1);
  });

  it('does not lose a genuine late payment after an earlier closed status', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    await f.payments.notification(f.notify(id, { trade_status: 'TRADE_CLOSED' }));
    await f.payments.notification(f.notify(id));
    expect((await f.payments.order(id)).status).toBe('PAID');
    expect(await f.store.readJson(`events/evt_${id}.json`)).not.toBeNull();
  });

  it('rejects a conflicting Alipay transaction number without overwriting a paid order', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    await f.payments.notification(f.notify(id));
    await expect(f.payments.notification(f.notify(id, { trade_no: '2026101322001462921099999999' }))).rejects.toMatchObject({ code: 'PAYMENT_MISMATCH' });
    expect((await f.payments.order(id)).tradeNo).toBe('2026101322001462921037601726');
  });

  it('keeps verified Shanghai payment time separate from a delayed notification and never rewrites it on replay', async () => {
    const f = fixture();
    const id = String((await f.create()).id);
    f.setNow(START + 24 * 3600_000);
    const paid = await f.payments.notification(f.notify(id, { gmt_payment: '2026-10-13 23:59:00' }));
    expect(paid?.paidAt).toBe('2026-10-13T15:59:00.000Z');
    const event = await f.store.readJson<Delivery>(`events/evt_${id}.json`);
    expect(event?.event).toMatchObject({ createdAt: new Date(START + 24 * 3600_000).toISOString(), data: { paidAt: paid?.paidAt } });
    await f.payments.notification(f.notify(id, { gmt_payment: '2026-10-14 16:00:00' }));
    expect((await f.payments.order(id)).paidAt).toBe(paid?.paidAt);
    expect(await f.store.readJson(`events/evt_${id}.json`)).toEqual(event);
    expect(f.store.commits).toHaveLength(2);
  });

  it.each(['not-a-time', '', '2026-02-30 12:00:00', '2026-10-13 24:00:00', '2026-10-14 00:00:00'])('rejects an explicitly invalid or future signed payment timestamp: %j', async gmt_payment => {
    const f = fixture();
    const id = String((await f.create()).id);
    await expect(f.payments.notification(f.notify(id, { gmt_payment }))).rejects.toMatchObject({ code: 'PAYMENT_MISMATCH' });
    expect((await f.payments.order(id)).status).toBe('PENDING');
    expect(await f.store.readJson(`events/evt_${id}.json`)).toBeNull();
    expect(f.store.commits).toHaveLength(1);
  });

  it('uses first confirmation time only when the provider payment timestamp is absent', async () => {
    const f = fixture();
    const id = String((await f.create()).id);
    f.setNow(START + 3600_000);
    const paid = await f.payments.notification(f.notify(id));
    expect(paid?.paidAt).toBe(new Date(START + 3600_000).toISOString());
    f.setNow(START + 7200_000);
    await f.payments.notification(f.notify(id));
    expect((await f.payments.order(id)).paidAt).toBe(paid?.paidAt);
  });
});

describe('reconciliation and durable delivery', () => {
  const waiting = (id:string):Trade => ({outTradeNo:id,tradeNo:'2026101322001462921037601726',tradeStatus:'WAIT_BUYER_PAY',totalAmount:'9.90'});

  it('closes an uninitiated order at ten minutes, atomically removing it from future maintenance',async()=>{
    const f=fixture(),id=String((await f.create()).id);
    f.setNow(START+10*60_000-1);
    expect(await f.payments.refresh(id)).toMatchObject({status:'PENDING'});
    f.setNow(START+10*60_000);
    const before=f.store.commits.length;
    expect(await f.payments.refresh(id)).toMatchObject({status:'CLOSED',amount:'9.90'});
    expect(f.close).not.toHaveBeenCalled();
    expect(f.store.commits).toHaveLength(before+1);
    expect(f.store.commits.at(-1)).toEqual(expect.arrayContaining([`orders/${id}.json`,'system/queue.json']));
    expect(await f.store.readJson('system/queue.json')).toEqual({orders:[],deliveries:[]});
    expect([...f.store.data.keys()].some(path=>path.startsWith('events/'))).toBe(false);
    const commits=f.store.commits.length,queries=f.query.mock.calls.length;
    f.setNow(START+24*3600_000);
    await f.payments.maintenance([client]);await f.payments.refresh(id);
    expect(f.store.commits).toHaveLength(commits);
    expect(f.query).toHaveBeenCalledTimes(queries);
  });

  it('closes a verified unpaid Alipay trade before persisting CLOSED',async()=>{
    const f=fixture(),id=String((await f.create()).id);
    f.query.mockResolvedValue(waiting(id));
    f.setNow(START+10*60_000);
    f.close.mockImplementationOnce(async()=>{expect(await f.payments.order(id)).toMatchObject({status:'PENDING'});});
    expect(await f.payments.refresh(id)).toMatchObject({status:'CLOSED'});
    expect(f.close).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.store.commits).toHaveLength(2);
    expect(await f.store.readJson('system/queue.json')).toEqual({orders:[],deliveries:[]});
  });

  it('applies the ten minute limit to legacy orders without rewriting their purchase snapshot',async()=>{
    const f=fixture(),id=String((await f.create()).id);
    const original={...(await f.payments.order(id)),expiresAt:new Date(START+30*60_000).toISOString()};
    f.store.data.set(`orders/${id}.json`,original);
    expect(f.payments.view(original,client).expiresAt).toBe(new Date(START+10*60_000).toISOString());
    f.setNow(START+11*60_000);
    await f.payments.maintenance([client]);
    expect(await f.payments.order(id)).toEqual({...original,status:'CLOSED'});
    expect(await f.store.readJson('system/queue.json')).toEqual({orders:[],deliveries:[]});
    const replay=await f.create();
    expect(replay).toMatchObject({id,status:'CLOSED'});
    expect((await f.create({productOrderId:'new-purchase'})).id).not.toBe(id);
  });

  it('never extends an earlier persisted payment deadline',async()=>{
    const f=fixture(),id=String((await f.create()).id);
    const original={...(await f.payments.order(id)),expiresAt:new Date(START+5*60_000).toISOString()};
    f.store.data.set(`orders/${id}.json`,original);f.setNow(START+5*60_000);
    expect(f.payments.view(original,client).expiresAt).toBe(original.expiresAt);
    expect(await f.payments.refresh(id)).toMatchObject({status:'CLOSED'});
  });

  it.each(['query','close'])('retains uncertain expired orders without repeated timestamp commits on %s failure',async failure=>{
    const f=fixture(),id=String((await f.create()).id),before=await f.payments.order(id);
    f.setNow(START+10*60_000);
    if(failure==='query')f.query.mockRejectedValue(new Error('unavailable'));
    else {f.query.mockResolvedValue(waiting(id));f.close.mockRejectedValue(new Error('unavailable'));}
    for(let n=0;n<2;n++)await expect(f.payments.refresh(id)).rejects.toThrow('unavailable');
    expect(await f.payments.order(id)).toEqual(before);
    expect(await f.store.readJson('system/queue.json')).toEqual({orders:[id],deliveries:[]});
    expect(f.store.commits).toHaveLength(1);
  });

  it.each([{totalAmount:'0.01'},{sellerId:'2088999999999999'},{outTradeNo:'pay_'+'0'.repeat(32)}])('does not close a mismatched expired trade: %j',async changed=>{
    const f=fixture(),id=String((await f.create()).id);
    f.setNow(START+10*60_000);f.query.mockResolvedValue({...waiting(id),...changed});
    await expect(f.payments.refresh(id)).rejects.toMatchObject({code:'PAYMENT_MISMATCH'});
    expect(f.close).not.toHaveBeenCalled();expect(f.store.commits).toHaveLength(1);
  });

  it('preserves an expired order already paid at Alipay and creates its normal notification',async()=>{
    const f=fixture(),id=String((await f.create()).id),paidAt=new Date(START+9*60_000).toISOString();
    f.setNow(START+11*60_000);f.query.mockResolvedValue({...waiting(id),tradeStatus:'TRADE_SUCCESS',paidAt});
    expect(await f.payments.refresh(id)).toMatchObject({status:'PAID',paidAt});
    expect(f.close).not.toHaveBeenCalled();
    expect(await f.store.readJson(`events/evt_${id}.json`)).toMatchObject({event:{data:{paidAt,amount:'9.90'}}});
  });

  it.each(['TRADE_SUCCESS','TRADE_CLOSED'])('recovers a close race using verified %s state',async tradeStatus=>{
    const f=fixture(),id=String((await f.create()).id);f.setNow(START+10*60_000);
    f.query.mockResolvedValueOnce(waiting(id)).mockResolvedValue({...waiting(id),tradeStatus});
    f.close.mockRejectedValue(new Error('close raced'));
    expect(await f.payments.refresh(id)).toMatchObject({status:tradeStatus==='TRADE_SUCCESS'?'PAID':'CLOSED'});
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.store.commits).toHaveLength(2);
  });

  it('cannot overwrite a concurrent paid notification with CLOSED',async()=>{
    const f=fixture(),id=String((await f.create()).id);f.setNow(START+10*60_000);
    f.query.mockResolvedValue(waiting(id));
    f.close.mockImplementationOnce(async()=>{await f.payments.notification(f.notify(id));});
    expect(await f.payments.refresh(id)).toMatchObject({status:'PAID'});
    expect(await f.store.readJson('system/queue.json')).toEqual({orders:[],deliveries:[`evt_${id}`]});
    expect(f.store.commits).toHaveLength(2);
  });

  it('keeps concurrent expiry cleanup idempotent and accepts genuine delayed paid notifications',async()=>{
    const f=fixture(),id=String((await f.create()).id);f.setNow(START+10*60_000);
    await Promise.all(Array.from({length:4},()=>f.payments.refresh(id)));
    expect(await f.payments.order(id)).toMatchObject({status:'CLOSED'});expect(f.store.commits).toHaveLength(2);
    await f.payments.notification(f.notify(id));
    expect(await f.payments.order(id)).toMatchObject({status:'PAID'});
    expect([...f.store.data.keys()].filter(path=>path.startsWith('events/'))).toEqual([`events/evt_${id}.json`]);
  });

  it('continues verifying old queued payments instead of silently dropping them after seven days',async()=>{
    const f=fixture(),id=String((await f.create()).id);f.setNow(START+8*24*3600_000);
    f.query.mockRejectedValue(new Error('unavailable'));
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {await f.payments.maintenance([client]);}finally{warning.mockRestore();}
    expect(await f.store.readJson('system/queue.json')).toEqual({orders:[id],deliveries:[]});
    expect(f.store.commits).toHaveLength(1);
  });

  it('reads stored state without writes and throttles active reconciliation', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    await Promise.all(Array.from({ length: 4 }, () => f.payments.order(id)));
    expect(f.store.commits).toHaveLength(1);
    await Promise.all(Array.from({ length: 4 }, () => f.payments.refresh(id)));
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.store.commits).toHaveLength(2);
    expect((await f.payments.order(id)).status).toBe('PENDING');
    f.setNow(START + 60_000);
    await f.payments.refresh(id);
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it('rejects a query for a different order and keeps the current order pending', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    f.query.mockResolvedValue({ outTradeNo: 'pay_' + '0'.repeat(32), tradeNo: '2026101322001462921037601726', tradeStatus: 'TRADE_SUCCESS', totalAmount: '9.90' });
    await expect(f.payments.refresh(id)).rejects.toMatchObject({ code: 'PAYMENT_MISMATCH' });
    expect((await f.payments.order(id)).status).toBe('PENDING');
  });

  it('reconciles an authoritative paid query through the same outbox', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    const trade: Trade = { outTradeNo: id, tradeNo: '2026101322001462921037601726', tradeStatus: 'TRADE_SUCCESS', totalAmount: '9.90', sellerId: f.env.ALIPAY_SELLER_ID };
    f.query.mockResolvedValue(trade);
    expect((await f.payments.refresh(id)).status).toBe('PAID');
    expect(await f.store.readJson<Delivery>(`events/evt_${id}.json`)).toMatchObject({ attempts: 0, event: { data: { orderId: id, amount: '9.90' } } });
  });

  it('uses a verified query payment timestamp instead of the later reconciliation time', async () => {
    const f = fixture();
    const id = String((await f.create()).id), paidAt = new Date(START + 60_000).toISOString();
    f.setNow(START + 24 * 3600_000);
    f.query.mockResolvedValue({ outTradeNo: id, tradeNo: '2026101322001462921037601726', tradeStatus: 'TRADE_SUCCESS', totalAmount: '9.90', sellerId: f.env.ALIPAY_SELLER_ID, paidAt });
    expect(await f.payments.refresh(id)).toMatchObject({ status: 'PAID', paidAt });
    expect(await f.store.readJson<Delivery>(`events/evt_${id}.json`)).toMatchObject({ event: { createdAt: new Date(START + 24 * 3600_000).toISOString(), data: { paidAt } } });
  });

  it.each(['2026-02-30T12:00:00.000Z', '2026-10-14T08:00:00.000Z', 'invalid'])('does not confirm an invalid query payment timestamp: %j', async paidAt => {
    const f = fixture();
    const id = String((await f.create()).id);
    f.query.mockResolvedValue({ outTradeNo: id, tradeNo: '2026101322001462921037601726', tradeStatus: 'TRADE_SUCCESS', totalAmount: '9.90', paidAt });
    await expect(f.payments.refresh(id)).rejects.toMatchObject({ code: 'PAYMENT_MISMATCH' });
    expect((await f.payments.order(id)).status).toBe('PENDING');
    expect(await f.store.readJson(`events/evt_${id}.json`)).toBeNull();
  });

  it('keeps redirected notifications pending without forwarding their signed payload',async()=>{
    const send=vi.fn(async(_url:RequestInfo | URL,options?:RequestInit)=>{expect(options?.redirect).toBe('manual');return new Response(null,{status:302,headers:{Location:'https://untrusted.example/'}});});
    const f=fixture(send as typeof fetch);const created=await f.create();await f.payments.notification(f.notify(String(created.id)));
    const event=`evt_${created.id}`;await f.payments.deliver(event,client);
    const delivery=await f.store.readJson<Delivery>(`events/${event}.json`);
    expect(delivery?.lastStatus).toBe(302);expect(delivery?.deliveredAt).toBeUndefined();
    expect((await f.payments.order(String(created.id))).fulfillmentStatus).toBe('pending');expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed webhook queued and retries the same signed event successfully', async () => {
    const send = vi.fn(async () => new Response('retry', { status: 503 }));
    send.mockImplementationOnce(async () => new Response('retry', { status: 503 }));
    send.mockImplementationOnce(async () => new Response(null, { status: 204 }));
    const f = fixture(send as unknown as typeof fetch);
    const id = (await f.create()).id as string;
    await f.payments.notification(f.notify(id));
    const event = `evt_${id}`;
    await f.payments.deliver(event, client);
    const failed = await f.store.readJson<Delivery>(`events/${event}.json`);
    expect(failed).toMatchObject({ attempts: 1, lastStatus: 503 });
    expect(failed?.deliveredAt).toBeUndefined();
    expect((await f.payments.order(id)).fulfillmentStatus).toBe('pending');
    await f.payments.deliver(event, client);
    expect(send).toHaveBeenCalledTimes(1);
    f.setNow(Date.parse(failed!.nextAttemptAt));
    await f.payments.maintenance([client]);
    expect(send).toHaveBeenCalledTimes(2);
    const calls = send.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][1].body).toBe(calls[1][1].body);
    for (const [, init] of calls) {
      const headers = new Headers(init.headers);
      const timestamp = headers.get('X-Brclio-Timestamp')!;
      expect(headers.get('X-Brclio-Event')).toBe(event);
      expect(headers.get('X-Brclio-Signature')).toBe(hmacSha256(client.webhookSecret, timestamp + '.' + init.body));
      expect(init.redirect).toBe('manual');
    }
    expect(await f.store.readJson<Delivery>(`events/${event}.json`)).toMatchObject({ attempts: 2, lastStatus: 204, event: { id: event } });
    expect((await f.payments.order(id)).fulfillmentStatus).toBe('delivered');
    expect((await f.store.readJson<WorkQueue>('system/queue.json'))?.deliveries).toEqual([]);
  });

  it('uses a durable lease to avoid concurrent webhook sends', async () => {
    const send = vi.fn(async () => new Response('ok', { status: 200 }));
    const f = fixture(send as unknown as typeof fetch);
    const id = (await f.create()).id as string;
    await f.payments.notification(f.notify(id));
    await Promise.all(Array.from({ length: 8 }, () => f.payments.deliver(`evt_${id}`, client)));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await f.payments.order(id)).fulfillmentStatus).toBe('delivered');
  });

  it('does not deliver an event with a different product credential', async () => {
    const send = vi.fn(async () => new Response('ok', { status: 200 }));
    const f = fixture(send as unknown as typeof fetch);
    const id = (await f.create()).id as string;
    await f.payments.notification(f.notify(id));
    await expect(f.payments.deliver(`evt_${id}`, { ...client, id: 'another-product' })).rejects.toMatchObject({ code: 'CLIENT_MISMATCH' });
    expect(send).not.toHaveBeenCalled();
    expect(await f.store.readJson<Delivery>(`events/evt_${id}.json`)).toMatchObject({ attempts: 0 });
  });

  it('keeps sandbox events visibly separate and never invokes the live entitlement handler', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(START);
    try {
      const { createWebhookHandler } = await import(new URL('../examples/webhook-handler.mjs', import.meta.url).href);
      const applyEntitlement = vi.fn(async (_event: unknown) => undefined);
      const handler = createWebhookHandler({ clientId: client.id, webhookSecret: client.webhookSecret, applyEntitlement });
      const send = vi.fn(async (input: unknown, init?: RequestInit) => handler(new Request(String(input), init)));
      const f = fixture(send as unknown as typeof fetch);
      f.env.PAYMENT_MODE = 'sandbox';
      f.env.ALIPAY_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
      const created = await f.create();
      const id = created.id as string;
      expect(created.mode).toBe('sandbox');
      await f.payments.notification(f.notify(id));
      await f.payments.deliver(`evt_${id}`, client);
      expect(send).toHaveBeenCalledTimes(1);
      expect(applyEntitlement).not.toHaveBeenCalled();
      expect(await f.store.readJson<Delivery>(`events/evt_${id}.json`)).toMatchObject({
        lastStatus: 401, event: { mode: 'sandbox', type: 'payment.paid' },
      });
      expect((await f.payments.order(id)).fulfillmentStatus).toBe('pending');
      f.env.PAYMENT_MODE = 'live';
      await expect(f.payments.order(id)).rejects.toMatchObject({ code: 'ENVIRONMENT_MISMATCH' });
      await expect(f.payments.refresh(id)).rejects.toMatchObject({ code: 'ENVIRONMENT_MISMATCH' });
    } finally { clock.mockRestore(); }
  });
});

describe('worker trust boundaries', () => {
  const context = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }) as unknown as ExecutionContext;
  const sign = (configuration: Env, owner: ProductClient, path: string, method = 'GET', body = '') => {
    const timestamp = String(Math.floor(START / 1000));
    const nonce = 'test_worker_nonce_123456789';
    const pathname = new URL(path, configuration.PAY_BASE_URL).pathname;
    const signature = hmacSha256(owner.apiSecret, [method, pathname, timestamp, nonce, sha256(body)].join('\n'));
    return new Request(configuration.PAY_BASE_URL + path, {
      method, headers: {
        'X-Brclio-Client': owner.id, 'X-Brclio-Timestamp': timestamp,
        'X-Brclio-Nonce': nonce, 'X-Brclio-Signature': signature,
      }, ...(method === 'POST' ? { body } : {}),
    });
  };

  it.each(['', '/refresh'])('rejects another product before reading or refreshing its order %s', async suffix => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(START);
    try {
      const f = fixture();
      const id = (await f.create()).id as string;
      const other = { ...client, id: 'another-product', apiSecret: 'other-api-secret-'.repeat(4) };
      f.env.CLIENTS_JSON = JSON.stringify([client, other]);
      const ctx = context();
      const response = await handle(sign(f.env, other, `/api/v1/orders/${id}${suffix}`, suffix ? 'POST' : 'GET'), f.env, ctx, f.payments);
      expect(response.status).toBe(404);
      expect(f.query).not.toHaveBeenCalled();
      expect(f.store.commits).toHaveLength(1);
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('allows authenticated product GET without triggering delivery or writes', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(START);
    try {
      const f = fixture();
      const id = (await f.create()).id as string;
      await f.payments.notification(f.notify(id));
      const commits = f.store.commits.length;
      const ctx = context();
      const response = await handle(sign(f.env, client, `/api/v1/orders/${id}`), f.env, ctx, f.payments);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id, status: 'PAID', amount: '9.90' });
      expect(f.store.commits).toHaveLength(commits);
      expect(ctx.waitUntil).not.toHaveBeenCalled();
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    } finally { clock.mockRestore(); }
  });

  it.each(['product','checkout'])('exposes the ten-minute deadline for a legacy pending order through %s GET without rewriting it',async surface=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(START);
    try {
      const f=fixture(),id=String((await f.create()).id);
      const original={...(await f.payments.order(id)),expiresAt:new Date(START+30*60_000).toISOString()};
      f.store.data.set(`orders/${id}.json`,original);
      const ctx=context();
      const request=surface==='product'
        ? sign(f.env,client,`/api/v1/orders/${id}`)
        : new Request(`${f.env.PAY_BASE_URL}/api/checkout/${id}`,{headers:{Authorization:'Bearer '+checkoutToken(id,f.env)}});
      const response=await handle(request,f.env,ctx,f.payments);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({id,status:'PENDING',expiresAt:new Date(START+10*60_000).toISOString()});
      expect(await f.payments.order(id)).toEqual(original);
      expect(f.store.commits).toHaveLength(1);
      expect(f.query).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled();
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    } finally {clock.mockRestore();}
  });

  it('retains the original deadline of an already-paid legacy order in product GET',async()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(START);
    try {
      const f=fixture(),id=String((await f.create()).id);
      const expiresAt=new Date(START+30*60_000).toISOString();
      f.store.data.set(`orders/${id}.json`,{...(await f.payments.order(id)),expiresAt});
      await f.payments.notification(f.notify(id));
      const before=await f.payments.order(id),commits=f.store.commits.length,ctx=context();
      const response=await handle(sign(f.env,client,`/api/v1/orders/${id}`),f.env,ctx,f.payments);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({id,status:'PAID',expiresAt});
      expect(await f.payments.order(id)).toEqual(before);
      expect(f.store.commits).toHaveLength(commits);
      expect(f.query).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled();
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    } finally {clock.mockRestore();}
  });

  it('passes the effective legacy deadline to Alipay at 9:59 and rejects payment at 10:00 without provider calls or writes',async()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(START);
    try {
      const f=fixture(),id=String((await f.create()).id);
      const original={...(await f.payments.order(id)),expiresAt:new Date(START+30*60_000).toISOString()};
      f.store.data.set(`orders/${id}.json`,original);
      const paymentUrl=vi.spyOn(f.payments.gateway!,'paymentUrl');
      const request=()=>new Request(`${f.env.PAY_BASE_URL}/api/checkout/${id}/pay`,{
        method:'POST',headers:{Authorization:'Bearer '+checkoutToken(id,f.env),'Content-Type':'application/json'},
        body:JSON.stringify({channel:'page'}),
      });
      const ctx=context();
      clock.mockReturnValue(START+9*60_000+59_000);f.setNow(START+9*60_000+59_000);
      const allowed=await handle(request(),f.env,ctx,f.payments);
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({provider:'alipay',channel:'page',paymentUrl:'https://openapi.alipay.com/gateway.do'});
      expect(paymentUrl).toHaveBeenCalledExactlyOnceWith(
        {id,subject:original.subject,totalAmount:original.amount,expiresAt:new Date(START+10*60_000).toISOString()},
        {channel:'page',notifyUrl:`${f.env.PAY_BASE_URL}/api/alipay/notify`,pageReturnUrl:`${f.env.PAY_BASE_URL}/payment/return?payment_order_id=${id}`},
      );
      const reserved=await f.payments.order(id),commits=f.store.commits.length;
      expect(reserved).toMatchObject({id,amount:original.amount,createdAt:original.createdAt,expiresAt:original.expiresAt});
      clock.mockReturnValue(START+10*60_000);f.setNow(START+10*60_000);
      const expired=await handle(request(),f.env,ctx,f.payments);
      expect(expired.status).toBe(409);
      expect(await expired.json()).toMatchObject({error:{code:'ORDER_NOT_PAYABLE'}});
      expect(paymentUrl).toHaveBeenCalledTimes(1);
      expect(f.query).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled();
      expect(await f.payments.order(id)).toEqual(reserved);
      expect(f.store.commits).toHaveLength(commits);
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    } finally {clock.mockRestore();}
  });

  it('rejects a signed product query string', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(START);
    try {
      const f = fixture();
      const id = (await f.create()).id as string;
      const response = await handle(sign(f.env, client, `/api/v1/orders/${id}?pretend=paid`), f.env, context(), f.payments);
      expect(response.status).toBe(401);
    } finally { clock.mockRestore(); }
  });

  it('never confirms payment from an untrusted browser return', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    const ctx = context();
    const response = await handle(new Request(`${f.env.PAY_BASE_URL}/payment/return?out_trade_no=${id}&trade_status=TRADE_SUCCESS`), f.env, ctx, f.payments);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`${f.env.PAY_BASE_URL}/checkout/${id}`);
    expect((await f.payments.order(id)).status).toBe('PENDING');
    expect(f.store.commits).toHaveLength(1);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('rejects duplicate notification fields before changing the order', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    const body = new URLSearchParams(f.notify(id));
    body.append('total_amount', '0.01');
    const response = await handle(new Request(f.env.PAY_BASE_URL + '/api/alipay/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    }), f.env, context(), f.payments);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('failure');
    expect((await f.payments.order(id)).status).toBe('PENDING');
  });

  it('requires the checkout capability and its origin while valid polling stays read only', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    const url = f.env.PAY_BASE_URL + '/api/checkout/' + id;
    const denied = await handle(new Request(url), f.env, context(), f.payments);
    expect(denied.status).toBe(401);
    const authorization = 'Bearer ' + checkoutToken(id, f.env);
    const crossOrigin = await handle(new Request(url, { headers: { Authorization: authorization, Origin: 'https://evil.example' } }), f.env, context(), f.payments);
    expect(crossOrigin.status).toBe(403);
    const ctx = context();
    const allowed = await handle(new Request(url, { headers: { Authorization: authorization, Origin: f.env.PAY_BASE_URL } }), f.env, ctx, f.payments);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ id, status: 'PENDING', amount: '9.90' });
    expect(f.store.commits).toHaveLength(1);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('keeps payment initiation disabled by the operator switch', async () => {
    const f = fixture();
    const id = (await f.create()).id as string;
    f.env.PAYMENT_ENABLED = 'false';
    const response = await handle(new Request(`${f.env.PAY_BASE_URL}/api/checkout/${id}/pay`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + checkoutToken(id, f.env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'page' }),
    }), f.env, context(), f.payments);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'PAYMENTS_DISABLED' } });
    expect((await f.payments.order(id)).status).toBe('PENDING');
  });
});
