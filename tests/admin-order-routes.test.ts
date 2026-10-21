import {beforeAll,describe,expect,it,vi} from 'vitest';
import {createHash,createHmac,pbkdf2Sync} from 'node:crypto';
import {adminLogin} from '../src/admin-auth';
import {handleAdmin} from '../src/admin';
import {handle} from '../src/index';
import {Payments,type Gateway} from '../src/payments';
import {Reporting} from '../src/reporting';
import type {Env,ProductClient,Store,Transaction} from '../src/types';

const BASE='https://pay.example.com',PASSWORD='Only-an-ephemeral-route-fixture';
const client:ProductClient={id:'fixture-product',name:'Fixture product',apiSecret:'a'.repeat(64),webhookSecret:'b'.repeat(64),webhookUrl:'https://product.example.com/webhook',returnOrigins:['https://product.example.com'],skus:{pro:{subject:'Original product',amount:'9.90'}}};
class MemoryStore implements Store {
  data=new Map<string,unknown>();commits:string[][]=[];tail:Promise<unknown>=Promise.resolve();
  async readJson<T>(path:string):Promise<T|null>{await this.tail;return this.data.has(path)?structuredClone(this.data.get(path)) as T:null;}
  async openSnapshot(){await this.tail;const snapshot=structuredClone(this.data);return {revision:'fixture',listJsonPaths:(prefix:string)=>[...snapshot.keys()].filter(path=>path.startsWith(prefix)),readJson:async<T>(path:string)=>snapshot.has(path)?structuredClone(snapshot.get(path)) as T:null};}
  transaction<T>(callback:(tx:Transaction)=>Promise<T>):Promise<T>{
    const result=this.tail.then(async()=>{const next=structuredClone(this.data),writes=new Set<string>();const value=await callback({read:async<T>(path:string)=>next.has(path)?structuredClone(next.get(path)) as T:null,put:(path,value)=>{next.set(path,structuredClone(value));writes.add(path);}});if(writes.size){this.data=next;this.commits.push([...writes]);}return value;});
    this.tail=result.then(()=>undefined,()=>undefined);return result;
  }
}
function environment():Env {
  const pepper='1'.repeat(64),salt='2'.repeat(64),material=createHmac('sha256',pepper).update(PASSWORD).digest('hex');
  return {ASSETS:{fetch:async()=>new Response('Fixture')} as unknown as Fetcher,PAY_BASE_URL:BASE,PAYMENT_MODE:'live',PAYMENT_ENABLED:'true',ALIPAY_CHANNELS:'page,wap',ALIPAY_APP_ID:'2021007109602288',ALIPAY_PRIVATE_KEY:'fixture-private',ALIPAY_PUBLIC_KEY:'fixture-public',ALIPAY_SELLER_ID:'2088123456789012',GITHUB_TOKEN:'fixture-github',GITHUB_REPOSITORY:'fixture/private',GITHUB_BRANCH:'main',CHECKOUT_SECRET:'c'.repeat(64),CLIENTS_JSON:JSON.stringify([client]),REGISTRY_ENCRYPTION_KEY:'d'.repeat(64),ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD_PEPPER:pepper,ADMIN_PASSWORD_HASH:`pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(material,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')}`,ADMIN_SESSION_SECRET:'e'.repeat(64),ADMIN_LOGIN_LIMITER:{limit:async()=>({success:true})}};
}
let env:Env,cookie:string,csrf:string;
function request(path:string,{method='GET',body,authenticated=true,token=true,origin=BASE}:{method?:string;body?:unknown;authenticated?:boolean;token?:boolean;origin?:string}={}){
  return new Request(BASE+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(authenticated?{Cookie:cookie}:{}),...(token?{'X-CSRF-Token':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
beforeAll(async()=>{env=environment();const login=await adminLogin(request('/api/admin/login',{method:'POST',authenticated:false,token:false}),env,{email:env.ADMIN_EMAIL,password:PASSWORD});cookie=login.headers.get('Set-Cookie')!.split(';')[0];csrf=(await login.json() as {csrfToken:string}).csrfToken;});
async function fixture(configuration:Env=env){
  const store=new MemoryStore(),query=vi.fn<Gateway['query']>(async()=>null),close=vi.fn<Gateway['close']>(async()=>undefined),send=vi.fn(async()=>new Response('ok'));
  const payments=new Payments(configuration,store,{query,close,verifyNotification:()=>true,paymentUrl:()=> 'https://openapi.alipay.com/gateway.do'},Date.now,send as unknown as typeof fetch);
  const id=String((await payments.create(client,{productOrderId:'fixture-business-order',sku:'pro',returnUrl:'https://product.example.com/account'})).id);
  const service=vi.fn(async()=>payments),pending:Promise<unknown>[]=[];
  const call=(suffix='',input:Parameters<typeof request>[1]={})=>handleAdmin(request(`/api/admin/orders/${id}${suffix}`,input),configuration,store,{service,waitUntil:promise=>pending.push(promise)});
  const detail=async()=>await (await call()).json() as {version:string;order:{id:string;status:string};actions:{close:boolean;reopen:boolean;reconcile:boolean};audit:unknown[];checkoutUrl?:string};
  const act=async(action:string,version:string,extra:Record<string,unknown>={})=>call('/'+action,{method:'POST',body:{expectedVersion:version,requestId:'fixture_'+action+'_request',reason:'管理员测试核对',...extra}});
  return {store,payments,id,query,close,send,service,pending,call,detail,act};
}

describe('administrator order management routes',()=>{
  it.each(['','/close','/reopen','/reconcile'])('rejects anonymous %s before payment service initialization',async suffix=>{
    const f=await fixture();await expect(f.call(suffix,{method:suffix?'POST':'GET',authenticated:false,body:suffix?{}:undefined})).rejects.toMatchObject({status:401});expect(f.service).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();expect(f.store.commits).toHaveLength(1);
  });
  it.each([{token:false},{origin:'https://foreign.example'}])('rejects unauthorized order mutations before any gateway request: %j',async input=>{
    const f=await fixture();await expect(f.call('/close',{method:'POST',body:{},...input})).rejects.toMatchObject({status:403});expect(f.service).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
  it.each([{paid:true},{expectedVersion:'bad'},{requestId:'x'},{reason:''},{amount:'0.01'},{status:'PAID'}])('rejects injected or malformed parameters: %j',async extra=>{
    const f=await fixture(),d=await f.detail();f.service.mockClear();await expect(f.act('close',d.version,extra)).rejects.toMatchObject({status:400});expect(f.service).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
  });
  it('returns a fresh safe detail without writes or upstream calls',async()=>{
    const f=await fixture(),response=await f.call(),text=await response.text(),detail=JSON.parse(text);
    expect(detail).toMatchObject({order:{id:f.id,status:'PENDING',amount:'9.90'},actions:{close:true,reconcile:true},audit:[]});expect(detail.version).toMatch(/^[a-f0-9]{64}$/);
    for(const secret of [PASSWORD,env.GITHUB_TOKEN,env.ADMIN_SESSION_SECRET!,client.apiSecret,client.webhookSecret,'requestHash','returnUrl'])expect(text).not.toContain(secret);
    expect(f.query).not.toHaveBeenCalled();expect(f.store.commits).toHaveLength(1);
  });
  it('closes and reopens the same logical business order with a guarded new checkout link',async()=>{
    const f=await fixture(),initial=await f.detail();const closed=await (await f.act('close',initial.version)).json() as {version:string;order:{status:string}};
    expect(closed.order.status).toBe('CLOSED');const reopened=await (await f.act('reopen',closed.version)).json() as {order:{id:string;status:string;amount:string;productOrderId:string};checkoutUrl:string;audit:unknown[]};
    expect(reopened.order).toMatchObject({id:f.id,status:'PENDING',amount:'9.90',productOrderId:'fixture-business-order'});expect(reopened.checkoutUrl).toContain(`/checkout/${f.id}#token=`);expect(reopened.audit.length).toBeGreaterThanOrEqual(2);
  });
  it.each(['disabled-payments','disabled-client','disabled-sku'])('rejects reopening while %s',async state=>{
    const configuration={...env},f=await fixture(configuration),initial=await f.detail();await f.act('close',initial.version);
    if(state==='disabled-payments')configuration.PAYMENT_ENABLED='false';else configuration.CLIENTS_JSON=JSON.stringify([{...client,...(state==='disabled-client'?{enabled:false}:{skus:{pro:{...client.skus.pro,enabled:false}}})}]);
    const before=await f.detail();expect(before.actions.reopen).toBe(false);const calls=f.query.mock.calls.length;
    await expect(f.act('reopen',before.version)).rejects.toMatchObject({code:state==='disabled-payments'?'PAYMENTS_DISABLED':state==='disabled-client'?'CLIENT_DISABLED':'SKU_DISABLED'});expect(f.query).toHaveBeenCalledTimes(calls);
  });
  it('reconciles a genuinely paid closed order and delivers its stable product notification once',async()=>{
    const f=await fixture();await f.act('close',(await f.detail()).version);const d=await f.detail();
    f.query.mockResolvedValue({outTradeNo:f.id,tradeNo:'2026101922001400000000000001',tradeStatus:'TRADE_SUCCESS',totalAmount:'9.90',sellerId:env.ALIPAY_SELLER_ID,paidAt:new Date().toISOString()});
    const result=await (await f.act('reconcile',d.version)).json() as {order:{status:string}};expect(result.order.status).toBe('PAID');await Promise.all(f.pending);
    expect(f.send).toHaveBeenCalledTimes(1);const summary=await new Reporting(f.store,'live').summary({month:new Date(Date.now()+8*3600000).toISOString().slice(0,7)});expect(summary.paidCount).toBe(1);expect(summary.paidAmountCents).toBe(990);
    await f.act('reconcile',(await f.detail()).version,{requestId:'second_reconcile_request'});await Promise.all(f.pending);expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('keeps stale detail CAS and same-request idempotency enforced by the endpoint',async()=>{
    const f=await fixture(),initial=await f.detail();await f.act('close',initial.version);const calls=f.query.mock.calls.length;
    await f.act('close',initial.version);expect(f.query).toHaveBeenCalledTimes(calls);
    await expect(f.act('close',initial.version,{requestId:'different_stale_request'})).rejects.toMatchObject({code:'ORDER_VERSION_CONFLICT'});
  });
  it('preserves worker security headers for authenticated order detail and rejects writes without CSRF',async()=>{
    const f=await fixture(),context={waitUntil:vi.fn()} as unknown as ExecutionContext;
    const read=await handle(request(`/api/admin/orders/${f.id}`),env,context,f.payments);expect(read.status).toBe(200);expect(read.headers.get('Cache-Control')).toBe('no-store');expect(read.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const rejected=await handle(request(`/api/admin/orders/${f.id}/reconcile`,{method:'POST',body:{},token:false}),env,context,f.payments);expect(rejected.status).toBe(403);expect(f.query).not.toHaveBeenCalled();
  });
  it('keeps admin reopening, signed checkout, return routing, provider notification and product reads on the original order',async()=>{
    const f=await fixture(),work:Promise<unknown>[]=[],context={waitUntil:(promise:Promise<unknown>)=>work.push(promise)} as unknown as ExecutionContext;
    const mutate=async(action:string,version:string)=>{
      const response=await handle(request(`/api/admin/orders/${f.id}/${action}`,{method:'POST',body:{expectedVersion:version,requestId:'worker_'+action+'_request',reason:'用户重新付款并核对'}}),env,context,f.payments);
      expect(response.status).toBe(200);return response.json() as Promise<{version:string;checkoutUrl:string;order:{activeAttempt:{id:string};status:string}}>;
    };
    const closed=await mutate('close',(await f.detail()).version),reopened=await mutate('reopen',closed.version),providerId=reopened.order.activeAttempt.id;
    expect(providerId).not.toBe(f.id);
    const capability=new URLSearchParams(new URL(reopened.checkoutUrl).hash.slice(1)).get('token');
    const buildUrl=vi.spyOn(f.payments.gateway,'paymentUrl');
    const pay=await handle(new Request(BASE+`/api/checkout/${f.id}/pay`,{method:'POST',headers:{Authorization:'Bearer '+capability,'Content-Type':'application/json'},body:JSON.stringify({channel:'page'})}),env,context,f.payments);
    expect(pay.status).toBe(200);expect(buildUrl).toHaveBeenCalledWith(expect.objectContaining({id:providerId,totalAmount:'9.90'}),expect.objectContaining({pageReturnUrl:BASE+`/payment/return?payment_order_id=${f.id}`}));
    const commits=f.store.commits.length;
    const redirected=await handle(new Request(BASE+`/payment/return?out_trade_no=${providerId}&payment_order_id=${f.id}`),env,context,f.payments);
    expect(redirected.status).toBe(303);expect(redirected.headers.get('Location')).toBe(BASE+`/checkout/${f.id}`);expect(f.store.commits).toHaveLength(commits);expect((await f.payments.order(f.id)).status).toBe('PENDING');
    const now=new Date(),china=new Date(now.getTime()+8*3600000).toISOString().slice(0,19).replace('T',' ');
    const notified=await handle(new Request(BASE+'/api/alipay/notify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({sign_type:'RSA2',sign:'fixture-verified-adapter',app_id:env.ALIPAY_APP_ID,seller_id:env.ALIPAY_SELLER_ID,out_trade_no:providerId,trade_no:'2026101922001400000000000001',trade_status:'TRADE_SUCCESS',total_amount:'9.90',gmt_payment:china})}),env,context,f.payments);
    expect(notified.status).toBe(200);await Promise.all(work);expect(f.send).toHaveBeenCalledTimes(1);
    const route=`/api/v1/orders/${f.id}`,timestamp=String(Math.floor(Date.now()/1000)),nonce='product_original_order_nonce';
    const signature=createHmac('sha256',client.apiSecret).update(['GET',route,timestamp,nonce,createHash('sha256').update('').digest('hex')].join('\n')).digest('hex');
    const product=await handle(new Request(BASE+route,{headers:{'X-Brclio-Client':client.id,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Signature':signature}}),env,context,f.payments);
    expect(product.status).toBe(200);expect(await product.json()).toMatchObject({id:f.id,productOrderId:'fixture-business-order',amount:'9.90',status:'PAID',fulfillmentStatus:'delivered'});
    expect(await f.store.readJson(`events/evt_${providerId}.json`)).toBeNull();expect(await f.store.readJson(`events/evt_${f.id}.json`)).toMatchObject({event:{data:{orderId:f.id,productOrderId:'fixture-business-order'}}});
  });
});
