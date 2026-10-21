import {describe,it,expect,vi} from 'vitest';
import {Payments,type Gateway} from '../src/payments';
import {Reporting,indexOrder,REPORTING_LIMITS} from '../src/reporting';
import type {Env,Order,ProductClient,Store,StoreSnapshot,Transaction} from '../src/types';

const START=Date.UTC(2026,9,13,8);
const clone=<T>(value:T):T=>structuredClone(value);
class MemoryStore implements Store {
  data=new Map<string,unknown>();commits:string[][]=[];tail:Promise<void>=Promise.resolve();
  async readJson<T>(path:string):Promise<T|null>{await this.tail;return clone((this.data.get(path)??null) as T|null);}
  async openSnapshot():Promise<StoreSnapshot>{await this.tail;const values=clone(this.data);return {revision:String(this.commits.length),listJsonPaths:prefix=>[...values.keys()].filter(path=>path.startsWith(prefix)&&path.endsWith('.json')).sort(),readJson:async<T>(path:string)=>clone((values.get(path)??null) as T|null)};}
  transaction<T>(callback:(tx:Transaction)=>Promise<T>):Promise<T>{
    const result=this.tail.then(async()=>{const writes=new Map<string,unknown>();const tx:Transaction={read:async<T>(path:string)=>clone((writes.has(path)?writes.get(path):this.data.get(path)??null) as T|null),put:(path,value)=>writes.set(path,clone(value))};const result=await callback(tx);if(writes.size){for(const [path,value] of writes)this.data.set(path,value);this.commits.push([...writes.keys()]);}return result;});this.tail=result.then(()=>{},()=>{});return result;
  }
}
const client:ProductClient={id:'brclio',name:'Brclio',apiSecret:'a'.repeat(40),webhookSecret:'b'.repeat(40),webhookUrl:'https://brclio.com/api/payment',returnOrigins:['https://brclio.com'],skus:{pro:{subject:'Pro',amount:'9.90'}}};
function fixture(store=new MemoryStore(),mode:Order['mode']='live'){
  let now=START;
  const env={PAYMENT_MODE:mode,PAY_BASE_URL:'https://pay.bornforthis.cn',ALIPAY_CHANNELS:'page',ALIPAY_SELLER_ID:'2088000000000000',CHECKOUT_SECRET:'c'.repeat(40)} as Env;
  const gateway:Gateway={query:async()=>null,close:async()=>{},verifyNotification:()=>true,paymentUrl:()=>''};
  const send=vi.fn(async()=>new Response(null,{status:204}));
  const payments=new Payments(env,store,gateway,()=>now,send as typeof fetch),report=new Reporting(store,mode,()=>now);
  const create=(productOrderId='business-1',product=client)=>payments.create(product,{productOrderId,sku:'pro',returnUrl:'https://brclio.com/account'});
  const pay=(id:string,amount='9.90')=>payments.applyTrade({outTradeNo:id,tradeNo:'2026101322001400000000000001',tradeStatus:'TRADE_SUCCESS',totalAmount:amount});
  return {store,payments,report,create,pay,send,setNow:(value:number)=>{now=value;}};
}
function legacy(n:number,changes:Partial<Order>={}):Order{
  return {id:'pay_'+n.toString(16).padStart(32,'0'),mode:'live',clientId:'brclio',productOrderId:'legacy-'+n,sku:'old',subject:'Original title',amount:'0.01',status:'PAID',createdAt:new Date(START).toISOString(),expiresAt:new Date(START+30*60000).toISOString(),returnUrl:'https://brclio.com/account?private=do-not-report',requestHash:'private-request-hash',paidAt:new Date(START).toISOString(),tradeNo:'2026101322001400000000000001',fulfillmentStatus:'pending',...changes};
}
async function seed(store:MemoryStore,order:Order,indexed=false){await store.transaction(async tx=>{tx.put(`orders/${order.id}.json`,order);if(indexed)await indexOrder(tx,order);});}

