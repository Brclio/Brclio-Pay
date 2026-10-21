import {describe,expect,it,vi} from 'vitest';
import {Payments,type Gateway,type Trade,type AdminOrderAction} from '../src/payments';
import {sha256} from '../src/crypto';
import type {Delivery,Env,Order,ProductClient,Store,Transaction,WorkQueue} from '../src/types';

const START=Date.UTC(2026,9,19,4),clone=<T>(value:T):T=>structuredClone(value);
class MemoryStore implements Store {
  data=new Map<string,unknown>();commits:string[][]=[];tail:Promise<void>=Promise.resolve();
  async readJson<T>(path:string):Promise<T|null>{await this.tail;return this.data.has(path)?clone(this.data.get(path)) as T:null;}
  transaction<T>(callback:(tx:Transaction)=>Promise<T>):Promise<T>{
    const result=this.tail.then(async()=>{
      const snapshot=new Map(this.data),writes=new Map<string,unknown>();
      const value=await callback({read:async<V>(path:string)=>{const source=writes.has(path)?writes:snapshot;return source.has(path)?clone(source.get(path)) as V:null;},put:(path,value)=>writes.set(path,clone(value))});
      if(writes.size){for(const [path,value]of writes)this.data.set(path,value);this.commits.push([...writes.keys()]);}return value;
    });this.tail=result.then(()=>undefined,()=>undefined);return result;
  }
}
const client:ProductClient={id:'brclio',name:'Product',apiSecret:'a'.repeat(40),webhookSecret:'b'.repeat(40),webhookUrl:'https://product.example.com/hook',returnOrigins:['https://product.example.com'],skus:{pro:{subject:'Original item',amount:'9.90'}}};
function fixture(){
  let now=START;
  const env:Env={ASSETS:{fetch:async()=>new Response('')} as unknown as Fetcher,PAY_BASE_URL:'https://pay.example.com',PAYMENT_MODE:'live',PAYMENT_ENABLED:'true',ALIPAY_CHANNELS:'page',ALIPAY_APP_ID:'2021007109602288',ALIPAY_SELLER_ID:'2088123456789012',ALIPAY_PRIVATE_KEY:'fixture-private',ALIPAY_PUBLIC_KEY:'fixture-public',GITHUB_TOKEN:'fixture-token',GITHUB_REPOSITORY:'owner/private',GITHUB_BRANCH:'main',CHECKOUT_SECRET:'c'.repeat(40),CLIENTS_JSON:JSON.stringify([client])};
  const store=new MemoryStore(),query=vi.fn<Gateway['query']>(async()=>null),close=vi.fn<Gateway['close']>(async()=>undefined);
  const service=new Payments(env,store,{query,close,verifyNotification:()=>true,paymentUrl:()=>''},()=>now,async()=>new Response('ok'));
  const create=async()=>String((await service.create(client,{productOrderId:'purchase-1',sku:'pro',returnUrl:'https://product.example.com/return'})).id);
  let sequence=0;
  const action=async(id:string,kind:AdminOrderAction,options:{version?:string;requestId?:string;reason?:string;product?:ProductClient}={})=>service.adminAction(id,kind,{expectedVersion:options.version??(await service.adminDetail(id)).version,requestId:options.requestId??`request_${++sequence}`,reason:options.reason??'Administrator checked this order'},'admin@example.com',options.product??client);
  return {env,store,query,close,service,create,action,setNow:(value:number)=>{now=value;}};
}
const waiting=(id:string):Trade=>({outTradeNo:id,tradeNo:'2026101922001400000000000000',tradeStatus:'WAIT_BUYER_PAY',totalAmount:'9.90'});
const paid=(id:string,tradeNo='2026101922001400000000000000'):Trade=>({...waiting(id),tradeNo,tradeStatus:'TRADE_SUCCESS',paidAt:new Date(START).toISOString()});

