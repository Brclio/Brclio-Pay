import {describe,expect,it,vi} from 'vitest';
import {createCipheriv,generateKeyPairSync,sign,verify} from 'node:crypto';
import {Payments,type Gateway,type Trade,type WechatGateway} from '../src/payments';
import {createWechat,wechatOrderNumber} from '../src/wechat';
import type {Delivery,Env,Order,ProductClient,Store,Transaction} from '../src/types';

const START=Date.UTC(2026,9,21,12),publicId='PUB_KEY_ID_10000000000000000000000000000001';
const pair=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const clone=<T>(value:T):T=>structuredClone(value);
class MemoryStore implements Store {
  data=new Map<string,unknown>();tail:Promise<unknown>=Promise.resolve();
  async readJson<T>(path:string):Promise<T|null>{await this.tail;return this.data.has(path)?clone(this.data.get(path)) as T:null;}
  transaction<T>(callback:(tx:Transaction)=>Promise<T>):Promise<T>{
    const result=this.tail.then(async()=>{const pending=new Map(this.data);const result=await callback({read:async<V>(path:string)=>pending.has(path)?clone(pending.get(path)) as V:null,put:(path,value)=>{pending.set(path,clone(value));}});this.data=pending;return result;});
    this.tail=result.catch(()=>{});return result;
  }
}
const client:ProductClient={id:'unified',name:'Unified',providers:['alipay','wechat'],apiSecret:'a'.repeat(40),webhookSecret:'w'.repeat(40),webhookUrl:'https://app.example.com/payment',returnOrigins:['https://app.example.com'],skus:{pro:{subject:'专业版',amount:'3.01'}}};
function environment():Env{return {ASSETS:{} as Fetcher,PAY_BASE_URL:'https://pay.bornforthis.cn',PAYMENT_MODE:'live',PAYMENT_ENABLED:'true',ALIPAY_CHANNELS:'page,wap',ALIPAY_APP_ID:'2021007109602288',ALIPAY_PRIVATE_KEY:pair.privateKey,ALIPAY_PUBLIC_KEY:pair.publicKey,ALIPAY_SELLER_ID:'2088123456789012',GITHUB_TOKEN:'fixture-token',GITHUB_REPOSITORY:'owner/private-payments',GITHUB_BRANCH:'main',CHECKOUT_SECRET:'c'.repeat(40),CLIENTS_JSON:JSON.stringify([client]),WECHAT_MCH_ID:'1234567890',WECHAT_APP_ID:'wx0123456789abcdef',WECHAT_SERIAL_NO:'A'.repeat(40),WECHAT_PRIVATE_KEY:pair.privateKey,WECHAT_API_V3_KEY:'v'.repeat(32),WECHAT_PUBLIC_KEYS_JSON:JSON.stringify({[publicId]:pair.publicKey}),WECHAT_PUBLIC_KEY_ID:publicId,WECHAT_CHANNELS:'native'};}
function fixture(){
  let now=START;const env=environment(),store=new MemoryStore();
  const alipay:Gateway={query:vi.fn(async()=>null),close:vi.fn(async()=>{}),verifyNotification:()=>true,paymentUrl:vi.fn(()=> 'https://openapi.alipay.com/gateway.do')};
  const wechat:WechatGateway={query:vi.fn(async()=>null),close:vi.fn(async()=>{}),create:vi.fn(async()=>({codeUrl:'weixin://wxpay/bizpayurl?pr=test'})),notification:vi.fn(async()=>{throw Error('No notification fixture');})};
  const payments=new Payments(env,store,alipay,()=>now,vi.fn(async()=>new Response('ok')) as typeof fetch,wechat);
  const create=(provider?:string)=>payments.create(client,{productOrderId:'business-1',sku:'pro',returnUrl:'https://app.example.com/account',...(provider?{provider}:{})});
  const paid=(id:string):Trade=>({provider:'wechat',outTradeNo:id,tradeNo:'4200000000202610211234567890',tradeStatus:'TRADE_SUCCESS',totalAmount:'3.01',sellerId:env.WECHAT_MCH_ID,appId:env.WECHAT_APP_ID,currency:'CNY',paidAt:new Date(START).toISOString()});
  return {env,store,alipay,wechat,payments,create,paid,setNow:(value:number)=>{now=value;}};
}
async function signedResponse(value:unknown,status=200,overrides:Record<string,string>={}):Promise<Response>{
  const raw=status===204?'':JSON.stringify(value),timestamp=String(Math.floor(START/1000)),nonce='fixture-response-nonce';
  const signature=sign('sha256',Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),pair.privateKey).toString('base64');
  return new Response(status===204?null:raw,{status,headers:{'Wechatpay-Timestamp':timestamp,'Wechatpay-Nonce':nonce,'Wechatpay-Serial':publicId,'Wechatpay-Signature':signature,...overrides}});
}
function providerTransaction(id:string,overrides:Record<string,unknown>={}){return {mchid:'1234567890',appid:'wx0123456789abcdef',out_trade_no:id,transaction_id:'4200000000202610211234567890',trade_state:'SUCCESS',trade_type:'NATIVE',success_time:'2026-10-21T20:00:00+08:00',amount:{total:301,currency:'CNY'},...overrides};}