describe('atomic payment reporting',()=>{
  it('coalesces creation and writes index/counters with the source order in one transaction',async()=>{
    const f=fixture();const orders=await Promise.all(Array.from({length:6},()=>f.create()));
    expect(new Set(orders.map(order=>order.id)).size).toBe(1);expect(f.store.commits).toHaveLength(1);
    expect(f.store.commits[0]).toEqual(expect.arrayContaining([`orders/${orders[0].id}.json`,'system/queue.json','reporting/v1/live/summary/all/months/2026-10.json']));
    expect(f.store.commits[0].filter(path=>path.startsWith('reporting/v1/orders/live/'))).toHaveLength(1);
    expect(await f.report.summary({month:'2026-10'})).toMatchObject({pendingCount:1,paidCount:0,paidAmountCents:0,coverage:{complete:true,sourceOrders:1,indexedOrders:1}});
  });
  it('uses Shanghai payment confirmation month and atomically moves pending/paid/delivery counters once',async()=>{
    const f=fixture();f.setNow(Date.UTC(2026,9,31,15,59));const {id}=await f.create();
    expect((await f.report.summary({month:'2026-10'})).pendingCount).toBe(1);
    f.setNow(Date.UTC(2026,9,31,16,1));await f.pay(String(id));await f.pay(String(id));
    expect(await f.report.summary({month:'2026-10'})).toMatchObject({pendingCount:0,paidCount:0});
    const november=await f.report.summary({month:'2026-11'});
    expect(november).toMatchObject({paidCount:1,paidAmountCents:990,deliveryPendingCount:1,allTime:{paidCount:1,paidAmountCents:990}});
    expect(november.daily[0]).toEqual({date:'2026-11-01',paidCount:1,paidAmountCents:990});
    const paidCommit=f.store.commits[1];expect(paidCommit).toEqual(expect.arrayContaining([`orders/${id}.json`,`events/evt_${id}.json`,'reporting/v1/live/summary/all/months/2026-10.json','reporting/v1/live/summary/all/months/2026-11.json','reporting/v1/live/summary/all/total.json']));
    expect(f.store.commits).toHaveLength(2);
    await f.payments.deliver(`evt_${id}`,client);
    expect(await f.report.summary({month:'2026-11'})).toMatchObject({deliveryPendingCount:0,paidCount:1,paidAmountCents:990});
    expect((await f.report.orders({month:'2026-10',status:'PAID'})).items[0]).toMatchObject({id,status:'PAID',fulfillmentStatus:'delivered'});
    expect((await f.report.orders({month:'2026-11'})).items).toEqual([]);
  });
  it('counts closed then late confirmed payment without downgrading or double counting',async()=>{
    const f=fixture();const {id}=await f.create();
    await f.payments.applyTrade({outTradeNo:String(id),tradeNo:'',tradeStatus:'TRADE_CLOSED',totalAmount:'9.90'});
    expect(await f.report.summary({month:'2026-10'})).toMatchObject({pendingCount:0,closedCount:1,paidCount:0});
    await f.pay(String(id));await f.payments.applyTrade({outTradeNo:String(id),tradeNo:'2026101322001400000000000001',tradeStatus:'TRADE_CLOSED',totalAmount:'9.90'});
    expect(await f.report.summary({month:'2026-10'})).toMatchObject({pendingCount:0,closedCount:0,paidCount:1,paidAmountCents:990});
  });
  it('attributes a delayed receipt to the verified Shanghai payment day and month exactly once',async()=>{
    const f=fixture();f.setNow(Date.UTC(2026,9,31,15,50));const {id}=await f.create();
    const paidAt='2026-10-31T15:59:00.000Z';f.setNow(Date.UTC(2026,9,31,16,1));
    const trade={outTradeNo:String(id),tradeNo:'2026101322001400000000000001',tradeStatus:'TRADE_SUCCESS',totalAmount:'9.90',paidAt};
    await f.payments.applyTrade(trade);
    await f.payments.applyTrade({...trade,paidAt:'2026-10-31T16:01:00.000Z'});
    const october=await f.report.summary({month:'2026-10'});
    expect(october).toMatchObject({pendingCount:0,paidCount:1,paidAmountCents:990,allTime:{paidCount:1,paidAmountCents:990}});
    expect(october.daily[30]).toEqual({date:'2026-10-31',paidCount:1,paidAmountCents:990});
    expect(await f.report.summary({month:'2026-11'})).toMatchObject({paidCount:0,paidAmountCents:0});
    expect(await f.payments.order(String(id))).toMatchObject({paidAt});expect(f.store.commits).toHaveLength(2);
    expect(await f.store.readJson(`events/evt_${id}.json`)).toMatchObject({event:{createdAt:'2026-10-31T16:01:00.000Z',data:{paidAt}}});
  });
  it('keeps original paid amounts after catalog repricing and adds money in integer cents',async()=>{
    const f=fixture();const cheap={...client,skus:{pro:{subject:'Old',amount:'0.01'}}},expensive={...client,skus:{pro:{subject:'New',amount:'999999.99'}}};
    const old=await f.create('old',cheap);await f.pay(String(old.id),'0.01');
    const fresh=await f.create('new',expensive);await f.pay(String(fresh.id),'999999.99');
    expect(await f.report.summary({month:'2026-10'})).toMatchObject({paidCount:2,paidAmountCents:100_000_000,allTime:{paidCount:2,paidAmountCents:100_000_000}});
    expect((await f.report.orders()).items.find(order=>order.id===old.id)).toMatchObject({amount:'0.01',amountCents:1,subject:'Old'});
    expect((await f.payments.order(String(old.id))).amount).toBe('0.01');
  });
  it('isolates live/sandbox and individual clients even in a mixed fixture ledger',async()=>{
    const store=new MemoryStore(),live=fixture(store),sandbox=fixture(store,'sandbox');
    const one=await live.create('live');await live.pay(String(one.id));
    const two=await sandbox.create('sandbox');await sandbox.pay(String(two.id));
    const other={...client,id:'another',name:'Another'};const three=await live.create('other',other);await live.pay(String(three.id));
    expect(await live.report.summary({month:'2026-10'})).toMatchObject({paidCount:2,paidAmountCents:1980,coverage:{complete:true,sourceOrders:3}});
    expect(await live.report.summary({month:'2026-10',clientId:'brclio'})).toMatchObject({paidCount:1,allTime:{paidCount:1,paidAmountCents:990}});
    expect(await sandbox.report.summary({month:'2026-10'})).toMatchObject({paidCount:1,paidAmountCents:990});
    expect((await live.report.orders()).items.every(order=>order.mode==='live')).toBe(true);
    expect((await sandbox.report.orders()).items).toHaveLength(1);
  });
  it('rolls back order/outbox when counter integrity fails rather than committing partial reports',async()=>{
    const f=fixture();const {id}=await f.create();const path='reporting/v1/live/summary/all/months/2026-10.json';
    const before=await f.store.readJson<Record<string,unknown>>(path);f.store.data.set(path,{...before,pendingCount:0});
    await expect(f.pay(String(id))).rejects.toMatchObject({code:'REPORTING_INTEGRITY'});
    expect((await f.payments.order(String(id))).status).toBe('PENDING');expect([...f.store.data.keys()].filter(path=>path.startsWith('events/'))).toEqual([]);
  });
  it('counts distinct additional receipts on their Shanghai payment dates while keeping one original-price order',async()=>{
    const f=fixture(),extra={attemptId:'pay_'+'e'.repeat(32),tradeNo:'2026101922001400000000000002',paidAt:'2026-10-31T16:01:00.000Z',amount:'9.90'};
    const order=legacy(20,{amount:'9.90',paidAt:'2026-10-31T15:59:00.000Z',duplicatePayments:[extra]});
    await seed(f.store,order,true);
    const october=await f.report.summary({month:'2026-10'}),november=await f.report.summary({month:'2026-11'});
    expect(october).toMatchObject({paidCount:1,paidAmountCents:990,deliveryPendingCount:1,allTime:{paidCount:2,paidAmountCents:1980}});
    expect(october.daily[30]).toMatchObject({date:'2026-10-31',paidCount:1,paidAmountCents:990});
    expect(november).toMatchObject({paidCount:1,paidAmountCents:990,deliveryPendingCount:0,allTime:{paidCount:2,paidAmountCents:1980}});
    expect(november.daily[0]).toMatchObject({date:'2026-11-01',paidCount:1,paidAmountCents:990});
    const rows=(await f.report.orders()).items;expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({amount:'9.90',amountCents:990,duplicatePayments:[extra]});
    const commits=f.store.commits.length;await f.store.transaction(tx=>indexOrder(tx,order));expect(f.store.commits).toHaveLength(commits);
    expect(await new Reporting(f.store,'sandbox').summary({month:'2026-11'})).toMatchObject({paidCount:0,paidAmountCents:0});
  });
  it.each(['delete','change-date','change-amount'])('rejects attempts to %s an already indexed additional receipt without changing the ledger',async change=>{
    const f=fixture(),extra={attemptId:'pay_'+'e'.repeat(32),tradeNo:'2026101922001400000000000002',paidAt:new Date(START).toISOString(),amount:'9.90'};
    const order=legacy(21,{amount:'9.90',duplicatePayments:[extra]});await seed(f.store,order,true);
    const after={...order,duplicatePayments:change==='delete'?[]:[{...extra,...(change==='change-date'?{paidAt:new Date(START+60000).toISOString()}:{amount:'0.01'})}]};
    await expect(seed(f.store,after,true)).rejects.toMatchObject({code:'REPORTING_INTEGRITY'});
    expect(await f.store.readJson(`orders/${order.id}.json`)).toEqual(order);
    expect(await f.report.summary({month:'2026-10'})).toMatchObject({paidCount:2,paidAmountCents:1980});
  });
  it('rejects duplicated transaction identities in additional receipt data',async()=>{
    const f=fixture(),extra={attemptId:'pay_'+'e'.repeat(32),tradeNo:'2026101322001400000000000001',paidAt:new Date(START).toISOString(),amount:'0.01'};
    await expect(seed(f.store,legacy(22,{duplicatePayments:[extra]}),true)).rejects.toMatchObject({code:'REPORTING_INTEGRITY'});
    expect(f.store.data.size).toBe(0);
  });
});

