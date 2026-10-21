import {describe,expect,it,vi} from 'vitest';
import {URL as NodeURL} from 'node:url';
import {Payments,type Gateway,type WechatGateway} from '../src/payments';
import type {Delivery,Env,Order,ProductClient,Store,Transaction,WorkQueue} from '../src/types';
const START=Date.UTC(2026,9,21,12),EXTERNAL_CLIENT='p-2bb6d77a673327a2f8d881bac2d4fe26';
class MemoryStore implements Store {
  data=new Map<string,unknown>();
  async readJson<T>(path:string):Promise<T|null>{return this.data.has(path)?structuredClone(this.data.get(path)) as T:null;}
  async transaction<T>(callback:(tx:Transaction)=>Promise<T>):Promise<T>{
    const next=new Map(this.data),value=await callback({read:async<V>(path:string)=>next.has(path)?structuredClone(next.get(path)) as V:null,put:(path,value)=>{next.set(path,structuredClone(value));}});this.data=next;return value;
  }
}
function fixture(overrides:Partial<ProductClient>={}){
  let now=START;
  const client:ProductClient={id:'mapped-wechat-product',name:'Legacy product',apiSecret:'a'.repeat(48),webhookSecret:'w'.repeat(48),webhookUrl:'https://product.example/wechat/webhook',returnOrigins:['https://product.example'],skus:{pro:{subject:'专业版',amount:'3.01'}},providers:['wechat'],legacyWechat:{id:EXTERNAL_CLIENT},...overrides};
  const env:Env={ASSETS:{} as Fetcher,PAY_BASE_URL:'https://pay.bornforthis.cn',PAYMENT_MODE:'live',PAYMENT_ENABLED:'true',ALIPAY_CHANNELS:'page',ALIPAY_APP_ID:'2021007109602288',ALIPAY_PRIVATE_KEY:'fixture',ALIPAY_PUBLIC_KEY:'fixture',ALIPAY_SELLER_ID:'2088123456789012',GITHUB_TOKEN:'fixture',GITHUB_REPOSITORY:'owner/private',GITHUB_BRANCH:'main',CHECKOUT_SECRET:'c'.repeat(48),CLIENTS_JSON:JSON.stringify([client]),WECHAT_APP_ID:'wx0123456789abcdef',WECHAT_MCH_ID:'1234567890'};
  const alipay:Gateway={query:async()=>null,close:async()=>{},verifyNotification:()=>true,paymentUrl:()=>''};
  const wechat:WechatGateway={query:async()=>null,close:async()=>{},create:async()=>({codeUrl:'weixin://wxpay/bizpayurl?pr=fixture'}),notification:async()=>{throw Error('not used');}};
  const requests:Request[]=[],send=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{requests.push(new Request(input,init));return new Response('ok');}) as typeof fetch;
  const store=new MemoryStore(),payments=new Payments(env,store,alipay,()=>now,send,wechat);
  const paid=async(marker=false)=>{
    const created=await payments.create(client,{productOrderId:'member-order-1',sku:'pro',returnUrl:'https://product.example/return',provider:'wechat'}),id=created.id as string;
    if(marker){const order=(await store.readJson<Order>(`orders/${id}.json`))!;order.legacyWechat={clientId:EXTERNAL_CLIENT,quantity:1,channel:'native',centerOrigin:'https://paywc.bornforthis.cn'};store.data.set(`orders/${id}.json`,order);}
    await payments.applyTrade({provider:'wechat',outTradeNo:id,tradeNo:'4200000000202610211234567890',tradeStatus:'TRADE_SUCCESS',totalAmount:'3.01',sellerId:env.WECHAT_MCH_ID,appId:env.WECHAT_APP_ID,currency:'CNY',paidAt:new Date(START).toISOString()});
    return id;
  };
  return {client,env,payments,store,requests,send,paid,setNow:(value:number)=>{now=value;}};
}
const legacyVerifier=async()=> (await import(new NodeURL('./fixtures/legacy-wechat-client.mjs',import.meta.url).href)).verifyBrclioWechatPayEvent;

