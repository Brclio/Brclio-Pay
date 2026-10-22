import {describe,expect,it,vi} from 'vitest';
import {handleLegacyWechat} from '../src/legacy-wechat';
import {Payments,type Gateway,type Trade,type WechatGateway} from '../src/payments';
import {hmacSha256,sha256} from '../src/crypto';
import type {Delivery,Env,Order,ProductClient,Store,Transaction} from '../src/types';

// Execute the unchanged consumer's production SDK against the compatibility layer.
const {createBrclioWechatPayClient,verifyBrclioWechatPayEvent}=await import(new URL('./fixtures/legacy-wechat-client.mjs',import.meta.url).href);
const origin='https://paywc.bornforthis.cn',clientId='p-2bb6d77a673327a2f8d881bac2d4fe26';
const client:ProductClient&{legacyWechat:{id:string}}={id:clientId,name:'Legacy consumer fixture',providers:['wechat'],legacyWechat:{id:clientId},apiSecret:'a'.repeat(64),webhookSecret:'b'.repeat(64),webhookUrl:'https://product.example.com/legacy-wechat',returnOrigins:['https://product.example.com'],skus:{day:{subject:'One day',amount:'3.00'}}};
class MemoryStore implements Store {
  data=new Map<string,unknown>();tail:Promise<unknown>=Promise.resolve();
  async readJson<T>(path:string):Promise<T|null>{await this.tail;return this.data.has(path)?structuredClone(this.data.get(path)) as T:null;}
  transaction<T>(callback:(tx:Transaction)=>Promise<T>):Promise<T>{const result=this.tail.then(async()=>{const next=structuredClone(this.data),value=await callback({read:async<V>(path:string)=>next.has(path)?structuredClone(next.get(path)) as V:null,put:(path,value)=>{next.set(path,structuredClone(value));}});this.data=next;return value;});this.tail=result.catch(()=>{});return result;}
}
function fixture(){
  const env={ASSETS:{} as Fetcher,PAY_BASE_URL:'https://pay.bornforthis.cn',PAYMENT_MODE:'live',PAYMENT_ENABLED:'true',ALIPAY_CHANNELS:'page,wap',ALIPAY_APP_ID:'2021007109602288',ALIPAY_PRIVATE_KEY:'fixture-private',ALIPAY_PUBLIC_KEY:'fixture-public',ALIPAY_SELLER_ID:'2088123456789012',GITHUB_TOKEN:'fixture-token',GITHUB_REPOSITORY:'fixture/private-data',GITHUB_BRANCH:'main',CHECKOUT_SECRET:'c'.repeat(64),LEGACY_WECHAT_CHECKOUT_SECRET:'l'.repeat(64),CLIENTS_JSON:JSON.stringify([client]),REGISTRY_STORAGE_MODE:'plain',WECHAT_MCH_ID:'1234567890',WECHAT_APP_ID:'wx0123456789abcdef',WECHAT_CHANNELS:'native'} as Env&{LEGACY_WECHAT_CHECKOUT_SECRET:string};
  Object.assign(env,{WECHAT_SERIAL_NO:'A'.repeat(40),WECHAT_PRIVATE_KEY:'fixture-wechat-private',WECHAT_API_V3_KEY:'v'.repeat(32),WECHAT_PUBLIC_KEYS_JSON:'{"PUB_KEY_ID_fixture":"fixture-public"}'});
  const store=new MemoryStore(),alipay:Gateway={query:vi.fn(async()=>null),close:vi.fn(async()=>{}),paymentUrl:()=> 'https://openapi.alipay.com/gateway.do',verifyNotification:()=>false},wechat:WechatGateway={query:vi.fn(async()=>null),close:vi.fn(async()=>{}),create:vi.fn(async()=>({codeUrl:'weixin://wxpay/bizpayurl?pr=legacy-fixture'})),notification:vi.fn(async()=>{throw Error('No provider fixture');})},send=vi.fn<typeof fetch>(async()=>new Response('ok'));
  const payments=new Payments(env,store,alipay,Date.now,send,wechat),pending:Promise<unknown>[]=[],ctx={waitUntil:(task:Promise<unknown>)=>pending.push(task)} as unknown as ExecutionContext;
  const fetcher=vi.fn<typeof fetch>((input,init)=>handleLegacyWechat(new Request(input,init),env,payments,ctx));
  const sdk=createBrclioWechatPayClient({baseUrl:origin,clientId,apiKey:client.apiSecret,fetcher});
  const input={merchantOrderId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',sku:'day',quantity:1,channel:'native',expectedTotal:300,returnUrl:'https://product.example.com/account?order=fixture'};
  const call=(path:string,method='GET',raw='',key=client.apiSecret,id=clientId)=>{const timestamp=String(Math.floor(Date.now()/1000)),nonce='0123456789abcdef0123456789abcdef';return handleLegacyWechat(new Request(origin+path,{method,headers:{'Content-Type':'application/json','X-Brclio-Client':id,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Signature':hmacSha256(key,`${method}\n${path}\n${timestamp}\n${nonce}\n${raw}\n`)},...(raw?{body:raw}:{})}),env,payments,ctx);};
  const paid=(externalId:string):Trade=>({provider:'wechat',outTradeNo:'pay_'+externalId,tradeNo:'4200000000202610211234567890',tradeStatus:'TRADE_SUCCESS',totalAmount:'3.00',sellerId:env.WECHAT_MCH_ID,appId:env.WECHAT_APP_ID,currency:'CNY',paidAt:new Date().toISOString()});
  return {env,store,payments,wechat,alipay,send,pending,sdk,input,fetcher,ctx,call,paid};
}

describe('unchanged XHS WeChat SDK compatibility',()=>{
  it('creates one Native purchase through the old exact-byte HMAC and returns the original wire shape',async()=>{
    const f=fixture(),result=await f.sdk.createOrder(f.input);
    expect(result.id).toMatch(/^[a-f0-9]{32}$/);expect(result).toMatchObject({clientId,merchantOrderId:f.input.merchantOrderId,sku:'day',quantity:1,amount:{total:300,currency:'CNY'},status:'PENDING',payment:{channel:'native',codeUrl:'weixin://wxpay/bizpayurl?pr=legacy-fixture'}});
    expect(result.checkoutUrl).toBe(`${origin}/checkout/${result.id}#token=${hmacSha256(f.env.LEGACY_WECHAT_CHECKOUT_SECRET,`checkout:v1:${result.id}`)}`);
    expect(await f.sdk.getOrder(result.id)).toMatchObject({id:result.id,amount:{total:300,currency:'CNY'},status:'PENDING'});
    expect((await f.payments.order('pay_'+result.id)) as Order&{legacyWechat:unknown}).toMatchObject({provider:'wechat',legacyWechat:{clientId,quantity:1,channel:'native',centerOrigin:origin}});
    expect(f.alipay.query).not.toHaveBeenCalled();expect(f.wechat.create).toHaveBeenCalledTimes(1);
  });
  it('keeps original price on retry after repricing and exposes the old SDK quote-change error',async()=>{
    const f=fixture(),created=await f.sdk.createOrder(f.input);f.env.CLIENTS_JSON=JSON.stringify([{...client,skus:{day:{subject:'New title',amount:'9.00'}}}]);
    expect(await f.sdk.createOrder(f.input)).toMatchObject({id:created.id,amount:{total:300,currency:'CNY'},description:'One day'});
    await expect(f.sdk.createOrder({...f.input,expectedTotal:900})).rejects.toMatchObject({code:'QUOTE_CHANGED'});
    expect(f.wechat.create).toHaveBeenCalledTimes(1);
    const fresh=fixture();await expect(fresh.sdk.createOrder({...fresh.input,expectedTotal:1})).rejects.toMatchObject({code:'QUOTE_CHANGED'});expect(fresh.store.data.size).toBe(0);expect(fresh.wechat.create).not.toHaveBeenCalled();
  });
  it('refuses unsigned requests and a unified-only client on the legacy signature protocol',async()=>{
    const f=fixture(),response=await handleLegacyWechat(new Request(origin+'/api/v1/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.input)}),f.env,f.payments,f.ctx);expect(response.status).toBe(401);
    f.env.CLIENTS_JSON=JSON.stringify([{...client,legacyWechat:undefined,providers:['alipay','wechat']}]);
    expect((await f.call('/api/v1/orders','POST',JSON.stringify(f.input))).status).toBe(401);expect(f.wechat.create).not.toHaveBeenCalled();
  });
  it.each(['global','client','channels'])('blocks new prepay while %s collection is disabled and keeps existing history readable',async kind=>{
    const f=fixture(),created=await f.sdk.createOrder(f.input);
    if(kind==='global')f.env.PAYMENT_ENABLED='false';else if(kind==='channels'){f.env.ALIPAY_CHANNELS='';f.env.WECHAT_CHANNELS='';}else f.env.CLIENTS_JSON=JSON.stringify([{...client,enabled:false}]);
    expect(await f.sdk.getOrder(created.id)).toMatchObject({id:created.id,status:'PENDING'});
    expect(await f.sdk.createOrder(f.input)).toMatchObject({id:created.id,amount:{total:300,currency:'CNY'}});expect(f.wechat.create).toHaveBeenCalledTimes(1);
    const response=await f.call('/api/v1/orders','POST',JSON.stringify({...f.input,merchantOrderId:'new-disabled-order'}));expect(response.status).toBe(kind==='client'?403:503);expect(f.wechat.create).toHaveBeenCalledTimes(1);
  });
  it('retains checkout token authentication for the old 32-character order and protects query/refresh',async()=>{
    const f=fixture(),created=await f.sdk.createOrder(f.input),path=`/api/checkout/${created.id}`,authorization='Bearer '+hmacSha256(f.env.LEGACY_WECHAT_CHECKOUT_SECRET,`checkout:v1:${created.id}`);
    const invoke=(suffix='',init:RequestInit={})=>handleLegacyWechat(new Request(origin+path+suffix,init),f.env,f.payments,f.ctx);
    expect((await invoke()).status).toBe(401);expect((await invoke('',{headers:{Authorization:authorization}})).status).toBe(200);
    const refreshed=await invoke('/refresh',{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:'{}'});expect(refreshed.status).toBe(200);expect(await refreshed.json()).toMatchObject({id:created.id,status:'PENDING',payment:{channel:'native'}});expect(f.wechat.query).toHaveBeenCalledWith('pay_'+created.id);
    expect((await invoke('',{headers:{Authorization:'Bearer '+hmacSha256(f.env.CHECKOUT_SECRET,'brclio-checkout-v1:pay_'+created.id)}})).status).toBe(401);
  });
  it('accepts provider success as old SUCCESS and produces a notification accepted by the unchanged consumer verifier',async()=>{
    const f=fixture(),created=await f.sdk.createOrder(f.input);vi.mocked(f.wechat.query).mockResolvedValue(f.paid(created.id));
    const result=await f.sdk.refreshOrder(created.id);expect(result).toMatchObject({id:created.id,status:'SUCCESS',quantity:1,transactionId:f.paid(created.id).tradeNo,amount:{total:300,currency:'CNY'}});await Promise.all(f.pending);
    expect(f.send).toHaveBeenCalledTimes(1);const [,init]=f.send.mock.calls[0],rawBody=String(init!.body),event=verifyBrclioWechatPayEvent({rawBody,headers:new Headers(init!.headers),webhookSecret:client.webhookSecret,clientId});expect(event).toMatchObject({eventId:`payment.success.${created.id}`,type:'payment.success',orderId:created.id,merchantOrderId:f.input.merchantOrderId,total:300,quantity:1});
    await f.sdk.refreshOrder(created.id);await Promise.all(f.pending);expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('never recreates outbox delivery for migrated delivered history, including explicit retry',async()=>{
    const f=fixture(),id='e'.repeat(32),logical='pay_'+id,at=new Date().toISOString();
    const order:Order={id:logical,provider:'wechat',wechatOrderId:id,mode:'live',clientId,productOrderId:'archived-fixture',sku:'day',subject:'Archived',amount:'3.00',status:'PAID',createdAt:at,expiresAt:at,returnUrl:'',requestHash:sha256('archived-fixture'),tradeNo:f.paid(id).tradeNo,paidAt:at,fulfillmentStatus:'delivered'};f.store.data.set(`orders/${logical}.json`,order);
    expect(await f.sdk.getOrder(id)).toMatchObject({id,status:'SUCCESS',deliveryStatus:'delivered'});
    expect((await f.call(`/api/v1/orders/${id}/retry-notification`,'POST','{}')).status).toBe(200);await Promise.all(f.pending);expect(f.send).not.toHaveBeenCalled();expect([...f.store.data.keys()].some(path=>path.startsWith('events/'))).toBe(false);
  });
  it('retries only an existing undelivered outbox using the same legacy event identity',async()=>{
    const f=fixture(),created=await f.sdk.createOrder(f.input);f.send.mockResolvedValueOnce(new Response('retry',{status:503}));vi.mocked(f.wechat.query).mockResolvedValue(f.paid(created.id));
    await f.sdk.refreshOrder(created.id);await Promise.all(f.pending);const first=f.send.mock.calls[0][1]!;
    expect((await f.payments.order('pay_'+created.id)).fulfillmentStatus).toBe('pending');
    const response=await f.call(`/api/v1/orders/${created.id}/retry-notification`,'POST','{}');expect(response.status).toBe(200);await Promise.all(f.pending);expect(f.send).toHaveBeenCalledTimes(2);
    const second=f.send.mock.calls[1][1]!,event=verifyBrclioWechatPayEvent({rawBody:String(second.body),headers:new Headers(second.headers),webhookSecret:client.webhookSecret,clientId});expect(event.eventId).toBe(JSON.parse(String(first.body)).eventId);expect((await f.payments.order('pay_'+created.id)).fulfillmentStatus).toBe('delivered');
  });
  it('rejects cross-client access and binds the signature to query and raw bytes',async()=>{
    const f=fixture(),created=await f.sdk.createOrder(f.input),other={...client,id:'legacy-other',legacyWechat:{id:'legacy-other'},apiSecret:'z'.repeat(64)};f.env.CLIENTS_JSON=JSON.stringify([client,other]);
    expect((await f.call(`/api/v1/orders/${created.id}`,'GET','',other.apiSecret,other.id)).status).toBe(404);
    const raw=JSON.stringify(f.input),timestamp=String(Math.floor(Date.now()/1000)),nonce='0123456789abcdef0123456789abcdef',signature=hmacSha256(client.apiSecret,`POST\n/api/v1/orders\n${timestamp}\n${nonce}\n${raw}\n`);
    const response=await handleLegacyWechat(new Request(origin+'/api/v1/orders?altered=1',{method:'POST',headers:{'Content-Type':'application/json','X-Brclio-Client':clientId,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Signature':signature},body:raw+' '}),f.env,f.payments,f.ctx);expect(response.status).toBe(401);
  });
});
