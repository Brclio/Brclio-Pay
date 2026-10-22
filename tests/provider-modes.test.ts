import {describe,expect,it,vi} from 'vitest';
import {createHmac,generateKeyPairSync,pbkdf2Sync} from 'node:crypto';
import {configurationReady,paymentChannels,requireReady} from '../src/config';
import worker,{handle,service} from '../src/index';
import {hmacSha256,sha256} from '../src/crypto';
import {checkoutToken} from '../src/auth';
import {PartitionedStore} from '../src/partitioned-store';
import {Payments,type Gateway,type WechatGateway} from '../src/payments';
import {handleAdmin} from '../src/admin';
import {adminLogin} from '../src/admin-auth';
import type {Env,PaymentProvider,ProductClient,Store,Transaction} from '../src/types';

const pair=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const publicId='PUB_KEY_ID_provider_mode_fixture';
const product:ProductClient={id:'provider-product',name:'Provider product',apiSecret:'a'.repeat(64),webhookSecret:'w'.repeat(64),providers:['alipay','wechat'],webhookUrl:'https://product.example.com/payment',returnOrigins:['https://product.example.com'],skus:{pro:{subject:'Pro',amount:'3.00'}}};
const purchase={productOrderId:'provider-mode-business',sku:'pro',returnUrl:'https://product.example.com/account'};
class MemoryStore implements Store {
  data=new Map<string,unknown>();
  async readJson<T>(path:string):Promise<T|null>{return structuredClone(this.data.get(path)??null) as T|null;}
  async transaction<T>(action:(tx:Transaction)=>Promise<T>):Promise<T>{const next=structuredClone(this.data),result=await action({read:async<V>(path:string)=>structuredClone(next.get(path)??null) as V|null,put:(path,value)=>{next.set(path,structuredClone(value));}});this.data=next;return result;}
}
function environment(mode:'dual'|PaymentProvider='dual'):Env {
  const env:Env={ASSETS:{} as Fetcher,PAY_BASE_URL:'https://payment.example.com',PAYMENT_MODE:'live',PAYMENT_ENABLED:'true',ALIPAY_CHANNELS:'page,wap',ALIPAY_APP_ID:'2021007109602288',ALIPAY_SELLER_ID:'2088123456789012',ALIPAY_PRIVATE_KEY:pair.privateKey,ALIPAY_PUBLIC_KEY:pair.publicKey,WECHAT_CHANNELS:'native',WECHAT_APP_ID:'wx0123456789abcdef',WECHAT_MCH_ID:'1234567890',WECHAT_SERIAL_NO:'A'.repeat(40),WECHAT_PRIVATE_KEY:pair.privateKey,WECHAT_API_V3_KEY:'v'.repeat(32),WECHAT_PUBLIC_KEYS_JSON:JSON.stringify({[publicId]:pair.publicKey}),WECHAT_PUBLIC_KEY_ID:publicId,GITHUB_TOKEN:'provider-mode-fixture-token',GITHUB_REPOSITORY:'fixture/private-data',GITHUB_BRANCH:'main',CHECKOUT_SECRET:'c'.repeat(64),CLIENTS_JSON:JSON.stringify([product]),REGISTRY_STORAGE_MODE:'plain'};
  if(mode==='alipay'){env.WECHAT_CHANNELS='';delete env.WECHAT_PRIVATE_KEY;delete env.WECHAT_API_V3_KEY;delete env.WECHAT_PUBLIC_KEYS_JSON;}
  if(mode==='wechat'){env.ALIPAY_CHANNELS='';env.ALIPAY_APP_ID='';env.ALIPAY_SELLER_ID='';env.ALIPAY_PRIVATE_KEY='';env.ALIPAY_PUBLIC_KEY='';}
  return env;
}
function fixture(mode:'dual'|PaymentProvider='dual'){
  const env=environment(mode),store=new MemoryStore();
  const alipay:Gateway={query:vi.fn(async()=>null),close:vi.fn(async()=>{}),paymentUrl:vi.fn(()=> 'https://openapi.alipay.com/gateway.do'),verifyNotification:vi.fn(()=>true)};
  const wechat:WechatGateway={query:vi.fn(async()=>null),close:vi.fn(async()=>{}),create:vi.fn(async()=>({codeUrl:'weixin://wxpay/bizpayurl?pr=fixture'})),notification:vi.fn(async()=>{throw Error('No verified notification fixture');})};
  const send=vi.fn<typeof fetch>(async()=>new Response('ok'));
  const payments=new Payments(env,store,mode==='wechat'?undefined:alipay,Date.now,send,mode==='alipay'?undefined:wechat);
  const pending:Promise<unknown>[]=[];
  const ctx={waitUntil:(task:Promise<unknown>)=>pending.push(task)} as unknown as ExecutionContext;
  const call=(path:string,init:RequestInit={})=>handle(new Request(env.PAY_BASE_URL+path,init),env,ctx,payments);
  return {env,store,alipay,wechat,payments,call,send,pending};
}
function signedRequest(path:string,method='GET',raw=''){const timestamp=String(Math.floor(Date.now()/1000)),nonce='provider_mode_nonce_fixture';return {headers:{'Content-Type':'application/json','X-Brclio-Client':product.id,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Signature':hmacSha256(product.apiSecret,[method,path,timestamp,nonce,sha256(raw)].join('\n'))}};}
function signedCatalog(){return signedRequest('/api/v1/catalog');}

describe('deployment provider selection',()=>{
  it.each(['dual','alipay','wechat'] as const)('starts %s mode with only its selected merchant credentials and an empty product registry',mode=>{
    const env=environment(mode);env.CLIENTS_JSON='[]';
    expect(configurationReady(env)).toBe(true);expect(()=>requireReady(env,true)).not.toThrow();
    const payments=service(env);
    expect(!!payments.gateway).toBe(mode!=='wechat');expect(!!payments.wechatGateway).toBe(mode!=='alipay');
  });
  it('does not apply an unused Alipay gateway to WeChat-only mode',()=>{
    const env=environment('wechat');env.ALIPAY_GATEWAY='https://openapi-sandbox.dl.alipaydev.com/gateway.do';
    expect(()=>requireReady(env)).not.toThrow();
  });
  it('fails closed when either selected provider is incomplete',()=>{
    const env=environment();env.WECHAT_API_V3_KEY='';expect(configurationReady(env)).toBe(false);
    expect(()=>requireReady(env)).toThrowError('支付服务尚未完成配置');
    env.WECHAT_CHANNELS='';expect(configurationReady(env)).toBe(true);
  });
  it.each([{ALIPAY_CHANNELS:'page,page'},{ALIPAY_CHANNELS:'native'},{WECHAT_CHANNELS:'h5'},{ALIPAY_CHANNELS:'',WECHAT_CHANNELS:''},{PAYMENT_MODE:'sandbox',ALIPAY_CHANNELS:''}])('rejects unsupported or empty channel selection: %j',changes=>{
    expect(()=>requireReady({...environment(),...changes} as Env)).toThrow();
  });
  it('normalizes spacing and never exposes an empty channel as usable',()=>{
    const env=environment();env.ALIPAY_CHANNELS=' page, wap ';env.WECHAT_CHANNELS='';
    expect(paymentChannels(env,'alipay')).toEqual(['page','wap']);expect(paymentChannels(env,'wechat')).toEqual([]);
  });
});

describe('provider health and signed product catalog',()=>{
  it.each(['dual','alipay','wechat'] as const)('reports %s mode without advertising the unselected provider',async mode=>{
    const f=fixture(mode);f.env.CLIENTS_JSON='[]';
    const response=await f.call('/api/health'),value=await response.json() as any;
    expect(response.status).toBe(200);expect(value.ready).toBe(true);expect(value.acceptingPayments).toBe(true);
    expect(value.providers.alipay).toEqual({selected:mode!=='wechat',configured:mode!=='wechat',channels:mode==='wechat'?[]:['page','wap']});
    expect(value.providers.wechat).toEqual({selected:mode!=='alipay',configured:mode!=='alipay',channels:mode==='alipay'?[]:['native']});
  });
  it('invalidates health after provider bindings change instead of reusing stale ready state',async()=>{
    const f=fixture();expect((await (await f.call('/api/health')).json() as any).ready).toBe(true);
    f.env.WECHAT_SERIAL_NO='';const value=await (await f.call('/api/health')).json() as any;
    expect(value.ready).toBe(false);expect(value.acceptingPayments).toBe(false);expect(value.providers.wechat.channels).toEqual([]);
  });
  it('does not advertise an incomplete selected merchant through the signed catalog',async()=>{
    const f=fixture();f.env.WECHAT_API_V3_KEY='';
    expect((await f.call('/api/v1/catalog',signedCatalog())).status).toBe(503);
  });
  it.each(['alipay','wechat'] as const)('intersects catalog permissions with selected %s channels',async mode=>{
    const f=fixture(mode),response=await f.call('/api/v1/catalog',signedCatalog()),value=await response.json() as any;
    expect(response.status).toBe(200);expect(value.providers).toEqual([mode]);expect(value.channels[mode==='alipay'?'wechat':'alipay']).toEqual([]);expect(value.acceptingPayments).toBe(true);
  });
  it('reports a product with no selected provider as unavailable for new purchases',async()=>{
    const f=fixture('wechat');f.env.CLIENTS_JSON=JSON.stringify([{...product,providers:['alipay']}]);
    const value=await (await f.call('/api/v1/catalog',signedCatalog())).json() as any;
    expect(value.providers).toEqual([]);expect(value.channels).toEqual({alipay:[],wechat:[]});expect(value.acceptingPayments).toBe(false);
  });
});

describe('provider selection and historical payment continuity',()=>{
  it.each(['alipay','wechat'] as const)('keeps %s historical HTTP reads and late callbacks working after every purchase channel is disabled',async provider=>{
    const f=fixture(provider),created=await f.payments.create(product,{...purchase,provider}),id=String(created.id);
    f.env.ALIPAY_CHANNELS='';f.env.WECHAT_CHANNELS='';
    const health=await (await f.call('/api/health')).json() as any;
    expect(health.ready).toBe(false);expect(health.acceptingPayments).toBe(false);
    expect(await (await f.call('/api/v1/catalog',signedCatalog())).json()).toMatchObject({acceptingPayments:false,providers:[],channels:{alipay:[],wechat:[]}});
    const path=`/api/v1/orders/${id}`;
    expect((await f.call(path)).status).toBe(401);
    const historical=await f.call(path,signedRequest(path));
    expect(historical.status).toBe(200);expect(await historical.json()).toMatchObject({id,status:'PENDING',channels:[]});
    const headers={Authorization:'Bearer '+checkoutToken(id,f.env),'Content-Type':'application/json'};
    expect((await f.call(`/api/checkout/${id}`,{headers})).status).toBe(200);
    expect((await f.call(`/api/checkout/${id}/pay`,{method:'POST',headers,body:JSON.stringify({channel:provider==='alipay'?'page':'native'})})).status).toBe(503);
    const raw=JSON.stringify({...purchase,productOrderId:'another-business-purchase',provider});
    expect((await f.call('/api/v1/orders',{method:'POST',...signedRequest('/api/v1/orders','POST',raw),body:raw})).status).toBe(503);
    let response:Response;
    if(provider==='alipay')response=await f.call('/api/alipay/notify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({sign_type:'RSA2',app_id:f.env.ALIPAY_APP_ID,seller_id:f.env.ALIPAY_SELLER_ID,out_trade_no:id,total_amount:'3.00',trade_no:'2026102222001462921037601726',trade_status:'TRADE_SUCCESS'})});
    else{
      vi.mocked(f.wechat.notification).mockResolvedValue({provider:'wechat',outTradeNo:id,totalAmount:'3.00',tradeNo:'4200000000202610221234567890',tradeStatus:'TRADE_SUCCESS',sellerId:f.env.WECHAT_MCH_ID,appId:f.env.WECHAT_APP_ID,currency:'CNY',paidAt:new Date().toISOString()});
      response=await f.call('/api/wechat/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:'verified fixture'});
    }
    expect(response.status).toBe(provider==='alipay'?200:204);await Promise.all(f.pending);
    expect(await f.payments.order(id)).toMatchObject({status:'PAID',fulfillmentStatus:'delivered'});expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.alipay.paymentUrl).not.toHaveBeenCalled();expect(f.wechat.create).not.toHaveBeenCalled();
  });
  it('runs the actual scheduled outbox retry after all channels and new payments are disabled',async()=>{
    const f=fixture('alipay'),created=await f.payments.create(product,purchase),id=String(created.id),eventId=`evt_${id}`;
    await f.payments.applyTrade({outTradeNo:id,totalAmount:'3.00',tradeNo:'2026102222001462921037601726',tradeStatus:'TRADE_SUCCESS',sellerId:f.env.ALIPAY_SELLER_ID});
    f.send.mockResolvedValueOnce(new Response('retry',{status:503}));await f.payments.deliver(eventId,product);
    await f.store.transaction(async tx=>{const delivery=await tx.read<import('../src/types').Delivery>(`events/${eventId}.json`);delivery!.nextAttemptAt=new Date(0).toISOString();tx.put(`events/${eventId}.json`,delivery);});
    f.env.ALIPAY_CHANNELS='';f.env.WECHAT_CHANNELS='';f.env.PAYMENT_ENABLED='false';
    const read=vi.spyOn(PartitionedStore.prototype,'readJson').mockImplementation(f.store.readJson.bind(f.store));
    const transaction=vi.spyOn(PartitionedStore.prototype,'transaction').mockImplementation(f.store.transaction.bind(f.store));
    const send=vi.fn<typeof fetch>(async()=>new Response('ok')),pending:Promise<unknown>[]=[];
    vi.stubGlobal('fetch',send);
    try{
      await worker.scheduled({} as ScheduledController,f.env,{waitUntil:(task:Promise<unknown>)=>pending.push(task)} as unknown as ExecutionContext);
      await Promise.all(pending);
      expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).toBe(product.webhookUrl);
      expect(await f.payments.order(id)).toMatchObject({status:'PAID',fulfillmentStatus:'delivered'});
      expect(await f.store.readJson(`events/${eventId}.json`)).toMatchObject({attempts:2,deliveredAt:expect.any(String)});
      expect(await f.store.readJson('system/queue.json')).toMatchObject({deliveries:[]});
    }finally{read.mockRestore();transaction.mockRestore();vi.unstubAllGlobals();}
  });
  it('preserves omitted-provider Alipay behavior and requires explicit WeChat in WeChat-only mode',async()=>{
    const f=fixture('wechat');
    await expect(f.payments.create(product,purchase)).rejects.toMatchObject({code:'PROVIDER_DISABLED'});expect(f.store.data.size).toBe(0);
    const created=await f.payments.create(product,{...purchase,provider:'wechat'});expect(created.provider).toBe('wechat');
    expect(await f.payments.pay(String(created.id),'native')).toMatchObject({provider:'wechat',channel:'native'});expect(f.alipay.paymentUrl).not.toHaveBeenCalled();
  });
  it.each(['alipay','wechat'] as const)('replays a saved %s purchase after disabling new payments but does not issue another link',async provider=>{
    const f=fixture(),input={...purchase,provider},created=await f.payments.create(product,input);
    if(provider==='alipay')f.env.ALIPAY_CHANNELS='';else f.env.WECHAT_CHANNELS='';
    const before=structuredClone(f.store.data),replay=await f.payments.create(product,input);
    expect(replay.id).toBe(created.id);expect(replay.channels).toEqual([]);
    await expect(f.payments.pay(String(created.id),provider==='alipay'?'page':'native')).rejects.toMatchObject({code:'PROVIDER_DISABLED'});
    expect(f.store.data).toEqual(before);expect(f.alipay.paymentUrl).not.toHaveBeenCalled();expect(f.wechat.create).not.toHaveBeenCalled();
  });
  it('accepts a verified late Alipay notification with retained credentials after Alipay purchases stop',async()=>{
    const f=fixture(),created=await f.payments.create(product,purchase);f.env.ALIPAY_CHANNELS='';
    const response=await f.call('/api/alipay/notify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({sign_type:'RSA2',app_id:f.env.ALIPAY_APP_ID,seller_id:f.env.ALIPAY_SELLER_ID,out_trade_no:String(created.id),total_amount:'3.00',trade_no:'2026102222001462921037601726',trade_status:'TRADE_SUCCESS'})});
    expect(response.status).toBe(200);expect((await f.payments.order(String(created.id))).status).toBe('PAID');expect(f.store.data.has(`events/evt_${created.id}.json`)).toBe(true);
  });
  it('accepts a verified late WeChat notification after Native purchases stop',async()=>{
    const f=fixture(),created=await f.payments.create(product,{...purchase,provider:'wechat'});f.env.WECHAT_CHANNELS='';
    vi.mocked(f.wechat.notification).mockResolvedValue({provider:'wechat',outTradeNo:String(created.id),totalAmount:'3.00',tradeNo:'4200000000202610221234567890',tradeStatus:'TRADE_SUCCESS',sellerId:f.env.WECHAT_MCH_ID,appId:f.env.WECHAT_APP_ID,currency:'CNY',paidAt:new Date().toISOString()});
    const response=await f.call('/api/wechat/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:'verified fixture'});
    expect(response.status).toBe(204);expect((await f.payments.order(String(created.id))).status).toBe('PAID');
    expect(f.store.data.has(`events/evt_${created.id}.json`)).toBe(true);
  });
  it('retains valid unselected adapters for late callbacks but ignores malformed unused credentials',()=>{
    const env=environment();env.ALIPAY_CHANNELS='';expect(service(env).gateway).toBeDefined();
    env.ALIPAY_PRIVATE_KEY='malformed-fixture';expect(service({...env}).gateway).toBeUndefined();expect(service({...env}).wechatGateway).toBeDefined();
  });
  it('reads WeChat orders through the default administrator service without constructing Alipay',async()=>{
    const f=fixture('wechat'),created=await f.payments.create(product,{...purchase,provider:'wechat'}),password='provider-mode-fixture-password',pepper='1'.repeat(64),salt='2'.repeat(64);
    const material=createHmac('sha256',pepper).update(password).digest('hex');
    Object.assign(f.env,{ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD_PEPPER:pepper,ADMIN_PASSWORD_HASH:`pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(material,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')}`,ADMIN_SESSION_SECRET:'e'.repeat(64),ADMIN_LOGIN_LIMITER:{limit:async()=>({success:true})}});
    const login=await adminLogin(new Request(f.env.PAY_BASE_URL+'/api/admin/login',{method:'POST',headers:{Origin:f.env.PAY_BASE_URL}}),f.env,{email:f.env.ADMIN_EMAIL,password});
    const cookie=login.headers.get('Set-Cookie')!.split(';')[0];
    const response=await handleAdmin(new Request(`${f.env.PAY_BASE_URL}/api/admin/orders/${created.id}`,{headers:{Cookie:cookie}}),f.env,f.store);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({order:{provider:'wechat',status:'PENDING'}});
  });
});