describe('historical coverage and resumable rebuild',()=>{
  it('reports missing legacy records then rebuilds idempotently without altering orders/events',async()=>{
    const store=new MemoryStore(),f=fixture(store);const a=legacy(1,{paidAt:'2026-09-30T15:00:00.000Z'}),b=legacy(2,{status:'CLOSED',paidAt:undefined,tradeNo:undefined}),c=legacy(3,{mode:'sandbox',amount:'7.50'});
    await seed(store,a);await seed(store,b);await seed(store,c);const original=[...store.data].filter(([path])=>path.startsWith('orders/'));
    expect(await f.report.summary({month:'2026-10'})).toMatchObject({paidCount:0,coverage:{complete:false,sourceOrders:3,indexedOrders:0,missingOrders:3}});
    let cursor:string|undefined;const processed:number[]=[];
    do {const result=await f.report.rebuild({limit:1,cursor});processed.push(result.processed);cursor=result.nextCursor??undefined;}while(cursor);
    expect(processed).toEqual([1,1,1]);expect([...store.data].filter(([path])=>path.startsWith('orders/'))).toEqual(original);
    expect([...store.data.keys()].some(path=>path.startsWith('events/'))).toBe(false);
    expect(await f.report.summary({month:'2026-10'})).toMatchObject({paidCount:0,closedCount:1,allTime:{paidCount:1,paidAmountCents:1},coverage:{complete:true,missingOrders:0}});
    expect(await f.report.summary({month:'2026-09'})).toMatchObject({paidCount:1,paidAmountCents:1});
    expect(await new Reporting(store,'sandbox').summary({month:'2026-10'})).toMatchObject({paidCount:1,paidAmountCents:750});
    const commits=store.commits.length;expect(await f.report.rebuild()).toMatchObject({processed:0,scanned:0,nextCursor:null});expect(store.commits.length).toBe(commits);
  });
  it('coalesces competing rebuilds and payment creation without lost or duplicate totals',async()=>{
    const f=fixture();await seed(f.store,legacy(10));await seed(f.store,legacy(11));
    await Promise.all([f.report.rebuild({limit:1}),f.report.rebuild({limit:1}),f.create('concurrent')]);
    await f.report.rebuild();expect(await f.report.summary({month:'2026-10'})).toMatchObject({paidCount:2,paidAmountCents:2,pendingCount:1,coverage:{complete:true,sourceOrders:3}});
  });
  it('fails closed if immutable listing is unavailable, never claims an empty complete history',async()=>{
    const f=fixture();await expect(new Reporting({readJson:f.store.readJson.bind(f.store),transaction:f.store.transaction.bind(f.store)},'live').summary({month:'2026-10'})).rejects.toMatchObject({code:'REPORTING_UNAVAILABLE'});
  });
});

