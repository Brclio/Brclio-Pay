import {beforeAll,describe,expect,it,vi} from 'vitest';
import {createHmac,pbkdf2Sync} from 'node:crypto';
import {Reporting,indexOrder} from '../src/reporting';
import {adminLogin} from '../src/admin-auth';
import {handleAdmin} from '../src/admin';
import {PartitionedStore} from '../src/partitioned-store';
import type {Env,Order,Store,StoreSnapshot,Transaction} from '../src/types';

class MemoryStore implements Store {
  data=new Map<string,unknown>();revision=0;writes=0;
  async readJson<T>(path:string):Promise<T|null>{return structuredClone((this.data.get(path)??null) as T|null);}
  async openSnapshot():Promise<StoreSnapshot>{
    const data=structuredClone(this.data),revision=String(this.revision);
    return {revision,listJsonPaths:prefix=>[...data.keys()].filter(path=>path.startsWith(prefix)&&path.endsWith('.json')).sort(),
      readJson:async<T>(path:string)=>structuredClone((data.get(path)??null) as T|null)};
  }
  async transaction<T>(callback:(tx:Transaction)=>Promise<T>):Promise<T>{
    const data=structuredClone(this.data),writes=new Set<string>();
    const value=await callback({read:async<T>(path:string)=>structuredClone((data.get(path)??null) as T|null),put:(path,value)=>{data.set(path,structuredClone(value));writes.add(path);}});
    if(writes.size){this.data=data;this.revision++;this.writes+=writes.size;}return value;
  }
}
const id=(n:number)=>'pay_'+n.toString(16).padStart(32,'0');
function order(n:number,changes:Partial<Order>={}):Order{
  return {id:id(n),mode:'live',clientId:'fixture-product',productOrderId:'business-'+n,sku:'monthly',subject:'Original subscription',amount:'9.90',
    status:'PAID',createdAt:'2026-09-15T10:00:00.000Z',expiresAt:'2026-09-15T10:10:00.000Z',paidAt:'2026-10-12T10:00:00.000Z',
    tradeNo:'2026101200000000000000'+String(n).padStart(6,'0'),fulfillmentStatus:'delivered',returnUrl:'https://private.example/account?session=hidden',requestHash:'private-request-hash',...changes};
}
async function seed(store:Store,value:Order,indexed=false){await store.transaction(async tx=>{tx.put(`orders/${value.id}.json`,value);if(indexed)await indexOrder(tx,value);});}
const BILL={provider:'alipay' as const,month:'2026-10'};

