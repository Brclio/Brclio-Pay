import {allowedReturn,clients,HttpError,money,paymentChannels,requireInfrastructureReady,requireReady,requireThat} from './config';
import {hmacSha256,safeEqualHex,sha256} from './crypto';
import {Payments,providerOf} from './payments';
import type {Delivery,Env,Order,ProductClient} from './types';

const CENTER='https://paywc.bornforthis.cn';
type LegacyClient=ProductClient&{legacyWechat?:{id:string};wechatChannels?:string[]};
type LegacyOrder=Order&{legacyWechat?:{clientId:string;quantity:1;channel:'native';centerOrigin:string};wechatQuantity?:number;legacyWechatDelivery?:{status:string}};
type LegacyEnvironment=Env&{LEGACY_WECHAT_CHECKOUT_SECRET?:string};
const orderPath=(id:string)=>`orders/${id}.json`;
const cents=(value:string)=>Number(money(value).replace('.',''));
function legacyId(id:string):string {requireThat(/^pay_[a-f0-9]{32}$/.test(id),503,'ORDER_INTEGRITY','历史订单编号不正确');return id.slice(4);}
function token(id:string,env:LegacyEnvironment):string {
  requireThat(typeof env.LEGACY_WECHAT_CHECKOUT_SECRET==='string'&&env.LEGACY_WECHAT_CHECKOUT_SECRET.length>=32,503,'LEGACY_WECHAT_NOT_READY','历史微信收银台尚未完成配置');
  return hmacSha256(env.LEGACY_WECHAT_CHECKOUT_SECRET,`checkout:v1:${id}`);
}
async function rawBody(request:Request):Promise<string> {
  requireThat(Number(request.headers.get('Content-Length')||0)<=32768,413,'BODY_TOO_LARGE','请求正文过大');
  if(!request.body)return '';
  const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let total=0,raw='';
  try {for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>32768){await reader.cancel();throw new HttpError(413,'BODY_TOO_LARGE','请求正文过大');}raw+=decoder.decode(value,{stream:true});}return raw+decoder.decode();}
  catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'BODY_INVALID','请求正文编码不正确');}finally{reader.releaseLock();}
}
function authenticate(request:Request,raw:string,env:Env):LegacyClient {
  const id=request.headers.get('X-Brclio-Client')||'',timestamp=request.headers.get('X-Brclio-Timestamp')||'',nonce=request.headers.get('X-Brclio-Nonce')||'',signature=request.headers.get('X-Brclio-Signature')||'';
  requireThat(/^\d{10}$/.test(timestamp)&&Math.abs(Date.now()/1000-Number(timestamp))<=300&&/^[A-Za-z0-9_-]{16,128}$/.test(nonce)&&/^[a-f0-9]{64}$/.test(signature),401,'AUTH_INVALID','请求签名或时间戳不正确');
  const client=(clients(env) as LegacyClient[]).find(client=>client.legacyWechat?.id===id);
  requireThat(client&&(client.providers??[]).includes('wechat'),401,'AUTH_INVALID','请求签名或时间戳不正确');
  const url=new URL(request.url),canonical=`${request.method}\n${url.pathname+url.search}\n${timestamp}\n${nonce}\n${raw}\n`;
  requireThat(safeEqualHex(signature,hmacSha256(client.apiSecret,canonical)),401,'AUTH_INVALID','请求签名或时间戳不正确');
  return client;
}
function checkedOrder(order:Order,client?:LegacyClient):asserts order is LegacyOrder {
  requireThat(providerOf(order)==='wechat'&&(!client||order.clientId===client.id),404,'ORDER_NOT_FOUND','未找到该订单');
  requireThat((order as LegacyOrder).wechatQuantity===undefined||(order as LegacyOrder).wechatQuantity===1,409,'LEGACY_ORDER_UNSUPPORTED','此历史订单需要人工核对数量');
}
function publicOrder(order:LegacyOrder,client:LegacyClient,payments:Payments,env:LegacyEnvironment,withClient:boolean):Record<string,unknown> {
  const id=legacyId(order.id),expiresAt=payments.paymentExpiresAt(order),attempt=payments.activeAttempt(order),pending=order.status==='PENDING'&&!order.adminOperation&&Date.now()<Date.parse(expiresAt);
  const view:Record<string,unknown>={id,clientName:client.name,description:order.subject,amount:{total:cents(order.amount),currency:'CNY'},status:order.status==='PAID'?'SUCCESS':order.status,expiresAt,...(order.returnUrl?{returnUrl:order.returnUrl}:{}),...(pending&&attempt.codeUrl?{payment:{channel:'native',codeUrl:attempt.codeUrl}}:{}),deliveryStatus:order.status==='PAID'?(order.fulfillmentStatus==='delivered'?'delivered':'pending'):null};
  if(withClient)Object.assign(view,{clientId:client.legacyWechat!.id,merchantOrderId:order.productOrderId,sku:order.sku,quantity:1,...(order.tradeNo?{transactionId:order.tradeNo}:{}),...(order.paidAt?{paidAt:order.paidAt}:{}),checkoutUrl:`${CENTER}/checkout/${id}#token=${token(id,env)}`});
  return view;
}
async function scheduleDelivery(order:Order,client:ProductClient,payments:Payments,ctx:ExecutionContext,force=false):Promise<void> {
  if(order.status!=='PAID'||order.fulfillmentStatus==='delivered')return;
  const id=`evt_${order.id}`,path=`events/${id}.json`;
  const existing=await payments.store.readJson<Delivery>(path);
  // Migrated delivered purchases have no new outbox. Never synthesize one here.
  if(!existing||existing.deliveredAt)return;
  if(force)await payments.store.transaction(async tx=>{const delivery=await tx.read<Delivery>(path);if(delivery&&!delivery.deliveredAt&&(!delivery.leaseUntil||Date.parse(delivery.leaseUntil)<=Date.now())){delivery.nextAttemptAt=new Date().toISOString();tx.put(path,delivery);}});
  ctx.waitUntil(payments.deliver(id,client).catch(()=>console.warn('legacy_wechat_delivery_failed')));
}
async function route(request:Request,env:LegacyEnvironment,payments:Payments,ctx:ExecutionContext):Promise<Response> {
  const url=new URL(request.url),path=url.pathname;
  const checkout=/^\/api\/checkout\/([a-f0-9]{32})(\/refresh)?$/.exec(path);
  const api=/^\/api\/v1\/orders(?:\/([a-f0-9]{32})(?:\/(refresh|retry-notification))?)?$/.exec(path);
  requireThat(checkout||api,404,'NOT_FOUND','未找到历史微信接口');
  requireThat(env.PAYMENT_MODE==='live',503,'PAYMENTS_DISABLED','收款尚未启用');
  requireInfrastructureReady(env);
  if(checkout){
    requireThat(request.method===(checkout[2]?'POST':'GET'),405,'METHOD_NOT_ALLOWED','不支持此请求方式');
    const received=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
    requireThat(safeEqualHex(received,token(checkout[1],env)),401,'CHECKOUT_UNAUTHORIZED','收银台链接已失效或不完整，请从产品重新进入');
    requireThat(!request.headers.get('Origin')||request.headers.get('Origin')===CENTER,403,'ORIGIN_DENIED','此来源未登记');
    let order=await payments.order(`pay_${checkout[1]}`);checkedOrder(order);
    const client=(clients(env) as LegacyClient[]).find(client=>client.id===order.clientId&&client.legacyWechat&&(client.providers??[]).includes('wechat'));
    requireThat(client,503,'CLIENT_UNAVAILABLE','原产品接入配置缺失');
    if(checkout[2]||order.status==='PENDING'&&Date.now()>=Date.parse(payments.paymentExpiresAt(order)))order=await payments.refresh(order.id);
    await scheduleDelivery(order,client,payments,ctx);
    return Response.json(publicOrder(order,client,payments,env,false));
  }
  const [,externalId,action]=api!;
  requireThat(request.method===(externalId?(action?'POST':'GET'):'POST'),405,'METHOD_NOT_ALLOWED','不支持此请求方式');
  const raw=await rawBody(request),client=authenticate(request,raw,env);
  if(!externalId){
    requireThat(request.headers.get('Content-Type')?.split(';')[0].trim()==='application/json',415,'JSON_REQUIRED','请使用 application/json');
    let input:Record<string,unknown>;try{input=JSON.parse(raw);}catch{throw new HttpError(400,'JSON_INVALID','请求正文不是有效 JSON');}
    requireThat(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(key=>['merchantOrderId','sku','quantity','channel','expectedTotal','returnUrl'].includes(key)),400,'ORDER_FIELDS_INVALID','订单包含不支持的字段');
    requireThat(typeof input.merchantOrderId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(input.merchantOrderId)&&typeof input.sku==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(input.sku),400,'ORDER_INVALID','商品或业务订单号不正确');
    requireThat((input.quantity??1)===1&&(input.channel??'native')==='native',400,'CHANNEL_DISABLED','历史兼容接口仅支持单件 Native 支付');
    requireThat(Number.isSafeInteger(input.expectedTotal)&&Number(input.expectedTotal)>0,400,'INVALID_AMOUNT','请提供业务订单预期金额');
    requireThat(typeof input.returnUrl==='string'&&input.returnUrl.length<=2000,400,'RETURN_URL_INVALID','返回地址未登记');
    const index=await payments.store.readJson<{id:string}>(`indexes/${client.id}/${sha256(input.merchantOrderId)}.json`);
    const previous=index?await payments.order(index.id):null;
    let effectiveClient=client;
    if(previous){
      checkedOrder(previous,client);
      requireThat(cents(previous.amount)===input.expectedTotal,409,'CATALOG_PRICE_CHANGED','商品价格与业务订单预期不一致');
      // Existing purchases may outlive a catalog or return-origin update.
      if(previous.returnUrl)effectiveClient={...client,returnOrigins:[...client.returnOrigins,new URL(previous.returnUrl).origin]};
    }else{
      requireReady(env,true);requireThat(client.enabled!==false,403,'CLIENT_DISABLED','该产品已暂停创建新订单');
      requireThat(Object.hasOwn(client.skus,input.sku)&&client.skus[input.sku].enabled!==false,400,'ORDER_INVALID','商品或业务订单号不正确');
      requireThat(cents(client.skus[input.sku].amount)===input.expectedTotal,409,'CATALOG_PRICE_CHANGED','商品价格与业务订单预期不一致');
    }
    const returnUrl=allowedReturn(input.returnUrl,effectiveClient.returnOrigins);
    const created=await payments.create(effectiveClient,{productOrderId:input.merchantOrderId,sku:input.sku,returnUrl,provider:'wechat'});
    let order=await payments.order(String(created.id));checkedOrder(order,client);
    requireThat(cents(order.amount)===input.expectedTotal,409,'CATALOG_PRICE_CHANGED','商品价格与业务订单预期不一致');
    // This marker precedes every provider request, so a fast payment callback
    // always sees the fulfillment protocol selected by the originating product.
    order=await payments.store.transaction(async tx=>{const current=await tx.read<LegacyOrder>(orderPath(order.id));requireThat(current,503,'ORDER_INTEGRITY','订单记录缺失');checkedOrder(current,client);if(!current.legacyWechat){current.legacyWechat={clientId:client.legacyWechat!.id,quantity:1,channel:'native',centerOrigin:CENTER};tx.put(orderPath(current.id),current);}return current;});
    if(order.status==='PENDING'&&Date.now()>=Date.parse(payments.paymentExpiresAt(order)))order=await payments.refresh(order.id);
    if(order.status==='PENDING'&&client.enabled!==false&&env.PAYMENT_ENABLED==='true'&&paymentChannels(env,'wechat').includes('native')){
      const attempt=payments.activeAttempt(order);
      if(attempt.codeUrl||Date.parse(attempt.expiresAt)-Date.now()>=90_000){await payments.pay(order.id,'native');order=await payments.order(order.id);}
    }
    await scheduleDelivery(order,client,payments,ctx);
    return Response.json(publicOrder(order,client,payments,env,true),{status:201});
  }
  requireThat(raw===''||raw==='{}',400,'INVALID_REQUEST','此接口不接受参数');
  let order=await payments.order(`pay_${externalId}`);checkedOrder(order,client);
  if(action==='refresh'||!action&&order.status==='PENDING'&&Date.now()>=Date.parse(payments.paymentExpiresAt(order)))order=await payments.refresh(order.id);
  if(action==='retry-notification')requireThat(order.status==='PAID',409,'ORDER_NOT_PAID','仅已支付订单可以重试通知');
  await scheduleDelivery(order,client,payments,ctx,action==='retry-notification');
  return Response.json(publicOrder(order,client,payments,env,true));
}

/** Legacy XHS traffic shares the new ledger while retaining its exact wire protocol. */
export async function handleLegacyWechat(request:Request,env:Env,payments:Payments,ctx:ExecutionContext):Promise<Response> {
  try {const response=await route(request,env,payments,ctx);response.headers.set('Cache-Control','no-store');return response;}
  catch(error){const status=error instanceof HttpError?error.status:503,code=error instanceof HttpError?error.code:'SERVICE_UNAVAILABLE',message=error instanceof HttpError?error.message:'支付服务暂时不可用，请稍后重试';return Response.json({error:{code,message}},{status,headers:{'Cache-Control':'no-store'}});}
}