describe('administrator order lifecycle and immutable purchase identity',()=>{
  it('closes an uninitiated order and atomically writes the status, queue, report and audit',async()=>{
    const f=fixture(),id=await f.create(),before=await f.service.order(id);
    const result=await f.action(id,'close');
    expect(result.order.status).toBe('CLOSED');expect(result.audit[0]).toMatchObject({action:'close',actor:'admin@example.com',beforeStatus:'PENDING',afterStatus:'CLOSED',status:'completed'});
    expect(f.close).not.toHaveBeenCalled();expect(await f.store.readJson<WorkQueue>('system/queue.json')).toEqual({orders:[],deliveries:[]});
    expect(await f.service.order(id)).toMatchObject({amount:before.amount,createdAt:before.createdAt,expiresAt:before.expiresAt});
    expect(f.store.commits.at(-1)).toEqual(expect.arrayContaining([`orders/${id}.json`,'system/queue.json',`order-actions/${id}/${sha256(result.audit[0].requestId)}.json`]));
    expect(f.store.commits.at(-1)?.some(path=>path.startsWith('reporting/'))).toBe(true);
  });
  it('closes a verified pending provider trade before publishing local CLOSED',async()=>{
    const f=fixture(),id=await f.create();f.query.mockResolvedValue(waiting(id));
    f.close.mockImplementation(async()=>{expect((await f.service.order(id)).status).toBe('PENDING');});
    const result=await f.action(id,'close');expect(f.close).toHaveBeenCalledExactlyOnceWith(id);
    expect(result.order.activeAttempt).toMatchObject({id,status:'CLOSED',closeConfirmed:true});expect(result.order.mayStillPayUntil).toBeUndefined();
  });
  it('reopens with a fresh provider ID and ten minutes while preserving all original purchase fields',async()=>{
    const f=fixture(),id=await f.create(),original=await f.service.order(id);await f.action(id,'close');f.setNow(START+30_000);
    const changed={...client,skus:{pro:{subject:'Changed product',amount:'99.00'}}};
    const result=await f.action(id,'reopen',{product:changed}),reopened=await f.service.order(id);
    expect(reopened).toMatchObject({id,productOrderId:original.productOrderId,amount:'9.90',subject:'Original item',createdAt:original.createdAt,expiresAt:original.expiresAt,status:'PENDING'});
    expect(result.order.activeAttempt.id).not.toBe(id);expect(result.order.activeAttempt.expiresAt).toBe(new Date(START+630_000).toISOString());
    expect(result.checkoutUrl).toContain(`/checkout/${id}#token=`);expect(await f.store.readJson(`payment-attempts/${result.order.activeAttempt.id}.json`)).toEqual({orderId:id,mode:'live'});
    expect((await f.store.readJson<WorkQueue>('system/queue.json'))?.orders).toEqual([id]);
    const retry=await f.service.create(client,{productOrderId:'purchase-1',sku:'pro',returnUrl:'https://product.example.com/return'});expect(retry.id).toBe(id);expect(retry.status).toBe('PENDING');
  });
  it('queries and closes every old provider attempt before making a new payment window',async()=>{
    const f=fixture(),id=await f.create();f.query.mockResolvedValue(waiting(id));await f.action(id,'close');
    f.query.mockImplementation(async provider=>({...waiting(provider),tradeStatus:'TRADE_CLOSED'}));
    const first=await f.action(id,'reopen'),next=first.order.activeAttempt.id;await f.action(id,'close');f.query.mockClear();
    await f.action(id,'reopen');expect(f.query.mock.calls.map(call=>call[0])).toEqual([id,next]);
  });
  it.each(['disabled','missing','stopped','payments-off'] as const)('does not reopen when current sales configuration is %s',async change=>{
    const f=fixture(),id=await f.create();await f.action(id,'close');
    let product=client;if(change==='disabled')product={...client,enabled:false};if(change==='missing')product={...client,skus:{}};if(change==='stopped')product={...client,skus:{pro:{...client.skus.pro,enabled:false}}};if(change==='payments-off')f.env.PAYMENT_ENABLED='false';
    await expect(f.action(id,'reopen',{product})).rejects.toMatchObject({code:change==='payments-off'?'PAYMENTS_DISABLED':change==='disabled'?'CLIENT_DISABLED':'SKU_DISABLED'});expect((await f.service.order(id)).status).toBe('CLOSED');
  });
});