describe('complete provider confirmed receipt bills',()=>{
  it('returns canonical historical receipts without requiring indexes, isolates provider/mode/client and never writes',async()=>{
    const physical=new MemoryStore(),store=new PartitionedStore(physical);
    await seed(store,order(1));await seed(store,order(2,{provider:'wechat',amount:'3.01'}));
    await seed(store,order(3,{provider:'wechat',mode:'sandbox'}));await seed(store,order(4,{clientId:'another-product',amount:'0.01'}));
    await seed(store,order(5,{status:'PENDING',paidAt:undefined,tradeNo:undefined}));await seed(store,order(6,{status:'CLOSED',paidAt:undefined,tradeNo:undefined}));
    const before=structuredClone(physical.data),writes=physical.writes,report=new Reporting(store,'live');
    expect(await report.bills(BILL)).toMatchObject({provider:'alipay',paidCount:2,paidAmountCents:991,currency:'CNY',basis:'payment-confirmed',timezone:'Asia/Shanghai',
      coverage:{source:'canonical',complete:true,sourceOrders:6,scannedOrders:6}});
    expect(await report.bills({...BILL,clientId:'fixture-product'})).toMatchObject({paidCount:1,paidAmountCents:990});
    expect(await report.bills({...BILL,provider:'wechat'})).toMatchObject({paidCount:1,paidAmountCents:301});
    expect(await new Reporting(store,'sandbox').bills({...BILL,provider:'wechat'})).toMatchObject({paidCount:1,paidAmountCents:990});
    const text=JSON.stringify(await report.bills(BILL));for(const forbidden of ['returnUrl','requestHash','private.example','private-request-hash'])expect(text).not.toContain(forbidden);
    expect(physical.data).toEqual(before);expect(physical.writes).toBe(writes);
  });
  it('includes each verified extra receipt on its own Shanghai payment month even when primary was in a different month',async()=>{
    const store=new MemoryStore(),primary=id(100),extra1=id(101),extra2=id(102);
    const value=order(1,{paidAt:'2026-10-31T15:59:59.000Z',paymentAttempts:[{id:primary,createdAt:'2026-10-01T00:00:00.000Z',expiresAt:'2026-10-01T00:10:00.000Z',status:'PAID',tradeNo:order(1).tradeNo}],
      duplicatePayments:[{attemptId:extra1,tradeNo:'2026103100000000000002',amount:'9.90',paidAt:'2026-10-31T16:00:00.000Z'},
        {attemptId:extra2,tradeNo:'2026103100000000000003',amount:'9.90',paidAt:'2026-10-31T16:00:01.000Z'}]});
    await seed(store,value,true);const report=new Reporting(store,'live');
    const october=await report.bills(BILL);expect(october).toMatchObject({paidCount:1,paidAmountCents:990});
    expect(october.items[0]).toMatchObject({orderId:value.id,attemptId:primary,kind:'primary',tradeNo:value.tradeNo,amountCents:990});
    const november=await report.bills({...BILL,month:'2026-11'});expect(november).toMatchObject({paidCount:2,paidAmountCents:1980});
    expect(november.items.map(item=>item.attemptId)).toEqual([extra2,extra1]);expect(november.items.every(item=>item.kind==='duplicate')).toBe(true);
    expect((await report.orders({month:'2026-10'})).items).toEqual([]);
  });
  it('paginates paid time with stable ties and filter/revision bound cursors without losing extra receipts',async()=>{
    const store=new MemoryStore();
    for(let n=1;n<=4;n++)await seed(store,order(n,{createdAt:`2026-09-${String(20-n).padStart(2,'0')}T00:00:00.000Z`,
      ...(n===2?{duplicatePayments:[{attemptId:id(20),tradeNo:'202610120000000000000020',amount:'9.90',paidAt:'2026-10-12T10:00:00.000Z'}]}:{})}));
    const report=new Reporting(store,'live'),all=await report.bills(BILL),seen:string[]=[];let cursor:string|undefined;
    do {const page=await report.bills({...BILL,limit:2,cursor});expect(page).toMatchObject({paidCount:5,paidAmountCents:4950,revision:all.revision});
      seen.push(...page.items.map(item=>item.orderId+':'+item.tradeNo));cursor=page.nextCursor??undefined;}while(cursor);
    expect(seen).toEqual(all.items.map(item=>item.orderId+':'+item.tradeNo));expect(new Set(seen).size).toBe(5);
    const first=await report.bills({...BILL,limit:2});
    await expect(report.bills({...BILL,month:'2026-11',cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    await expect(report.bills({...BILL,provider:'wechat',cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    await expect(report.bills({...BILL,clientId:'another-product',cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    await seed(store,order(5));await expect(report.bills({...BILL,cursor:first.nextCursor!})).rejects.toMatchObject({status:409,code:'REPORTING_SNAPSHOT_CHANGED'});
  });
  it('normalizes payment offsets for chronological sorting and adds cents without floating-point drift',async()=>{
    const store=new MemoryStore();await seed(store,order(1,{paidAt:'2026-10-12T18:00:01+08:00',amount:'0.01'}));
    await seed(store,order(2,{paidAt:'2026-10-12T10:00:00.000Z',amount:'999999.99'}));
    const bills=await new Reporting(store,'live').bills(BILL);expect(bills).toMatchObject({paidCount:2,paidAmountCents:100_000_000});
    expect(bills.items.map(item=>item.orderId)).toEqual([id(1),id(2)]);
  });
  it('returns complete zeros for an empty month with a complete source snapshot',async()=>{
    const store=new MemoryStore();await seed(store,order(1));
    expect(await new Reporting(store,'live').bills({...BILL,month:'2027-01'})).toMatchObject({items:[],paidCount:0,paidAmountCents:0,nextCursor:null,coverage:{complete:true,sourceOrders:1,scannedOrders:1}});
  });
  it('keeps legacy order reporting backward compatible while accepting provider filters',async()=>{
    const store=new MemoryStore();await seed(store,order(1),true);await seed(store,order(2,{provider:'wechat'}),true);const report=new Reporting(store,'live');
    expect((await report.orders()).items).toHaveLength(2);expect((await report.orders({provider:'alipay'})).items.map(item=>item.id)).toEqual([id(1)]);
    expect((await report.orders({provider:'wechat'})).items.map(item=>item.id)).toEqual([id(2)]);
  });
  it('validates selectors before storage and rejects corrupt rows rather than returning a partial total',async()=>{
    const store=new MemoryStore(),report=new Reporting(store,'live'),snapshot=vi.spyOn(store,'openSnapshot');
    await expect(report.bills({...BILL,provider:'wechatpay' as 'wechat'})).rejects.toMatchObject({code:'INVALID_PROVIDER'});
    await expect(report.bills({...BILL,month:'2026-13'})).rejects.toMatchObject({code:'INVALID_MONTH'});
    await expect(report.bills({...BILL,clientId:'../../private'})).rejects.toMatchObject({code:'INVALID_CLIENT_ID'});
    await expect(report.bills({...BILL,limit:26})).rejects.toMatchObject({code:'INVALID_LIMIT'});expect(snapshot).not.toHaveBeenCalled();
    await seed(store,order(1));await expect(report.bills({...BILL,cursor:'invalid+cursor'})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    await seed(store,order(2,{amount:'0.00'}));await expect(report.bills(BILL)).rejects.toMatchObject({code:'REPORTING_INTEGRITY'});
  });
  it('fails closed for unavailable, incomplete, excessive, or inconsistent canonical snapshots',async()=>{
    const store=new MemoryStore();
    await expect(new Reporting({readJson:store.readJson.bind(store),transaction:store.transaction.bind(store)},'live').bills(BILL)).rejects.toMatchObject({code:'REPORTING_UNAVAILABLE'});
    vi.spyOn(store,'openSnapshot').mockRejectedValueOnce(Object.assign(new Error('Incomplete tree'),{code:'TRUNCATED_GIT_TREE'}));
    await expect(new Reporting(store,'live').bills(BILL)).rejects.toMatchObject({code:'TRUNCATED_GIT_TREE'});
    const excess=Array.from({length:20001},(_,n)=>`orders/${id(n)}.json`);
    vi.spyOn(store,'openSnapshot').mockResolvedValueOnce({revision:'1',listJsonPaths:()=>excess,readJson:async()=>null});
    await expect(new Reporting(store,'live').bills(BILL)).rejects.toMatchObject({code:'REPORTING_CAPACITY'});
    store.data.set(`orders/${id(1)}.json`,order(2));await expect(new Reporting(store,'live').bills(BILL)).rejects.toMatchObject({code:'REPORTING_INTEGRITY'});
  });
});

const BASE='https://pay.example.com',PASSWORD='Fixture-password-for-bills-only!';let env:Env,cookie:string;
function request(path:string,authenticated=true){return new Request(BASE+path,{headers:authenticated?{Cookie:cookie}:undefined});}
beforeAll(async()=>{
  const pepper='1'.repeat(64),salt='2'.repeat(64),material=createHmac('sha256',pepper).update(PASSWORD).digest('hex');
  env={PAY_BASE_URL:BASE,PAYMENT_MODE:'live',ADMIN_EMAIL:'bills@example.com',ADMIN_PASSWORD_PEPPER:pepper,
    ADMIN_PASSWORD_HASH:`pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(material,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')}`,
    ADMIN_SESSION_SECRET:'e'.repeat(64),ADMIN_LOGIN_LIMITER:{limit:async()=>({success:true})}} as unknown as Env;
  const response=await adminLogin(new Request(BASE+'/api/admin/login',{method:'POST',headers:{Origin:BASE}}),env,{email:env.ADMIN_EMAIL,password:PASSWORD});
  cookie=response.headers.get('Set-Cookie')!.split(';')[0];
});
describe('administrator receipt bill route',()=>{
  it('requires an administrator session before reading any snapshot or initializing payment gateways',async()=>{
    const store=new MemoryStore(),snapshot=vi.spyOn(store,'openSnapshot'),service=vi.fn();
    await expect(handleAdmin(request('/api/admin/reports/bills?provider=alipay&month=2026-10',false),env,store,{service})).rejects.toMatchObject({status:401});
    expect(snapshot).not.toHaveBeenCalled();expect(service).not.toHaveBeenCalled();expect(store.writes).toBe(0);
  });
  it('serves only read-only confirmed bills with the exact documented query shape',async()=>{
    const store=new MemoryStore();await seed(store,order(1));await seed(store,order(2,{provider:'wechat'}));const service=vi.fn();
    const response=await handleAdmin(request('/api/admin/reports/bills?provider=wechat&month=2026-10&clientId=fixture-product&limit=25'),env,store,{service});
    expect(await response.json()).toMatchObject({provider:'wechat',paidCount:1,paidAmountCents:990,coverage:{complete:true,source:'canonical'}});expect(service).not.toHaveBeenCalled();
    expect(store.writes).toBe(2);
  });
  it.each(['provider=wechatpay&month=2026-10','provider=alipay','month=2026-10','provider=alipay&month=2026-10&provider=wechat',
    'provider=alipay&month=2026-10&token=secret','provider=alipay&month=2026-10&limit=0','provider=alipay&month=2026-10&clientId=',
    'provider=alipay&month=2026-10&cursor='])('rejects invalid bill query: %s',async query=>{
    await expect(handleAdmin(request('/api/admin/reports/bills?'+query),env,new MemoryStore())).rejects.toMatchObject({status:400});
  });
});