describe('existing XHS WeChat fulfillment protocol',()=>{
  it('passes the unmodified XHS verifier and retains one internal outbox event',async()=>{
    const f=fixture(),id=await f.paid();await f.payments.deliver(`evt_${id}`,f.client);
    const request=f.requests[0],rawBody=await request.text(),verify=await legacyVerifier();
    const event=verify({rawBody,headers:request.headers,webhookSecret:f.client.webhookSecret,clientId:EXTERNAL_CLIENT,now:START});
    expect(event).toEqual({eventId:`payment.success.${id.slice(4)}`,type:'payment.success',orderId:id.slice(4),clientId:EXTERNAL_CLIENT,merchantOrderId:'member-order-1',sku:'pro',quantity:1,total:301,currency:'CNY',transactionId:'4200000000202610211234567890',paidAt:new Date(START).toISOString()});
    expect(request.headers.get('X-Brclio-Nonce')).toMatch(/^[a-f0-9]{32}$/);
    const delivery=(await f.store.readJson<Delivery>(`events/evt_${id}.json`))!;
    expect(delivery.event.id).toBe(`evt_${id}`);expect(delivery.event.type).toBe('payment.paid');expect(delivery.event.data.clientId).toBe(f.client.id);
    expect(delivery).toMatchObject({webhookProtocol:'wechat-legacy-v1',webhookClientId:EXTERNAL_CLIENT,deliveredAt:new Date(START).toISOString(),attempts:1});
    expect((await f.store.readJson<Order>(`orders/${id}.json`))?.fulfillmentStatus).toBe('delivered');
    expect((await f.store.readJson<WorkQueue>('system/queue.json'))?.deliveries).toEqual([]);
    await f.payments.deliver(`evt_${id}`,f.client);expect(f.requests).toHaveLength(1);
    expect([...f.store.data.keys()].filter(path=>path.startsWith('events/'))).toEqual([`events/evt_${id}.json`]);
  });
  it('fixes marker identity at payment confirmation and keeps its format across retries/config changes',async()=>{
    const f=fixture({webhookProtocol:'brclio-v1',legacyWechat:undefined}),id=await f.paid(true);
    const newer={...f.client,legacyWechat:undefined,webhookProtocol:'brclio-v1' as const};f.env.CLIENTS_JSON=JSON.stringify([newer]);
    let attempts=0;
    f.payments.send=async(input,init)=>{f.requests.push(new Request(input,init));return new Response('retry',{status:++attempts===1?503:200});};
    await f.payments.deliver(`evt_${id}`,newer);const first=(await f.store.readJson<Delivery>(`events/evt_${id}.json`))!;
    expect(first.deliveredAt).toBeUndefined();f.setNow(Date.parse(first.nextAttemptAt));await f.payments.deliver(`evt_${id}`,newer);
    const verify=await legacyVerifier(),events=[];
    for(const request of f.requests)events.push(verify({rawBody:await request.text(),headers:request.headers,webhookSecret:f.client.webhookSecret,clientId:EXTERNAL_CLIENT,now:Date.parse(first.nextAttemptAt)}));
    expect(events[0]).toEqual(events[1]);expect(events[0].eventId).toBe(`payment.success.${id.slice(4)}`);
    expect(f.requests[0].headers.get('X-Brclio-Nonce')).not.toBe(f.requests[1].headers.get('X-Brclio-Nonce'));
  });
  it('uses explicit unified protocol even when migrated client metadata remains',async()=>{
    const f=fixture({webhookProtocol:'brclio-v1'}),id=await f.paid();await f.payments.deliver(`evt_${id}`,f.client);
    const request=f.requests[0],rawBody=await request.text();
    const {verifyPaymentEvent}=await import(new NodeURL('../examples/payment-client.mjs',import.meta.url).href);
    expect(verifyPaymentEvent({rawBody,headers:request.headers,webhookSecret:f.client.webhookSecret,clientId:f.client.id,now:START})).toMatchObject({id:`evt_${id}`,type:'payment.paid',data:{orderId:id,provider:'wechat'}});
    expect(request.headers.get('X-Brclio-Nonce')).toBeNull();
    expect((await f.store.readJson<Delivery>(`events/evt_${id}.json`))?.webhookProtocol).toBe('brclio-v1');
  });
  it('upgrades an unsent historical outbox snapshot without replaying a delivered event',async()=>{
    const f=fixture(),id=await f.paid(),key=`events/evt_${id}.json`,delivery=(await f.store.readJson<Delivery>(key))!;
    delete delivery.webhookProtocol;delete delivery.webhookClientId;f.store.data.set(key,delivery);
    await f.payments.deliver(`evt_${id}`,f.client);
    expect((await f.store.readJson<Delivery>(key))?.webhookProtocol).toBe('wechat-legacy-v1');
    const finished=(await f.store.readJson<Delivery>(key))!;delete finished.webhookProtocol;delete finished.webhookClientId;f.store.data.set(key,finished);
    await f.payments.deliver(`evt_${id}`,f.client);expect(f.requests).toHaveLength(1);
    expect((await f.store.readJson<Delivery>(key))?.webhookProtocol).toBeUndefined();
  });
});