describe('unified provider selection and immutable purchases',()=>{
  it('preserves omitted-provider Alipay retries and fixes a purchase to its first provider',async()=>{
    const f=fixture(),order=await f.create();expect(order.provider).toBe('alipay');expect(order.channels).toEqual(['page','wap']);
    const persisted=await f.payments.order(order.id as string);delete persisted.provider;f.store.data.set(`orders/${persisted.id}.json`,persisted);
    expect((await f.create('alipay')).id).toBe(order.id);
    await expect(f.create('wechat')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect(await f.payments.pay(order.id as string,'page')).toMatchObject({provider:'alipay',paymentUrl:'https://openapi.alipay.com/gateway.do'});
    expect(f.wechat.create).not.toHaveBeenCalled();
  });
  it('persists Native parameters per attempt and refuses a provider/channel switch',async()=>{
    const f=fixture(),order=await f.create('wechat'),id=order.id as string;
    expect(order).toMatchObject({provider:'wechat',channels:['native']});
    await expect(f.create('alipay')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await expect(f.payments.pay(id,'wap')).rejects.toMatchObject({code:'INVALID_CHANNEL'});
    const payment=await f.payments.pay(id,'native');expect(payment).toMatchObject({provider:'wechat',channel:'native',codeUrl:'weixin://wxpay/bizpayurl?pr=test'});
    expect(await f.payments.pay(id,'native')).toEqual(payment);expect(f.wechat.create).toHaveBeenCalledTimes(1);expect(f.alipay.paymentUrl).not.toHaveBeenCalled();
    expect((await f.payments.order(id)).paymentAttempts?.[0].codeUrl).toBe(payment.codeUrl);
  });
  it('denies unapproved providers without persisting a purchase',async()=>{
    const f=fixture();await expect(f.payments.create({...client,providers:undefined},{productOrderId:'business-1',sku:'pro',returnUrl:'https://app.example.com/account',provider:'wechat'})).rejects.toMatchObject({code:'PROVIDER_NOT_ALLOWED'});
    expect(f.store.data.size).toBe(0);
  });
  it('never creates a new WeChat prepay session during the final 90 seconds',async()=>{
    const f=fixture(),id=(await f.create('wechat')).id as string;f.setNow(START+9*60_000);
    await expect(f.payments.pay(id,'native')).rejects.toMatchObject({code:'ORDER_NOT_PAYABLE'});expect(f.wechat.create).not.toHaveBeenCalled();
  });
  it('keeps imported WeChat purchases readable when no return URL was configured',async()=>{
    const f=fixture(),id=(await f.create('wechat')).id as string,order=await f.payments.order(id);order.returnUrl='';order.status='CLOSED';
    expect(f.payments.view(order,client)).toMatchObject({id,provider:'wechat',returnUrl:'',status:'CLOSED'});
    await expect(f.payments.create(client,{productOrderId:'new-empty-return',sku:'pro',returnUrl:'',provider:'wechat'})).rejects.toMatchObject({code:'INVALID_URL'});
  });
  it('routes verified unpaid queries and expiry close only to the saved provider',async()=>{
    const f=fixture(),id=(await f.create('wechat')).id as string;
    vi.mocked(f.wechat.query).mockResolvedValue({...f.paid(id),tradeNo:'',tradeStatus:'WAIT_BUYER_PAY',totalAmount:'',paidAt:undefined,currency:undefined});
    expect((await f.payments.refresh(id)).status).toBe('PENDING');f.setNow(START+11*60_000);
    expect((await f.payments.refresh(id)).status).toBe('CLOSED');expect(f.wechat.close).toHaveBeenCalledWith(id);expect(f.alipay.query).not.toHaveBeenCalled();expect(f.alipay.close).not.toHaveBeenCalled();
  });
});
describe('unified payment proof and durable event identity',()=>{
  it('keeps WeChat on administrative reopen and records two paid attempts as one event plus overpayment',async()=>{
    const f=fixture(),id=(await f.create('wechat')).id as string;await f.payments.pay(id,'native');
    const closed=(attemptId:string):Trade=>({...f.paid(attemptId),tradeStatus:'TRADE_CLOSED',tradeNo:'',paidAt:undefined});
    vi.mocked(f.wechat.query).mockImplementation(async attemptId=>closed(attemptId));
    const action=async(action:'close'|'reopen',requestId:string)=>f.payments.adminAction(id,action,{expectedVersion:(await f.payments.adminDetail(id)).version,requestId,reason:'测试微信重新付款'},'admin@example.com',client);
    await action('close','wechat-close-01');const reopened=await action('reopen','wechat-reopen-01'),next=reopened.order.activeAttempt.id;
    expect(next).not.toBe(id);expect(reopened.order).toMatchObject({provider:'wechat',status:'PENDING',amount:'3.01'});
    await f.payments.pay(id,'native');expect(f.wechat.create).toHaveBeenLastCalledWith(expect.objectContaining({id:next,totalAmount:'3.01'}),expect.anything());
    await f.payments.applyTrade(f.paid(id));
    const second={...f.paid(next),tradeNo:'4200000000202610219999999999'};await f.payments.applyTrade(second);await f.payments.applyTrade(second);
    const order=await f.payments.order(id);expect(order.provider).toBe('wechat');expect(order.tradeNo).toBe(f.paid(id).tradeNo);expect(order.duplicatePayments).toHaveLength(1);
    expect([...f.store.data.keys()].filter(path=>path.startsWith('events/'))).toHaveLength(1);expect(f.alipay.query).not.toHaveBeenCalled();expect(f.alipay.close).not.toHaveBeenCalled();
  });
  it('continues closing issued unpaid WeChat attempts after another attempt pays',async()=>{
    const f=fixture(),id=(await f.create('wechat')).id as string;
    const original=await f.payments.order(id),next='pay_'+'f'.repeat(32);
    original.paymentAttempts=[{id,createdAt:original.createdAt,expiresAt:original.expiresAt,status:'PENDING',linkIssuedAt:original.createdAt},{id:next,createdAt:original.createdAt,expiresAt:original.expiresAt,status:'PENDING',linkIssuedAt:original.createdAt}];original.activeAttemptId=next;
    f.store.data.set(`orders/${id}.json`,original);await f.payments.applyTrade(f.paid(id));
    vi.mocked(f.wechat.query).mockResolvedValue({...f.paid(next),tradeStatus:'WAIT_BUYER_PAY',tradeNo:'',totalAmount:'',paidAt:undefined,currency:undefined});
    await f.payments.refresh(id);expect(f.wechat.close).toHaveBeenCalledWith(next);expect((await f.payments.order(id)).paymentAttempts?.find(attempt=>attempt.id===next)).toMatchObject({status:'CLOSED',closeConfirmed:true});
  });
  it('records a late verified WeChat payment once and preserves provider on delivery',async()=>{
    const f=fixture(),id=(await f.create('wechat')).id as string;f.setNow(START+11*60_000);await f.payments.refresh(id);
    vi.mocked(f.wechat.notification).mockResolvedValue(f.paid(id));
    expect((await f.payments.wechatNotification(new Headers(),'signed fixture')).status).toBe('PAID');
    await f.payments.wechatNotification(new Headers(),'duplicate signed fixture');
    const events=[...f.store.data.entries()].filter(([path])=>path.startsWith('events/'));expect(events).toHaveLength(1);
    expect((events[0][1] as Delivery).event.data).toMatchObject({provider:'wechat',orderId:id,amount:'3.01'});
  });
  it.each([{totalAmount:'0.01'},{sellerId:'9999999999'},{appId:'wx9999999999999999'},{currency:'USD'},{provider:'alipay'}])('rejects mismatched successful trades: %j',async changed=>{
    const f=fixture(),id=(await f.create('wechat')).id as string;
    await expect(f.payments.applyTrade({...f.paid(id),...changed} as Trade)).rejects.toMatchObject({code:'PAYMENT_MISMATCH'});
    expect((await f.payments.order(id)).status).toBe('PENDING');expect([...f.store.data.keys()].some(path=>path.startsWith('events/'))).toBe(false);
  });
  it('does not let a signed Alipay notification confirm a WeChat purchase',async()=>{
    const f=fixture(),id=(await f.create('wechat')).id as string;
    await expect(f.payments.notification({sign_type:'RSA2',app_id:f.env.ALIPAY_APP_ID,seller_id:f.env.ALIPAY_SELLER_ID,out_trade_no:id,total_amount:'3.01',trade_no:'2026102122001462921037601726',trade_status:'TRADE_SUCCESS'})).rejects.toMatchObject({code:'PAYMENT_MISMATCH'});
  });
});
describe('WeChat APIv3 transport and notification authenticity',()=>{
  it('uses a 32-character provider ID and signs the exact path and integer amount',async()=>{
    const env=environment(),id='pay_'+'a'.repeat(32);
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=new URL(String(input)),headers=new Headers(init?.headers),parameters=Object.fromEntries([...headers.get('Authorization')!.matchAll(/([a-z_]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
      expect(verify('sha256',Buffer.from(`${init?.method}\n${url.pathname}${url.search}\n${parameters.timestamp}\n${parameters.nonce_str}\n${init?.body||''}\n`),pair.publicKey,Buffer.from(parameters.signature,'base64'))).toBe(true);
      expect(init?.redirect).toBe('manual');expect(headers.get('Wechatpay-Serial')).toBe(publicId);
      expect(JSON.parse(init!.body as string)).toMatchObject({out_trade_no:'a'.repeat(32),amount:{total:301,currency:'CNY'},notify_url:'https://pay.bornforthis.cn/api/wechat/notify'});
      return signedResponse({code_url:'weixin://wxpay/bizpayurl?pr=verified'});
    });
    const adapter=createWechat(env,fetcher as typeof fetch,()=>START);
    expect(await adapter.create({id,subject:'专业版',totalAmount:'3.01',expiresAt:new Date(START+600_000).toISOString()},{notifyUrl:'https://pay.bornforthis.cn/api/wechat/notify'})).toEqual({codeUrl:'weixin://wxpay/bizpayurl?pr=verified'});
    expect(wechatOrderNumber(id)).toHaveLength(32);
  });
  it('normalizes a signed WeChat result to the unified identity and UTC payment time',async()=>{
    const adapter=createWechat(environment(),vi.fn(async()=>signedResponse(providerTransaction('a'.repeat(32)))) as typeof fetch,()=>START);
    expect(await adapter.query('pay_'+'a'.repeat(32))).toMatchObject({provider:'wechat',outTradeNo:'pay_'+'a'.repeat(32),tradeStatus:'TRADE_SUCCESS',totalAmount:'3.01',currency:'CNY',paidAt:new Date(START).toISOString()});
  });
  it('accepts an absent order only after verifying the signed provider error',async()=>{
    const adapter=createWechat(environment(),vi.fn(async()=>signedResponse({code:'ORDER_NOT_EXIST'},404)) as typeof fetch,()=>START);expect(await adapter.query('pay_'+'a'.repeat(32))).toBeNull();
    const unsigned=createWechat(environment(),vi.fn(async()=>Response.json({code:'ORDER_NOT_EXIST'},{status:404})) as typeof fetch,()=>START);await expect(unsigned.query('pay_'+'a'.repeat(32))).rejects.toMatchObject({code:'WECHAT_SIGNATURE_INVALID'});
  });
  const invalidHeaders:Record<string,string>[]=[{'Wechatpay-Serial':'PUB_KEY_ID_untrusted'},{'Wechatpay-Timestamp':String(Math.floor(START/1000)-301)},{'Wechatpay-Signature':'WECHATPAY/SIGNTEST/probe'}];
  it.each(invalidHeaders)('rejects untrusted signed-response metadata: %j',async headers=>{
    const adapter=createWechat(environment(),vi.fn(async()=>signedResponse(providerTransaction('a'.repeat(32)),200,headers)) as typeof fetch,()=>START);await expect(adapter.query('pay_'+'a'.repeat(32))).rejects.toMatchObject({code:'WECHAT_SIGNATURE_INVALID'});
  });
  it('verifies empty-body close responses',async()=>{
    const adapter=createWechat(environment(),vi.fn(async()=>signedResponse(undefined,204)) as typeof fetch,()=>START);await expect(adapter.close('pay_'+'a'.repeat(32))).resolves.toBeUndefined();
    const unsigned=createWechat(environment(),vi.fn(async()=>new Response(null,{status:204})) as typeof fetch,()=>START);await expect(unsigned.close('pay_'+'a'.repeat(32))).rejects.toMatchObject({code:'WECHAT_SIGNATURE_INVALID'});
  });
  it('verifies exact notification bytes before AES-GCM decryption and validates the decrypted identity',async()=>{
    const env=environment(),nonce='123456789012',associated='transaction',cipher=createCipheriv('aes-256-gcm',Buffer.from(env.WECHAT_API_V3_KEY!),Buffer.from(nonce));cipher.setAAD(Buffer.from(associated));
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(providerTransaction('a'.repeat(32))),'utf8'),cipher.final(),cipher.getAuthTag()]);
    const event={event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',original_type:'transaction',ciphertext:encrypted.toString('base64'),nonce,associated_data:associated}};
    const response=await signedResponse(event),raw=await response.text(),adapter=createWechat(env,undefined,()=>START);
    expect(await adapter.notification(response.headers,raw)).toMatchObject({outTradeNo:'pay_'+'a'.repeat(32),tradeStatus:'TRADE_SUCCESS',totalAmount:'3.01'});
    await expect(adapter.notification(response.headers,raw+' ')).rejects.toMatchObject({code:'WECHAT_SIGNATURE_INVALID'});
    const tampered={...event,resource:{...event.resource,associated_data:'another-resource'}},signedTampered=await signedResponse(tampered);await expect(adapter.notification(signedTampered.headers,await signedTampered.text())).rejects.toMatchObject({code:'NOTIFY_DECRYPT_FAILED'});
  });
});