describe('payment proof, stable event identity and late provider results',()=>{
  it.each(['close','reopen','reconcile'] as const)('records genuine payment instead of doing %s when Alipay already reports paid',async kind=>{
    const f=fixture(),id=await f.create();if(kind==='reopen')await f.action(id,'close');f.query.mockResolvedValue(paid(id));
    const result=await f.action(id,kind);expect(result.order.status).toBe('PAID');expect(result.checkoutUrl).toBeUndefined();expect(f.close).not.toHaveBeenCalled();
    const event=await f.store.readJson<Delivery>(`events/evt_${id}.json`);expect(event?.event.data).toMatchObject({orderId:id,productOrderId:'purchase-1',amount:'9.90'});
    expect(f.store.commits.at(-1)).toEqual(expect.arrayContaining([`orders/${id}.json`,`events/evt_${id}.json`,'system/queue.json']));expect(f.store.commits.at(-1)?.some(path=>path.startsWith('order-actions/'))).toBe(true);
  });
  it('requeries when close loses the race with payment and records the verified result',async()=>{
    const f=fixture(),id=await f.create();f.query.mockResolvedValueOnce(waiting(id)).mockResolvedValueOnce(paid(id));f.close.mockRejectedValue(new Error('racing close'));
    expect((await f.action(id,'close')).order.status).toBe('PAID');expect(f.query).toHaveBeenCalledTimes(2);
  });
  it('does not manufacture a payment record from null, WAIT_BUYER_PAY or TRADE_CLOSED',async()=>{
    const f=fixture(),id=await f.create();await f.action(id,'close');
    for(const trade of [null,waiting(id),{...waiting(id),tradeStatus:'TRADE_CLOSED'}]){f.query.mockResolvedValue(trade);expect((await f.action(id,'reconcile')).order.status).toBe('CLOSED');}
    expect(await f.store.readJson(`events/evt_${id}.json`)).toBeNull();
  });
  it('resolves new attempt notifications to the original logical order and ignores old closed notifications',async()=>{
    const f=fixture(),id=await f.create();await f.action(id,'close');const next=(await f.action(id,'reopen')).order.activeAttempt.id;
    await f.service.applyTrade({...waiting(id),tradeStatus:'TRADE_CLOSED'});expect((await f.service.order(id)).status).toBe('PENDING');
    const result=await f.service.notification({sign_type:'RSA2',app_id:f.env.ALIPAY_APP_ID,seller_id:f.env.ALIPAY_SELLER_ID,out_trade_no:next,trade_no:paid(next).tradeNo,trade_status:'TRADE_SUCCESS',total_amount:'9.90',gmt_payment:'2026-10-19 12:00:00'});
    expect(result).toMatchObject({id,status:'PAID'});expect(await f.store.readJson(`orders/${next}.json`)).toBeNull();expect(await f.store.readJson(`events/evt_${next}.json`)).toBeNull();expect(await f.store.readJson(`events/evt_${id}.json`)).not.toBeNull();
  });
  it('retains a late old-attempt payment after reopen and records a distinct additional payment without a second entitlement',async()=>{
    const f=fixture(),id=await f.create();await f.action(id,'close');const next=(await f.action(id,'reopen')).order.activeAttempt.id;
    await f.service.applyTrade(paid(id));const event=await f.store.readJson(`events/evt_${id}.json`);
    const extraTrade='2026101922001400000000000001';f.setNow(START+120_000);
    const data={sign_type:'RSA2',app_id:f.env.ALIPAY_APP_ID,seller_id:f.env.ALIPAY_SELLER_ID,out_trade_no:next,trade_no:extraTrade,trade_status:'TRADE_SUCCESS',total_amount:'9.90',gmt_payment:'2026-10-19 12:01:00'};
    await Promise.all([f.service.notification(data),f.service.notification(data)]);
    expect(await f.store.readJson(`events/evt_${id}.json`)).toEqual(event);
    expect((await f.service.adminDetail(id)).order.duplicatePayments).toEqual([{attemptId:next,tradeNo:extraTrade,amount:'9.90',paidAt:new Date(START+60_000).toISOString()}]);
    const total=await f.store.readJson<{paidCount:number;paidAmountCents:number}>('reporting/v1/live/summary/all/total.json');expect(total).toMatchObject({paidCount:2,paidAmountCents:1980});
  });
  it('durably queues closure of a still-issued new attempt when an old attempt pays late',async()=>{
    const f=fixture(),id=await f.create();await f.action(id,'close');const next=(await f.action(id,'reopen')).order.activeAttempt.id;await f.service.preparePayment(id);
    await f.service.applyTrade(paid(id));expect((await f.service.adminDetail(id)).order).toMatchObject({status:'PAID',cleanupPending:true,mayStillPayUntil:new Date(START+600_000).toISOString()});
    expect((await f.store.readJson<WorkQueue>('system/queue.json'))?.orders).toEqual([id]);f.query.mockResolvedValue(waiting(next));f.close.mockRejectedValueOnce(new Error('temporary close failure'));
    const commits=f.store.commits.length;await f.service.maintenance([]);expect(f.store.commits).toHaveLength(commits);expect((await f.store.readJson<WorkQueue>('system/queue.json'))?.orders).toEqual([id]);
    await f.service.maintenance([]);expect((await f.service.adminDetail(id)).order.cleanupPending).toBe(false);expect((await f.store.readJson<WorkQueue>('system/queue.json'))?.orders).toEqual([]);expect((await f.service.order(id)).paymentAttempts?.find(attempt=>attempt.id===next)).toMatchObject({status:'CLOSED',closeConfirmed:true});
  });
  it('checks an uncreated extra signed URL without repeated commits and closes cleanup only after its real deadline',async()=>{
    const f=fixture(),id=await f.create();await f.action(id,'close');await f.action(id,'reopen');await f.service.preparePayment(id);await f.service.applyTrade(paid(id));
    await f.service.refresh(id);const commits=f.store.commits.length;await f.service.refresh(id);expect(f.store.commits).toHaveLength(commits);expect((await f.service.adminDetail(id)).order.cleanupPending).toBe(true);
    f.setNow(START+600_000);await f.service.refresh(id);expect((await f.service.adminDetail(id)).order.cleanupPending).toBe(false);expect((await f.store.readJson<WorkQueue>('system/queue.json'))?.orders).toEqual([]);
  });
  it('commits a proven payment even if closing another attempt fails during manual reconciliation',async()=>{
    const f=fixture(),id=await f.create();await f.action(id,'close');const next=(await f.action(id,'reopen')).order.activeAttempt.id;await f.service.preparePayment(id);
    f.query.mockImplementation(async provider=>provider===id?paid(id):waiting(next));f.close.mockRejectedValue(new Error('close unavailable'));
    const result=await f.action(id,'reconcile');expect(result.order).toMatchObject({status:'PAID',cleanupPending:true});expect(result.audit[0].status).toBe('completed');expect(await f.store.readJson(`events/evt_${id}.json`)).not.toBeNull();expect((await f.store.readJson<WorkQueue>('system/queue.json'))?.orders).toEqual([id]);
  });
  it('retains payment first discovered by a close-race requery even if closing a second attempt fails',async()=>{
    const f=fixture(),id=await f.create();await f.action(id,'close');const next=(await f.action(id,'reopen')).order.activeAttempt.id;await f.service.preparePayment(id);
    const current=await f.service.order(id);current.paymentAttempts![0].closeConfirmed=false;current.paymentAttempts![0].linkIssuedAt=new Date(START).toISOString();current.paymentAttempts![0].linkExpiresAt=new Date(START+600_000).toISOString();f.store.data.set(`orders/${id}.json`,current);
    let oldQueries=0;f.query.mockImplementation(async provider=>provider===id&&++oldQueries>1?paid(id):waiting(provider));f.close.mockRejectedValue(new Error('close race or outage'));
    const result=await f.action(id,'close');expect(result.order).toMatchObject({status:'PAID',cleanupPending:true});expect(await f.store.readJson(`events/evt_${id}.json`)).not.toBeNull();
  });
  it.each([{totalAmount:'0.01'},{sellerId:'2088999999999999'},{outTradeNo:'pay_'+ 'f'.repeat(32)}])('rejects provider data that does not match the original purchase: %j',async changed=>{
    const f=fixture(),id=await f.create();f.query.mockResolvedValue({...paid(id),...changed});await expect(f.action(id,'close')).rejects.toMatchObject({code:'PAYMENT_MISMATCH'});expect((await f.service.order(id)).status).toBe('PENDING');expect(f.close).not.toHaveBeenCalled();
  });
});

