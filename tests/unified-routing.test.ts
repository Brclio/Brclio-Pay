import {describe,expect,it,vi} from 'vitest';
import {createHmac,pbkdf2Sync} from 'node:crypto';
import {handle} from '../src/index';
import {Payments,type Gateway,type Trade,type WechatGateway} from '../src/payments';
import {checkoutToken} from '../src/auth';
import {adminLogin} from '../src/admin-auth';
import {hmacSha256,sha256} from '../src/crypto';
import type {Env,Order,ProductClient,Store,Transaction} from '../src/types';

const base='https://pay.bornforthis.cn';
const client:ProductClient={id:'routing-product',name:'Routing product',providers:['alipay','wechat'],apiSecret:'a'.repeat(64),webhookSecret:'w'.repeat(64),webhookUrl:'https://product.example.com/payment',returnOrigins:['https://product.example.com'],skus:{pro:{subject:'Pro',amount:'3.00'}}};
class MemoryStore implements Store {
  data=new Map<string,unknown>();tail:Promise<unknown>=Promise.resolve();
  async readJson<T>(path:string):Promise<T|null>{await this.tail;return this.data.has(path)?structuredClone(this.data.get(path)) as T:null;}
  transaction<T>(callback:(tx:Transaction)=>Promise<T>):Promise<T>{const result=this.tail.then(async()=>{const next=structuredClone(this.data);const value=await callback({read:async<V>(path:string)=>next.has(path)?structuredClone(next.get(path)) as V:null,put:(path,value)=>{next.set(path,structuredClone(value));}});this.data=next;return value;});this.tail=result.catch(()=>{});return result;}
}
async function fixture(){
  const env:Env={ASSETS:{fetch:async()=>new Response('asset')} as unknown as Fetcher,PAY_BASE_URL:base,PAYMENT_MODE:'live',PAYMENT_ENABLED:'true',ALIPAY_CHANNELS:'page,wap',ALIPAY_APP_ID:'2021007109602288',ALIPAY_PRIVATE_KEY:'fixture-private',ALIPAY_PUBLIC_KEY:'fixture-public',ALIPAY_SELLER_ID:'2088123456789012',GITHUB_TOKEN:'fixture-github',GITHUB_REPOSITORY:'fixture/private-data',GITHUB_BRANCH:'main',CHECKOUT_SECRET:'c'.repeat(64),CLIENTS_JSON:JSON.stringify([client]),REGISTRY_STORAGE_MODE:'plain',WECHAT_MCH_ID:'1234567890',WECHAT_APP_ID:'wx0123456789abcdef',WECHAT_CHANNELS:'native'};
  Object.assign(env,{WECHAT_SERIAL_NO:'A'.repeat(40),WECHAT_PRIVATE_KEY:'fixture-wechat-private',WECHAT_API_V3_KEY:'v'.repeat(32),WECHAT_PUBLIC_KEYS_JSON:'{"PUB_KEY_ID_fixture":"fixture-public"}'});
  const store=new MemoryStore(),alipay:Gateway={query:vi.fn(async()=>null),close:vi.fn(async()=>{}),paymentUrl:vi.fn(()=> 'https://openapi.alipay.com/gateway.do'),verifyNotification:()=>true};
  const wechat:WechatGateway={query:vi.fn(async()=>null),close:vi.fn(async()=>{}),create:vi.fn(async()=>({codeUrl:'weixin://wxpay/bizpayurl?pr=routing-fixture'})),notification:vi.fn(async()=>{throw Error('No verified notification');})};
  const send=vi.fn<typeof fetch>(async()=>new Response('ok')),payments=new Payments(env,store,alipay,Date.now,send,wechat),pending:Promise<unknown>[]=[];
  const id=String((await payments.create(client,{productOrderId:'routing-business',sku:'pro',returnUrl:'https://product.example.com/account',provider:'wechat'})).id);
  const context={waitUntil:(task:Promise<unknown>)=>pending.push(task)} as unknown as ExecutionContext;
  const call=(path:string,init:RequestInit={})=>handle(new Request(base+path,init),env,context,payments);
  const checkoutHeaders={'Content-Type':'application/json',Authorization:'Bearer '+checkoutToken(id,env)};
  const paid:Trade={provider:'wechat',outTradeNo:id,tradeNo:'4200000000202610211234567890',tradeStatus:'TRADE_SUCCESS',totalAmount:'3.00',sellerId:env.WECHAT_MCH_ID,appId:env.WECHAT_APP_ID,currency:'CNY',paidAt:new Date().toISOString()};
  return {env,store,payments,wechat,alipay,send,id,call,checkoutHeaders,pending,paid};
}
function productRequest(path:string,apiSecret=client.apiSecret){const timestamp=String(Math.floor(Date.now()/1000)),nonce='routing_nonce_0123456789';return {headers:{'X-Brclio-Client':client.id,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Signature':hmacSha256(apiSecret,['GET',path,timestamp,nonce,sha256('')].join('\n'))}};}

describe('unified HTTP checkout and provider callbacks',()=>{
  it('protects Native parameters with the existing checkout credential and returns only its fixed provider channel',async()=>{
    const f=await fixture(),path=`/api/checkout/${f.id}/pay`;
    expect((await f.call(path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"channel":"native"}'})).status).toBe(401);expect(f.wechat.create).not.toHaveBeenCalled();
    const response=await f.call(path,{method:'POST',headers:f.checkoutHeaders,body:'{"channel":"native"}'});
    expect(response.status).toBe(200);expect(await response.json()).toEqual({provider:'wechat',channel:'native',codeUrl:'weixin://wxpay/bizpayurl?pr=routing-fixture'});expect(response.headers.get('Cache-Control')).toBe('no-store');expect(f.alipay.paymentUrl).not.toHaveBeenCalled();
  });
  it('persists verified WeChat callback facts before acknowledging and delivers the unified event once',async()=>{
    const f=await fixture(),raw=' { "encrypted": "provider body fixture" } ';
    vi.mocked(f.wechat.notification).mockResolvedValue(f.paid);
    const response=await f.call('/api/wechat/notify',{method:'POST',headers:{'Content-Type':'application/json','Wechatpay-Serial':'fixture-pinned-key'},body:raw});
    expect(response.status).toBe(204);expect(f.wechat.notification).toHaveBeenCalledWith(expect.any(Headers),raw);expect((await f.payments.order(f.id)).status).toBe('PAID');await Promise.all(f.pending);
    expect(f.send).toHaveBeenCalledTimes(1);const body=JSON.parse(f.send.mock.calls[0][1]!.body as string);expect(body).toMatchObject({type:'payment.paid',data:{provider:'wechat',orderId:f.id,amount:'3.00'}});
    await f.call('/api/wechat/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:raw});await Promise.all(f.pending);expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('rejects provider content-type confusion before processing a notification',async()=>{
    const f=await fixture();const response=await f.call('/api/wechat/notify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'trade_status=TRADE_SUCCESS'});expect(response.status).toBe(415);expect(f.wechat.notification).not.toHaveBeenCalled();expect((await f.payments.order(f.id)).status).toBe('PENDING');
  });
  it('returns imported purchases with an absent historical product return URL through signed reads',async()=>{
    const f=await fixture(),order=await f.payments.order(f.id);order.returnUrl='';order.status='CLOSED';f.store.data.set(`orders/${f.id}.json`,order);
    const path=`/api/v1/orders/${f.id}`,response=await f.call(path,productRequest(path));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({provider:'wechat',returnUrl:'',status:'CLOSED'});
    const publicRead=await f.call(path);expect(publicRead.status).toBe(401);
  });
  it('preserves the injected WeChat gateway through administrator runtime configuration',async()=>{
    const f=await fixture(),password='ephemeral-routing-fixture',pepper='1'.repeat(64),salt='2'.repeat(64),material=createHmac('sha256',pepper).update(password).digest('hex');
    Object.assign(f.env,{ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD_PEPPER:pepper,ADMIN_PASSWORD_HASH:`pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(material,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')}`,ADMIN_SESSION_SECRET:'e'.repeat(64),ADMIN_LOGIN_LIMITER:{limit:async()=>({success:true})}});
    const login=await adminLogin(new Request(base+'/api/admin/login',{method:'POST',headers:{Origin:base}}),f.env,{email:f.env.ADMIN_EMAIL,password}),cookie=login.headers.get('Set-Cookie')!.split(';')[0],session=await login.json() as {csrfToken:string};
    const detailResponse=await f.call(`/api/admin/orders/${f.id}`,{headers:{Cookie:cookie}}),detail=await detailResponse.json() as {version:string};
    vi.mocked(f.wechat.query).mockResolvedValue(f.paid);
    const response=await f.call(`/api/admin/orders/${f.id}/reconcile`,{method:'POST',headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:detail.version,requestId:'wechat-routing-reconcile',reason:'核验微信支付'})});
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({order:{provider:'wechat',status:'PAID'}});expect(f.wechat.query).toHaveBeenCalledWith(f.id);expect(f.alipay.query).not.toHaveBeenCalled();await Promise.all(f.pending);
  });
});