describe('bounded administrator order pages',()=>{
  it('paginates newest creation first with filter-bound, credential-free cursors and safe projections',async()=>{
    const store=new MemoryStore(),report=new Reporting(store,'live');
    for(let n=1;n<=4;n++)await seed(store,legacy(n,{createdAt:new Date(START+n*1000).toISOString()}),true);
    const index=[...store.data.keys()].find(path=>path.startsWith('reporting/v1/orders/')&&path.endsWith(legacy(4).id+'.json'))!;
    const stored=store.data.get(index) as {order:Record<string,unknown>};stored.order.accidentalSecret='must-never-escape';
    const first=await report.orders({status:'PAID',limit:2});expect(first.items.map(order=>order.productOrderId)).toEqual(['legacy-4','legacy-3']);expect(first.nextCursor).toBeTypeOf('string');
    const second=await report.orders({status:'PAID',limit:2,cursor:first.nextCursor!});expect(second.items.map(order=>order.productOrderId)).toEqual(['legacy-2','legacy-1']);expect(second.nextCursor).toBeNull();
    const text=JSON.stringify(first);expect(text).not.toContain('private-request-hash');expect(text).not.toContain('do-not-report');expect(text).not.toContain('returnUrl');expect(text).not.toContain('must-never-escape');
    const cursorBody=Buffer.from(first.nextCursor!,'base64url').toString();expect(cursorBody).not.toContain(client.apiSecret);expect(cursorBody).not.toContain(client.webhookSecret);
    await expect(report.orders({status:'CLOSED',limit:2,cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_CURSOR'});
  });
  it('caps selective filter reads and returns a continuation even for an empty page',async()=>{
    const store=new MemoryStore(),report=new Reporting(store,'live');
    await seed(store,legacy(1,{createdAt:new Date(START).toISOString()}),true);
    for(let n=2;n<=43;n++)await seed(store,legacy(n,{status:'CLOSED',paidAt:undefined,tradeNo:undefined,createdAt:new Date(START+n*1000).toISOString()}),true);
    const first=await report.orders({status:'PAID'});expect(first.items).toEqual([]);expect(first.nextCursor).toBeTypeOf('string');
    const second=await report.orders({status:'PAID',cursor:first.nextCursor!});expect(second.items.map(order=>order.id)).toEqual([legacy(1).id]);expect(second.nextCursor).toBeNull();
    expect(REPORTING_LIMITS.scan).toBe(40);
  });
  it('validates selectors before storage reads and never accepts path traversal',async()=>{
    const f=fixture(),spy=vi.spyOn(f.store,'openSnapshot');
    await expect(f.report.summary({month:'2026-13'})).rejects.toMatchObject({code:'INVALID_MONTH'});
    await expect(f.report.summary({month:'2026-10',clientId:'../secret'})).rejects.toMatchObject({code:'INVALID_CLIENT_ID'});
    await expect(f.report.orders({limit:26})).rejects.toMatchObject({code:'INVALID_LIMIT'});
    await expect(f.report.orders({cursor:'not+valid'})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    await expect(f.report.rebuild({limit:6})).rejects.toMatchObject({code:'INVALID_LIMIT'});expect(spy).not.toHaveBeenCalled();
  });
});