describe('signed-link safety, failed provider requests and serialized administrator actions',()=>{
  it('warns about an issued but uncreated signed URL and disallows reopen until its deadline',async()=>{
    const f=fixture(),id=await f.create();await f.service.preparePayment(id);const result=await f.action(id,'close');
    expect(result.order.mayStillPayUntil).toBe(new Date(START+600_000).toISOString());expect(result.actions.reopen).toBe(false);
    await expect(f.action(id,'reopen')).rejects.toMatchObject({code:'ORDER_REOPEN_UNSAFE'});f.setNow(START+600_000);expect((await f.action(id,'reopen')).order.status).toBe('PENDING');
  });
  it('preserves the thirty-minute validity of a legacy URL even when local orders now expire at ten minutes',async()=>{
    const f=fixture(),id=await f.create(),order=await f.service.order(id);delete order.attemptTrackingVersion;order.expiresAt=new Date(START+1800_000).toISOString();f.store.data.set(`orders/${id}.json`,order);f.setNow(START+660_000);
    expect((await f.action(id,'close')).order.mayStillPayUntil).toBe(order.expiresAt);await expect(f.action(id,'reopen')).rejects.toMatchObject({code:'ORDER_REOPEN_UNSAFE'});
    f.setNow(START+1800_000);expect((await f.action(id,'reopen')).order.status).toBe('PENDING');
  });
  it('permits immediate reopen after Alipay confirmed closure of an existing signed-link trade',async()=>{
    const f=fixture(),id=await f.create();await f.service.preparePayment(id);f.query.mockResolvedValue(waiting(id));await f.action(id,'close');f.query.mockResolvedValue({...waiting(id),tradeStatus:'TRADE_CLOSED'});expect((await f.action(id,'reopen')).order.status).toBe('PENDING');
  });
  it('keeps an order pending on query or uncertain-close failure and retains a sanitized failure audit',async()=>{
    const f=fixture(),id=await f.create();f.query.mockRejectedValueOnce(new Error('secret-provider-request'));
    await expect(f.action(id,'close')).rejects.toThrow('secret-provider-request');expect((await f.service.order(id)).status).toBe('PENDING');expect((await f.service.adminDetail(id)).audit[0]).toMatchObject({status:'failed',errorCode:'PROVIDER_OR_STORAGE_ERROR'});
    expect(JSON.stringify((await f.service.adminDetail(id)).audit)).not.toContain('secret-provider-request');
    f.query.mockResolvedValue(waiting(id));f.close.mockRejectedValueOnce(new Error('close failed'));await expect(f.action(id,'close')).rejects.toThrow('close failed');expect((await f.service.order(id)).status).toBe('PENDING');expect((await f.service.order(id)).adminOperation).toBeUndefined();
  });
  it('rejects a stale version without any provider request and a replayed key cannot issue a second reopen',async()=>{
    const f=fixture(),id=await f.create(),stale=(await f.service.adminDetail(id)).version;await f.service.preparePayment(id);
    await expect(f.action(id,'close',{version:stale})).rejects.toMatchObject({code:'ORDER_VERSION_CONFLICT'});expect(f.query).not.toHaveBeenCalled();
    f.query.mockResolvedValue(waiting(id));await f.action(id,'close');f.query.mockResolvedValue({...waiting(id),tradeStatus:'TRADE_CLOSED'});
    const version=(await f.service.adminDetail(id)).version,requestId='reopen_once_1',first=await f.action(id,'reopen',{version,requestId});const calls=f.query.mock.calls.length;
    f.env.PAYMENT_ENABLED='false';const replay=await f.action(id,'reopen',{version,requestId});expect(replay.order.activeAttempt.id).toBe(first.order.activeAttempt.id);expect(f.query).toHaveBeenCalledTimes(calls);
    await expect(f.action(id,'reopen',{version,requestId,reason:'Different operation'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  it('serializes manual actions with link issuance while allowing a concurrent genuine payment notification',async()=>{
    const f=fixture(),id=await f.create();let release!:(trade:Trade|null)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    f.query.mockImplementationOnce(()=>{entered();return new Promise(resolve=>{release=resolve;});});
    const closing=f.action(id,'close');await started;
    await expect(f.service.preparePayment(id)).rejects.toMatchObject({code:'ORDER_OPERATION_IN_PROGRESS'});await expect(f.action(id,'reconcile')).rejects.toMatchObject({code:'ORDER_OPERATION_IN_PROGRESS'});
    await f.service.applyTrade(paid(id));release(null);expect((await closing).order.status).toBe('PAID');expect((await f.service.order(id)).adminOperation).toBeUndefined();
  });
  it('lets an administrator recover an expired operation lease with a visible interruption audit',async()=>{
    const f=fixture(),id=await f.create(),order=await f.service.order(id),requestId='expired_request_1';
    order.adminOperation={requestId,token:'expired-token',action:'close',expiresAt:new Date(START-1).toISOString()};order.recentActionIds=[requestId];f.store.data.set(`orders/${id}.json`,order);
    f.store.data.set(`order-actions/${id}/${sha256(requestId)}.json`,{requestId,action:'close',actor:'previous-admin',reason:'Old request',fingerprint:'x',startedAt:new Date(START-180_000).toISOString(),status:'running',beforeStatus:'PENDING'});
    expect((await f.service.adminDetail(id)).actions.reconcile).toBe(true);const result=await f.action(id,'reconcile');expect(result.audit.find(record=>record.requestId===requestId)).toMatchObject({status:'failed',errorCode:'OPERATION_EXPIRED'});expect((await f.service.order(id)).adminOperation).toBeUndefined();
  });
  it('preserves verified payment from a superseded operation without publishing its stale control action',async()=>{
    const f=fixture(),id=await f.create();let release!:(trade:Trade|null)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    f.query.mockImplementationOnce(()=>{entered();return new Promise(resolve=>{release=resolve;});});
    const first=f.action(id,'close',{requestId:'stale_operation_1'});await started;f.setNow(START+121_000);
    const replacement=await f.action(id,'reconcile');expect(replacement.order.status).toBe('PENDING');release(paid(id));
    expect((await first).order.status).toBe('PAID');expect(await f.store.readJson(`events/evt_${id}.json`)).not.toBeNull();expect((await f.service.adminDetail(id)).audit.find(record=>record.requestId==='stale_operation_1')).toMatchObject({status:'failed',errorCode:'OPERATION_EXPIRED',afterStatus:'PAID'});
  });
  it('uses the reopened attempt for refresh and automatically closes its own fresh deadline',async()=>{
    const f=fixture(),id=await f.create();await f.action(id,'close');f.setNow(START+60_000);const next=(await f.action(id,'reopen')).order.activeAttempt.id;f.query.mockClear();f.setNow(START+660_000);
    expect((await f.service.refresh(id)).status).toBe('CLOSED');expect(f.query).toHaveBeenCalledExactlyOnceWith(next);
  });
  it('never exposes the product return URL, request hash or temporary operation token in admin details',async()=>{
    const f=fixture(),id=await f.create();await f.action(id,'close');const detail=await f.service.adminDetail(id),serialized=JSON.stringify(detail);
    expect(serialized).not.toContain('https://product.example.com/return');expect(serialized).not.toContain('requestHash');expect(serialized).not.toContain('fingerprint');expect(serialized).not.toContain('token');
  });
});
