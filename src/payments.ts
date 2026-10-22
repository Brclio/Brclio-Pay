import type {Env,Order,PaymentAttempt,ProductClient,Store,Transaction,Delivery,WorkQueue,PaymentProvider} from './types';
import {allowedReturn,clients,money,paymentChannels,requireThat,requireReady} from './config';
import {sha256,hmacSha256,randomId} from './crypto';
import {checkoutToken} from './auth';
import {indexOrder} from './reporting';
import {alipayPaidAt} from './alipay-time';
export interface Trade {
  outTradeNo: string; tradeNo: string; tradeStatus: string; totalAmount: string; sellerId?: string; paidAt?: string;
  provider?: PaymentProvider; appId?: string; currency?: string;
}
export interface Gateway {query(id:string):Promise<Trade|null>;close(id:string):Promise<void>;verifyNotification(data:Record<string,string>):boolean;paymentUrl(order:{id:string;subject:string;totalAmount:string;expiresAt?:string},options:{channel:'page'|'wap';pageReturnUrl:string;notifyUrl:string}):string}
export interface WechatGateway {query(id:string):Promise<Trade|null>;close(id:string):Promise<void>;create(order:{id:string;subject:string;totalAmount:string;expiresAt?:string},options:{notifyUrl:string}):Promise<{codeUrl:string}>;notification(headers:Headers,raw:string):Promise<Trade>}
export const providerOf=(order:Pick<Order,'provider'>):PaymentProvider=>order.provider??'alipay';
const PAYMENT_WINDOW_MS = 10 * 60_000;
const orderPath = (id:string) => `orders/${id}.json`;
const eventId = (id:string) => `evt_${id}`;
const deliveryPath = (id:string) => `events/${id}.json`;
const emptyQueue = ():WorkQueue => ({orders:[],deliveries:[]});
const attemptPath=(id:string)=>`payment-attempts/${id}.json`;
const actionPath=(id:string,requestId:string)=>`order-actions/${id}/${sha256(requestId)}.json`;
const paidStatus=(status:string)=>['TRADE_SUCCESS','TRADE_FINISHED'].includes(status);
export type AdminOrderAction='close'|'reopen'|'reconcile';
export interface OrderActionInput {expectedVersion:string;requestId:string;reason:string}
interface OrderActionRecord {
  requestId:string;action:AdminOrderAction;actor:string;reason:string;fingerprint:string;
  startedAt:string;completedAt?:string;status:'running'|'completed'|'failed';
  beforeStatus:Order['status'];afterStatus?:Order['status'];attemptId?:string;errorCode?:string;message?:string;
}
interface AttemptMapping {orderId:string;mode:Order['mode']}
interface SettledAttempt {trade:Trade|null;closed:boolean;failed?:boolean;error?:unknown}
const operationVersion=(order:Order)=>sha256(JSON.stringify(order));
function confirmedPaidAt(value:unknown,now:number):string {
  // Older/provider responses without a payment time keep the original receipt
  // time contract. Never replace an explicitly supplied invalid timestamp.
  if(value===undefined)return new Date(now).toISOString();
  requireThat(typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value),400,'PAYMENT_MISMATCH','付款时间无效');
  const time=Date.parse(value);
  requireThat(Number.isFinite(time) && new Date(time).toISOString().slice(0,19)===value.slice(0,19) && time<=now+300_000,400,'PAYMENT_MISMATCH','付款时间无效');
  return new Date(time).toISOString();
}
export class Payments {
  constructor(public env:Env,public store:Store,public gateway:Gateway|undefined,public now:()=>number=Date.now,public send:typeof fetch=(input,init)=>globalThis.fetch(input,init),public wechatGateway?:WechatGateway) {}
  private alipayGateway():Gateway {
    requireThat(this.gateway,503,'ALIPAY_NOT_READY','支付宝尚未完成配置');return this.gateway;
  }
  private requireProviderEnabled(provider:PaymentProvider):void {
    requireThat(paymentChannels(this.env,provider).length>0,503,'PROVIDER_DISABLED','该支付方式尚未启用');
    if(provider==='alipay')this.alipayGateway();
    else requireThat(this.env.PAYMENT_MODE==='live'&&this.wechatGateway,503,'WECHAT_NOT_READY','微信支付尚未完成配置');
  }
  private gatewayFor(order:Order):Pick<Gateway,'query'|'close'> {
    if(providerOf(order)==='alipay')return this.alipayGateway();
    requireThat(this.wechatGateway,503,'WECHAT_NOT_READY','微信支付尚未完成配置');return this.wechatGateway;
  }
  async order(id:string):Promise<Order> {
    requireThat(/^pay_[a-f0-9]{32}$/.test(id),404,'NOT_FOUND','订单不存在');
    const order = await this.store.readJson<Order>(orderPath(id));
    requireThat(order,404,'NOT_FOUND','订单不存在');
    requireThat(order.mode===this.env.PAYMENT_MODE,409,'ENVIRONMENT_MISMATCH','订单不属于当前支付环境');
    return order;
  }
  async create(client:ProductClient,body:unknown):Promise<Record<string,unknown>> {
    requireThat(body && typeof body === 'object' && !Array.isArray(body),400,'INVALID_REQUEST','订单参数错误');
    const input = body as Record<string,unknown>;
    requireThat(Object.keys(input).every(k=>['productOrderId','sku','returnUrl','provider'].includes(k)),400,'INVALID_REQUEST','仅允许 productOrderId、sku、returnUrl、provider');
    requireThat(input.provider===undefined||input.provider==='alipay'||input.provider==='wechat',400,'INVALID_PROVIDER','支付方式不正确');
    const provider:PaymentProvider=input.provider==='wechat'?'wechat':'alipay';
    requireThat(typeof input.productOrderId === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(input.productOrderId) && typeof input.sku === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(input.sku) && typeof input.returnUrl === 'string' && input.returnUrl.length <= 2000,400,'INVALID_REQUEST','业务订单或商品参数错误');
    const returnUrl = allowedReturn(input.returnUrl,client.returnOrigins);
    const index = `indexes/${client.id}/${sha256(input.productOrderId)}.json`;
    const id = randomId('pay_');
    const now = this.now();
    const order = await this.store.transaction(async tx => {
      const existing = await tx.read<{id:string}>(index);
      if (existing) {
        const previous = await tx.read<Order>(orderPath(existing.id));
        requireThat(previous?.mode===this.env.PAYMENT_MODE,409,'ENVIRONMENT_MISMATCH','订单不属于当前支付环境');
        // Compare the retry with the saved purchase, not today's mutable SKU.
        // Reconstruct the old hash so previously persisted orders remain valid.
        const replayHash=previous && sha256(JSON.stringify({productOrderId:input.productOrderId,sku:input.sku,returnUrl,amount:previous.amount,subject:previous.subject,...(provider==='wechat'?{provider}:{})}));
        requireThat(previous && providerOf(previous)===provider && previous.clientId===client.id && previous.productOrderId===input.productOrderId && previous.sku===input.sku && previous.returnUrl===returnUrl && previous.requestHash===replayHash,409,'IDEMPOTENCY_CONFLICT','相同业务订单号不能修改支付方式、商品或返回地址');
        await indexOrder(tx,previous);
        return previous;
      }
      requireThat(Object.hasOwn(client.skus,input.sku as string),400,'INVALID_REQUEST','业务订单或商品参数错误');
      requireThat((client.providers??['alipay']).includes(provider),403,'PROVIDER_NOT_ALLOWED','该产品尚未启用此支付方式');
      this.requireProviderEnabled(provider);
      const item=client.skus[input.sku as string];
      requireThat(item.enabled!==false,403,'SKU_DISABLED','该商品已停售');
      const requestHash=sha256(JSON.stringify({productOrderId:input.productOrderId,sku:input.sku,returnUrl,amount:item.amount,subject:item.subject,...(provider==='wechat'?{provider}:{})}));
      const queue = await tx.read<WorkQueue>('system/queue.json') || emptyQueue();
      requireThat(queue.orders.length < 2000,503,'CAPACITY','待支付订单过多，请稍后再试');
      const created:Order = {id,provider,mode:this.env.PAYMENT_MODE,clientId:client.id,productOrderId:input.productOrderId as string,sku:input.sku as string,subject:item.subject,amount:money(item.amount),status:'PENDING',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+PAYMENT_WINDOW_MS).toISOString(),returnUrl,requestHash,fulfillmentStatus:'pending',attemptTrackingVersion:1};
      tx.put(orderPath(id),created); tx.put(index,{id});
      queue.orders.push(id); tx.put('system/queue.json',queue);
      await indexOrder(tx,created);
      return created;
    });
    return {...this.view(order,client), checkoutUrl:`${this.env.PAY_BASE_URL}/checkout/${order.id}#token=${checkoutToken(order.id,this.env)}`, productOrderId:order.productOrderId,sku:order.sku};
  }
  view(order:Order,client:ProductClient) {
    return {id:order.id,provider:providerOf(order),subject:order.subject,amount:order.amount,currency:'CNY',status:order.status,productName:client.name,expiresAt:this.paymentExpiresAt(order),returnUrl:this.returnUrl(order),fulfillmentStatus:order.fulfillmentStatus,mode:order.mode,channels:paymentChannels(this.env,providerOf(order))};
  }
  paymentExpiresAt(order:Order):string {
    if(order.paymentAttempts)return this.activeAttempt(order).expiresAt;
    // Apply the shorter policy to legacy pending purchases without rewriting
    // their original purchase snapshots or extending an earlier deadline.
    return order.status==='PENDING' ? new Date(Math.min(Date.parse(order.expiresAt),Date.parse(order.createdAt)+PAYMENT_WINDOW_MS)).toISOString() : order.expiresAt;
  }
  activeAttempt(order:Order):PaymentAttempt {
    if(order.paymentAttempts){
      const attempt=order.paymentAttempts.find(item=>item.id===(order.activeAttemptId??order.id));
      requireThat(attempt,503,'ORDER_INTEGRITY','订单付款记录异常');return attempt;
    }
    return {id:order.id,createdAt:order.createdAt,expiresAt:new Date(Math.min(Date.parse(order.expiresAt),Date.parse(order.createdAt)+PAYMENT_WINDOW_MS)).toISOString(),status:order.status,...(!order.attemptTrackingVersion?{linkIssuedAt:order.createdAt,linkExpiresAt:order.expiresAt}:{}),...(order.tradeNo?{tradeNo:order.tradeNo}:{}),...(order.paidAt?{paidAt:order.paidAt}:{})};
  }
  private attempts(order:Order):PaymentAttempt[]{return order.paymentAttempts??[this.activeAttempt(order)];}
  private cleanupAttempts(order:Order):PaymentAttempt[]{
    return order.status==='PAID'?this.attempts(order).filter(attempt=>attempt.status!=='PAID'&&!attempt.closeConfirmed&&!!attempt.linkIssuedAt):[];
  }
  private async syncCleanupQueue(tx:Transaction,order:Order):Promise<void>{
    const queue=await tx.read<WorkQueue>('system/queue.json')||emptyQueue(),pending=this.cleanupAttempts(order).length>0;
    const exists=queue.orders.includes(order.id);
    if(pending&&!exists){queue.orders.push(order.id);tx.put('system/queue.json',queue);}
    else if(!pending&&exists){queue.orders=queue.orders.filter(id=>id!==order.id);tx.put('system/queue.json',queue);}
  }
  private trackAttempts(order:Order):void {
    if(!order.paymentAttempts){
      const attempt=this.activeAttempt(order);
      // Historical releases issued signed URLs without a durable reservation.
      // Until their original deadline, conservatively treat them as issued.
      if(!order.attemptTrackingVersion){attempt.linkIssuedAt=order.createdAt;attempt.linkExpiresAt=order.expiresAt;}
      order.paymentAttempts=[attempt];order.activeAttemptId=order.id;
    }
  }
  private checkedOrder(order:Order|null|undefined):asserts order is Order {
    requireThat(order,404,'NOT_FOUND','订单不存在');
    requireThat(order.mode===this.env.PAYMENT_MODE,409,'ENVIRONMENT_MISMATCH','订单不属于当前支付环境');
  }
  private async logicalOrderForTrade(tx:Transaction,id:string):Promise<Order> {
    requireThat(/^pay_[a-f0-9]{32}$/.test(id),404,'NOT_FOUND','订单不存在');
    const direct=await tx.read<Order>(orderPath(id));
    if(direct){this.checkedOrder(direct);return direct;}
    const mapping=await tx.read<AttemptMapping>(attemptPath(id));
    requireThat(mapping&&mapping.mode===this.env.PAYMENT_MODE,404,'NOT_FOUND','订单不存在');
    const order=await tx.read<Order>(orderPath(mapping.orderId));this.checkedOrder(order);
    requireThat(this.attempts(order).some(attempt=>attempt.id===id),503,'ORDER_INTEGRITY','订单付款记录异常');return order;
  }
  /** Reserve before issuing a signed provider URL. An administrator operation
   * blocks new links; its final CAS sees every reservation made before it. */
  async preparePayment(id:string):Promise<Order> {
    await this.order(id);
    return this.store.transaction(async tx=>{
      const order=await tx.read<Order>(orderPath(id));this.checkedOrder(order);
      requireThat(!order.adminOperation,409,'ORDER_OPERATION_IN_PROGRESS','订单正在处理，请稍后重试');
      const attempt=this.activeAttempt(order);
      requireThat(order.status==='PENDING'&&attempt.status==='PENDING'&&this.now()<Date.parse(attempt.expiresAt),409,'ORDER_NOT_PAYABLE','订单已支付、关闭或过期，请返回产品重新发起');
      const wasTracked=!!order.paymentAttempts;this.trackAttempts(order);const active=this.activeAttempt(order);
      if(!active.linkIssuedAt){active.linkIssuedAt=new Date(this.now()).toISOString();active.linkExpiresAt=active.expiresAt;tx.put(orderPath(id),order);}
      else if(!wasTracked)tx.put(orderPath(id),order);
      return order;
    });
  }
  /** Checkout credentials protect both signed Alipay URLs and Native QR data. */
  async pay(id:string,channel:string,pageReturnUrl=`${this.env.PAY_BASE_URL}/payment/return?payment_order_id=${encodeURIComponent(id)}`):Promise<{provider:PaymentProvider;channel:string;paymentUrl?:string;codeUrl?:string}> {
    const existing=await this.order(id),provider=providerOf(existing);
    this.requireProviderEnabled(provider);
    requireThat(paymentChannels(this.env,provider).includes(channel),400,'INVALID_CHANNEL','支付通道不正确');
    const order=await this.preparePayment(id),attempt=this.activeAttempt(order);
    if(provider==='alipay')return {provider,channel,paymentUrl:this.alipayGateway().paymentUrl({id:attempt.id,subject:order.subject,totalAmount:order.amount,expiresAt:attempt.expiresAt},{channel:channel as 'page'|'wap',pageReturnUrl,notifyUrl:`${this.env.PAY_BASE_URL}/api/alipay/notify`})};
    requireThat(this.wechatGateway,503,'WECHAT_NOT_READY','微信支付尚未完成配置');
    if(attempt.codeUrl)return {provider,channel,codeUrl:attempt.codeUrl};
    requireThat(Date.parse(attempt.expiresAt)-this.now()>=90_000,409,'ORDER_NOT_PAYABLE','订单即将过期，请返回产品重新发起');
    const payment=await this.wechatGateway.create({id:attempt.id,subject:order.subject,totalAmount:order.amount,expiresAt:attempt.expiresAt},{notifyUrl:`${this.env.PAY_BASE_URL}/api/wechat/notify`});
    await this.store.transaction(async tx=>{
      const current=await tx.read<Order>(orderPath(id));this.checkedOrder(current);
      requireThat(providerOf(current)==='wechat'&&current.status==='PENDING'&&!current.adminOperation&&this.activeAttempt(current).id===attempt.id&&this.now()<Date.parse(attempt.expiresAt),409,'ORDER_NOT_PAYABLE','订单已支付、关闭或过期，请返回产品重新发起');
      this.activeAttempt(current).codeUrl=payment.codeUrl;tx.put(orderPath(id),current);
    });
    return {provider,channel,codeUrl:payment.codeUrl};
  }
  returnUrl(order:Order):string {
    // Legacy WeChat purchases allowed no product return URL. Preserve that
    // historical absence while keeping the order and its payment facts readable.
    if(providerOf(order)==='wechat'&&!order.returnUrl)return '';
    const url = new URL(order.returnUrl); url.searchParams.set('payment_order_id',order.id); url.searchParams.set('product_order_id',order.productOrderId); return url.toString();
  }
  private validateTrade(order:Order,trade:Trade):PaymentAttempt {
    const attempt=this.attempts(order).find(item=>item.id===trade.outTradeNo);
    requireThat(attempt,400,'PAYMENT_MISMATCH','查询交易号不匹配');
    const provider=providerOf(order);
    requireThat((trade.provider??'alipay')===provider,400,'PAYMENT_MISMATCH','支付方式与订单不匹配');
    // WeChat omits amount on some verified unpaid/closed query responses.
    const missingUnpaidAmount=provider==='wechat'&&!paidStatus(trade.tradeStatus)&&trade.totalAmount==='';
    requireThat((missingUnpaidAmount||money(trade.totalAmount)===order.amount)&&(provider==='wechat'?trade.sellerId===this.env.WECHAT_MCH_ID&&trade.appId===this.env.WECHAT_APP_ID&&(!paidStatus(trade.tradeStatus)||trade.currency==='CNY'):!trade.sellerId||trade.sellerId===this.env.ALIPAY_SELLER_ID),400,'PAYMENT_MISMATCH','交易信息与订单不匹配');
    requireThat(!attempt.tradeNo||!trade.tradeNo&&!paidStatus(trade.tradeStatus)||attempt.tradeNo===trade.tradeNo,400,'PAYMENT_MISMATCH','支付交易号不匹配');
    return attempt;
  }
  private async applyTradeInTransaction(tx:Transaction,order:Order,trade:Trade,observedAt:number):Promise<Order> {
    const attempt=this.validateTrade(order,trade),now=new Date(observedAt).toISOString();
    if(paidStatus(trade.tradeStatus)){
      requireThat(/^\d{10,64}$/.test(trade.tradeNo),400,'PAYMENT_MISMATCH','支付交易号无效');
      if(order.status==='PAID'){
        // The same provider attempt cannot change its transaction identity. A
        // genuinely distinct paid attempt is retained for manual overpayment
        // handling without issuing a second product entitlement or revenue row.
        if(attempt.tradeNo===trade.tradeNo||order.tradeNo===trade.tradeNo){await indexOrder(tx,order);return order;}
        const paidAt=confirmedPaidAt(trade.paidAt,observedAt);
        this.trackAttempts(order);const extra=this.attempts(order).find(item=>item.id===trade.outTradeNo)!;
        extra.status='PAID';extra.tradeNo=trade.tradeNo;extra.paidAt=paidAt;
        order.duplicatePayments??=[];
        if(!order.duplicatePayments.some(item=>item.tradeNo===trade.tradeNo))order.duplicatePayments.push({attemptId:trade.outTradeNo,tradeNo:trade.tradeNo,paidAt,amount:order.amount});
        tx.put(orderPath(order.id),order);await this.syncCleanupQueue(tx,order);await indexOrder(tx,order);return order;
      }
      const paidAt=confirmedPaidAt(trade.paidAt,observedAt);
      if(order.paymentAttempts){attempt.status='PAID';attempt.tradeNo=trade.tradeNo;attempt.paidAt=paidAt;}
      order.status='PAID';order.tradeNo=trade.tradeNo;order.paidAt=paidAt;
      for(const other of this.attempts(order))if(other.status!=='PAID'&&!other.linkIssuedAt){other.status='CLOSED';other.closeConfirmed=true;other.closedAt??=now;}
      const id=eventId(order.id);
      const existing=await tx.read<Delivery>(deliveryPath(id));
      if(!existing){
        const client=clients(this.env).find(item=>item.id===order.clientId);
        const legacy=!!order.legacyWechat||client?.webhookProtocol==='wechat-legacy-v1'||(!client?.webhookProtocol&&!!client?.legacyWechat);
        const delivery:Delivery={event:{id,type:'payment.paid',mode:order.mode,createdAt:now,data:{orderId:order.id,productOrderId:order.productOrderId,clientId:order.clientId,sku:order.sku,amount:order.amount,currency:'CNY',tradeNo:trade.tradeNo,paidAt,...(order.provider?{provider:order.provider}:{})}},attempts:0,nextAttemptAt:now,
          webhookProtocol:legacy?'wechat-legacy-v1':'brclio-v1',webhookClientId:legacy?(order.legacyWechat?.clientId??client?.legacyWechat?.id??order.clientId):order.clientId};
        tx.put(deliveryPath(id),delivery);
      }
      const queue=await tx.read<WorkQueue>('system/queue.json')||emptyQueue();
      const needsCleanup=this.cleanupAttempts(order).length>0;
      if(!needsCleanup)queue.orders=queue.orders.filter(item=>item!==order.id);
      else if(!queue.orders.includes(order.id))queue.orders.push(order.id);
      if(!existing?.deliveredAt&&!queue.deliveries.includes(id))queue.deliveries.push(id);
      tx.put('system/queue.json',queue);
    }else if(trade.tradeStatus==='TRADE_CLOSED'){
      if(order.status==='PAID')return order;
      if(order.paymentAttempts){attempt.status='CLOSED';attempt.closeConfirmed=true;attempt.closedAt=attempt.closedAt??now;}
      // A late closed notification for an old attempt must not close a newly
      // reopened checkout that has a distinct provider order number.
      if(this.activeAttempt(order).id===trade.outTradeNo){
        order.status='CLOSED';const queue=await tx.read<WorkQueue>('system/queue.json')||emptyQueue();
        queue.orders=queue.orders.filter(item=>item!==order.id);tx.put('system/queue.json',queue);
      }
    }else return order;
    tx.put(orderPath(order.id),order);await indexOrder(tx,order);return order;
  }
  async applyTrade(trade:Trade):Promise<Order> {
    const observedAt=this.now();
    return this.store.transaction(async tx=>this.applyTradeInTransaction(tx,await this.logicalOrderForTrade(tx,trade.outTradeNo),trade,observedAt));
  }
  async notification(data:Record<string,string>):Promise<Order|null> {
    requireThat(data.sign_type==='RSA2' && this.alipayGateway().verifyNotification(data),400,'INVALID_SIGNATURE','支付宝通知验签失败');
    requireThat(data.app_id===this.env.ALIPAY_APP_ID && data.seller_id===this.env.ALIPAY_SELLER_ID,400,'PAYMENT_MISMATCH','应用或收款账户不匹配');
    const order = await this.store.transaction(tx=>this.logicalOrderForTrade(tx,data.out_trade_no));
    requireThat(providerOf(order)==='alipay',400,'PAYMENT_MISMATCH','支付方式与订单不匹配');
    requireThat(money(data.total_amount)===order.amount,400,'PAYMENT_MISMATCH','交易金额不匹配');
    if (!['TRADE_SUCCESS','TRADE_FINISHED','TRADE_CLOSED'].includes(data.trade_status)) return null;
    let paidAt:string|undefined;
    if((order.status!=='PAID'||order.tradeNo!==data.trade_no) && ['TRADE_SUCCESS','TRADE_FINISHED'].includes(data.trade_status)) {
      try {paidAt=alipayPaidAt(data.gmt_payment);}catch {requireThat(false,400,'PAYMENT_MISMATCH','支付宝付款时间无效');}
    }
    return this.applyTrade({outTradeNo:data.out_trade_no,tradeNo:data.trade_no,tradeStatus:data.trade_status,totalAmount:data.total_amount,sellerId:data.seller_id,...(paidAt?{paidAt}:{})});
  }
  async wechatNotification(headers:Headers,raw:string):Promise<Order> {
    requireThat(this.wechatGateway,503,'WECHAT_NOT_READY','微信支付尚未完成配置');
    const trade=await this.wechatGateway.notification(headers,raw);
    requireThat(trade.provider==='wechat'&&paidStatus(trade.tradeStatus),400,'PAYMENT_MISMATCH','微信支付通知状态不正确');
    return this.applyTrade(trade);
  }
  async refresh(id:string):Promise<Order> {
    const now = this.now();
    const existing=await this.order(id);
    if(existing.status==='PAID'&&!existing.adminOperation)return this.cleanupPaid(existing);
    const claimed = await this.store.transaction(async tx=>{
      const order = await tx.read<Order>(orderPath(id));
      requireThat(order,404,'NOT_FOUND','订单不存在');
      requireThat(order.mode===this.env.PAYMENT_MODE,409,'ENVIRONMENT_MISMATCH','订单不属于当前支付环境');
      if (order.status!=='PENDING'||order.adminOperation) return null;
      const expired=now>=Date.parse(this.paymentExpiresAt(order));
      // Expired orders no longer persist an endless stream of check timestamps.
      // Provider confirmation and the final CLOSED/queue update remain durable.
      if (!expired) {
        if (order.lastCheckedAt && now-Date.parse(order.lastCheckedAt)<60_000) return null;
        order.lastCheckedAt=new Date(now).toISOString();tx.put(orderPath(id),order);
      }
      return {expired,attemptId:this.activeAttempt(order).id};
    });
    if (claimed) {
      const gateway=this.gatewayFor(existing);
      const trade = await gateway.query(claimed.attemptId);
      requireThat(!trade || trade.outTradeNo === claimed.attemptId,502,'PAYMENT_MISMATCH','查询交易号不匹配');
      if (trade) {
        const order=await this.applyTrade(trade);
        if (order.status!=='PENDING') return order;
      }
      if (claimed.expired) {
        if (trade) {
          try {await gateway.close(claimed.attemptId);}
          catch (error) {
            // Payment may win the race with close. Trust only a fresh verified
            // provider result; never turn an uncertain failure into local CLOSED.
            const current=await gateway.query(claimed.attemptId);
            requireThat(!current || current.outTradeNo===claimed.attemptId,502,'PAYMENT_MISMATCH','查询交易号不匹配');
            if (current) {
              const order=await this.applyTrade(current);
              if (order.status!=='PENDING') return order;
            }
            throw error;
          }
        }
        return this.closeExpired(id,claimed.attemptId);
      }
    }
    return this.order(id);
  }
  private async closeExpired(id:string,attemptId:string):Promise<Order> {
    return this.store.transaction(async tx=>{
      const order=await tx.read<Order>(orderPath(id));
      requireThat(order,404,'NOT_FOUND','订单不存在');
      requireThat(order.mode===this.env.PAYMENT_MODE,409,'ENVIRONMENT_MISMATCH','订单不属于当前支付环境');
      // A notification can have confirmed payment while the close was in flight.
      if (order.status!=='PENDING'||order.adminOperation||this.activeAttempt(order).id!==attemptId||this.now()<Date.parse(this.paymentExpiresAt(order))) return order;
      order.status='CLOSED';
      if(order.paymentAttempts){const attempt=this.activeAttempt(order);attempt.status='CLOSED';attempt.closedAt=new Date(this.now()).toISOString();}
      const queue=await tx.read<WorkQueue>('system/queue.json') || emptyQueue();
      queue.orders=queue.orders.filter(x=>x!==id);
      tx.put(orderPath(id),order);tx.put('system/queue.json',queue);
      await indexOrder(tx,order);
      return order;
    });
  }
  private mayStillPayUntil(order:Order):string|undefined {
    return this.attempts(order).filter(attempt=>(attempt.status==='CLOSED'||order.status==='PAID'&&attempt.status!=='PAID')&&!attempt.closeConfirmed&&attempt.linkIssuedAt&&Date.parse(attempt.linkExpiresAt??attempt.expiresAt)>this.now()).map(attempt=>attempt.linkExpiresAt??attempt.expiresAt).sort().at(-1);
  }
  async adminDetail(id:string) {
    const order=await this.order(id),attempts=this.attempts(order),activeAttempt=this.activeAttempt(order);
    const records=await Promise.all((order.recentActionIds??[]).slice(-20).reverse().map(requestId=>this.store.readJson<OrderActionRecord>(actionPath(id,requestId))));
    const mayStillPayUntil=this.mayStillPayUntil(order),operationRunning=!!order.adminOperation&&Date.parse(order.adminOperation.expiresAt)>this.now();
    return {
      order:{id:order.id,provider:providerOf(order),mode:order.mode,clientId:order.clientId,productOrderId:order.productOrderId,sku:order.sku,subject:order.subject,amount:order.amount,amountCents:Math.round(Number(order.amount)*100),status:order.status,createdAt:order.createdAt,expiresAt:this.paymentExpiresAt(order),originalExpiresAt:order.expiresAt,fulfillmentStatus:order.fulfillmentStatus,
        ...(order.tradeNo?{tradeNo:order.tradeNo}:{}),...(order.paidAt?{paidAt:order.paidAt}:{}),activeAttempt,paymentAttempts:attempts,
        cleanupPending:this.cleanupAttempts(order).length>0,...(mayStillPayUntil?{mayStillPayUntil}:{}),...(order.duplicatePayments?.length?{duplicatePayments:order.duplicatePayments}:{}),...(order.adminOperation?{operation:{action:order.adminOperation.action,expiresAt:order.adminOperation.expiresAt,expired:!operationRunning}}:{})},
      version:operationVersion(order),
      actions:{close:order.status==='PENDING'&&!operationRunning,reopen:order.status==='CLOSED'&&!operationRunning&&!mayStillPayUntil&&attempts.length<20,reconcile:!operationRunning},
      audit:records.filter((record):record is OrderActionRecord=>!!record).map(({fingerprint:_,...record})=>record),
    };
  }
  private validateAction(input:OrderActionInput,actor:string):OrderActionInput {
    requireThat(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(key=>['expectedVersion','requestId','reason'].includes(key)),400,'INVALID_REQUEST','订单操作参数错误');
    requireThat(typeof input.expectedVersion==='string'&&/^[a-f0-9]{64}$/.test(input.expectedVersion)&&typeof input.requestId==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId),400,'INVALID_REQUEST','订单版本或操作编号无效');
    requireThat(typeof input.reason==='string'&&input.reason.trim().length>=1&&input.reason.trim().length<=500&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.reason),400,'INVALID_REQUEST','请填写 1 至 500 字的操作原因');
    requireThat(typeof actor==='string'&&actor.length>=1&&actor.length<=200&&!/[\u0000-\u001f]/.test(actor),400,'INVALID_REQUEST','管理员身份无效');
    return {...input,reason:input.reason.trim()};
  }
  private requireReopenClient(order:Order,client:ProductClient|undefined):void {
    requireReady(this.env,true);
    requireThat(client&&client.id===order.clientId,403,'CLIENT_DISABLED','订单平台不存在或已停用');
    requireThat(client.enabled!==false,403,'CLIENT_DISABLED','订单平台已停用');
    requireThat((client.providers??['alipay']).includes(providerOf(order)),403,'PROVIDER_NOT_ALLOWED','该产品尚未启用此支付方式');
    this.requireProviderEnabled(providerOf(order));
    requireThat(Object.hasOwn(client.skus,order.sku)&&client.skus[order.sku].enabled!==false,403,'SKU_DISABLED','订单商品不存在或已停售');
  }
  private async queryAttempt(order:Order,attempt:PaymentAttempt):Promise<Trade|null> {
    const trade=await this.gatewayFor(order).query(attempt.id);
    if(trade){requireThat(trade.outTradeNo===attempt.id,502,'PAYMENT_MISMATCH','查询交易号不匹配');this.validateTrade(order,trade);}
    return trade;
  }
  /** The close adapter verifies Alipay's response. A failed close is reconciled
   * once more, because payment may have won the provider-side race. */
  private async settleAttempt(order:Order,attempt:PaymentAttempt,trade:Trade|null):Promise<{trade:Trade|null;closed:boolean}> {
    if(!trade)return {trade:null,closed:false};
    if(paidStatus(trade.tradeStatus))return {trade,closed:false};
    if(trade.tradeStatus==='TRADE_CLOSED')return {trade,closed:true};
    requireThat(trade.tradeStatus==='WAIT_BUYER_PAY',502,'PAYMENT_MISMATCH','支付交易状态无法确认');
    try{await this.gatewayFor(order).close(attempt.id);return {trade,closed:true};}
    catch(error){
      const current=await this.queryAttempt(order,attempt);
      if(current&&(paidStatus(current.tradeStatus)||current.tradeStatus==='TRADE_CLOSED'))return {trade:current,closed:current.tradeStatus==='TRADE_CLOSED'};
      throw error;
    }
  }
  private finishPaidAttempt(order:Order,attemptId:string,result:SettledAttempt,now:string):void{
    const attempt=this.attempts(order).find(item=>item.id===attemptId);
    if(!attempt||attempt.status==='PAID'||result.failed)return;
    const safe=result.closed||(!result.trade&&(!attempt.linkIssuedAt||Date.parse(now)>=Date.parse(attempt.linkExpiresAt??attempt.expiresAt)));
    if(safe){attempt.status='CLOSED';attempt.closeConfirmed=true;attempt.closedAt??=now;}
    else if(attempt.linkIssuedAt){attempt.status='CLOSED';attempt.closeConfirmed=false;attempt.closedAt??=now;}
  }
  /** PAID orders stay in the durable maintenance queue until every other
   * issued provider attempt is safely closed or its real URL deadline passes.
   * Unchanged/null checks create no timestamp-only commits. */
  private async cleanupPaid(snapshot:Order):Promise<Order>{
    const attempts=this.cleanupAttempts(snapshot);
    if(!attempts.length)return snapshot;
    const results:SettledAttempt[]=await Promise.all(attempts.map(async attempt=>{
      try{return await this.settleAttempt(snapshot,attempt,await this.queryAttempt(snapshot,attempt));}
      catch{return {trade:null,closed:false,failed:true};}
    }));
    return this.store.transaction(async tx=>{
      const current=await tx.read<Order>(orderPath(snapshot.id));this.checkedOrder(current);
      if(current.status!=='PAID')return current;
      const before=JSON.stringify(current),observedAt=this.now(),now=new Date(observedAt).toISOString();
      for(let index=0;index<attempts.length;index++){
        const result=results[index];
        if(result.trade&&(!current.adminOperation||paidStatus(result.trade.tradeStatus)))await this.applyTradeInTransaction(tx,current,result.trade,observedAt);
        if(!current.adminOperation)this.finishPaidAttempt(current,attempts[index].id,result,now);
      }
      if(JSON.stringify(current)!==before){tx.put(orderPath(current.id),current);await indexOrder(tx,current);}
      await this.syncCleanupQueue(tx,current);return current;
    });
  }
  /** No network calls occur inside the GitHub transaction callback. The durable
   * operation reservation serializes administrators and signed-URL issuance;
   * provider notifications can still confirm real money while it is in flight. */
  async adminAction(id:string,action:AdminOrderAction,raw:OrderActionInput,actor:string,client?:ProductClient):Promise<Awaited<ReturnType<Payments['adminDetail']>>&{message?:string;checkoutUrl?:string}> {
    requireThat(['close','reopen','reconcile'].includes(action),400,'INVALID_REQUEST','订单操作无效');
    const input=this.validateAction(raw,actor),fingerprint=sha256(JSON.stringify({action,input,actor})),token=randomId('op_');
    await this.order(id);
    const reservation=await this.store.transaction(async tx=>{
      const order=await tx.read<Order>(orderPath(id));this.checkedOrder(order);
      const path=actionPath(id,input.requestId),previous=await tx.read<OrderActionRecord>(path);
      if(previous){
        requireThat(previous.fingerprint===fingerprint,409,'IDEMPOTENCY_CONFLICT','相同操作编号不能用于不同操作');
        if(previous.status==='completed')return {replayed:true,order,record:previous};
        requireThat(previous.status!=='failed',409,'ORDER_ACTION_FAILED','该操作已经失败，请刷新订单后使用新的操作编号重试');
      }
      requireThat(!order.adminOperation||Date.parse(order.adminOperation.expiresAt)<=this.now(),409,'ORDER_OPERATION_IN_PROGRESS','订单正在处理，请稍后重试');
      requireThat(operationVersion(order)===input.expectedVersion,409,'ORDER_VERSION_CONFLICT','订单状态已变化，请刷新后重试');
      requireThat(action!=='close'||order.status==='PENDING',409,'ORDER_ACTION_NOT_ALLOWED','仅待付款订单可以手动关闭');
      requireThat(action!=='reopen'||order.status==='CLOSED',409,'ORDER_ACTION_NOT_ALLOWED','仅已关闭订单可以重新启用');
      if(action==='reopen'){
        this.requireReopenClient(order,client);
        requireThat(!this.mayStillPayUntil(order),409,'ORDER_REOPEN_UNSAFE','旧付款链接仍可能有效，请到原付款期限后核实再重新启用');
        requireThat(this.attempts(order).length<20,409,'ORDER_ATTEMPT_LIMIT','同一订单最多重新发起 20 次，请创建新的业务订单');
      }
      // A stale operation may have lost its response. It cannot publish state
      // after the new token is reserved; retain that interruption in its audit.
      if(order.adminOperation&&order.adminOperation.requestId!==input.requestId){
        const oldPath=actionPath(id,order.adminOperation.requestId),old=await tx.read<OrderActionRecord>(oldPath);
        if(old?.status==='running'){old.status='failed';old.completedAt=new Date(this.now()).toISOString();old.errorCode='OPERATION_EXPIRED';tx.put(oldPath,old);}
      }
      this.trackAttempts(order);
      order.adminOperation={requestId:input.requestId,token,action,expiresAt:new Date(this.now()+120_000).toISOString()};
      order.recentActionIds=[...(order.recentActionIds??[]).filter(value=>value!==input.requestId),input.requestId].slice(-20);
      const record:OrderActionRecord={requestId:input.requestId,action,actor,reason:input.reason,fingerprint,startedAt:new Date(this.now()).toISOString(),status:'running',beforeStatus:order.status};
      tx.put(orderPath(id),order);tx.put(path,record);
      return {replayed:false,order,record};
    });
    if(reservation.replayed){
      const detail=await this.adminDetail(id);
      return {...detail,...(reservation.record.message?{message:reservation.record.message}:{}),...(action==='reopen'&&detail.order.status==='PENDING'&&detail.order.activeAttempt.id===reservation.record.attemptId?{checkoutUrl:`${this.env.PAY_BASE_URL}/checkout/${id}#token=${checkoutToken(id,this.env)}`}:{})};
    }
    try{
      const order=reservation.order,attempts=this.attempts(order);
      // All attempts are checked before reopening. Old attempt notifications
      // remain routable for the entire life of the purchase.
      const observations=await Promise.all(attempts.map(async attempt=>{
        try{return {trade:await this.queryAttempt(order,attempt),error:undefined};}
        catch(error){return {trade:null,error};}
      }));
      const paymentKnown=order.status==='PAID'||observations.some(item=>item.trade&&paidStatus(item.trade.tradeStatus));
      const failedQuery=observations.find(item=>item.error);
      if(failedQuery&&!paymentKnown)throw failedQuery.error;
      const results:SettledAttempt[]=await Promise.all(attempts.map(async(attempt,index)=>{
        const {trade,error}=observations[index];
        if(error)return {trade:null,closed:false,failed:true};
        if(action==='reconcile'&&!paymentKnown)return {trade,closed:trade?.tradeStatus==='TRADE_CLOSED'};
        try{return await this.settleAttempt(order,attempt,trade);}
        catch(error){return {trade,closed:false,failed:true,error};}
      }));
      const settlementError=results.find(result=>result.failed);
      if(settlementError&&!paymentKnown&&!results.some(result=>result.trade&&paidStatus(result.trade.tradeStatus)))throw settlementError.error;
      const newAttemptId=action==='reopen'?randomId('pay_'):undefined;
      const result=await this.store.transaction(async tx=>{
        const current=await tx.read<Order>(orderPath(id));this.checkedOrder(current);
        if(current.adminOperation?.token!==token){
          const confirmed=results.filter(result=>result.trade&&paidStatus(result.trade.tradeStatus));
          requireThat(confirmed.length>0,409,'ORDER_VERSION_CONFLICT','订单操作已被更新，请刷新订单核实');
          for(const result of confirmed)await this.applyTradeInTransaction(tx,current,result.trade!,this.now());
          const interrupted=await tx.read<OrderActionRecord>(actionPath(id,input.requestId));
          if(interrupted){interrupted.status='failed';interrupted.errorCode='OPERATION_EXPIRED';interrupted.completedAt=new Date(this.now()).toISOString();interrupted.afterStatus=current.status;interrupted.message='操作已被更新；此前核实的真实付款已保留，请刷新订单核实。';tx.put(actionPath(id,input.requestId),interrupted);}
          return {message:'操作已被更新；支付平台已确认的真实付款已记录，请刷新订单核实。',reopened:false};
        }
        const record=await tx.read<OrderActionRecord>(actionPath(id,input.requestId));
        requireThat(record?.status==='running',409,'ORDER_VERSION_CONFLICT','订单操作记录已变化，请刷新订单核实');
        const observedAt=this.now(),now=new Date(observedAt).toISOString();
        for(const result of results)if(result.trade)await this.applyTradeInTransaction(tx,current,result.trade,observedAt);
        if(current.status==='PAID')for(let index=0;index<attempts.length;index++)this.finishPaidAttempt(current,attempts[index].id,results[index],now);
        let message:string;
        if(current.status==='PAID')message=current.duplicatePayments?.length?'已核实付款；发现额外付款记录，请人工核实处理，产品权益不会重复发放。':'支付平台已确认付款，已按实付记录，订单不会关闭或重新启用。';
        else if(action==='reopen'){
          this.requireReopenClient(current,client);
          for(let index=0;index<attempts.length;index++){
            const attempt=this.attempts(current).find(item=>item.id===attempts[index].id)!;
            requireThat(results[index].closed||(!results[index].trade&&(!attempt.linkIssuedAt||observedAt>=Date.parse(attempt.linkExpiresAt??attempt.expiresAt))),409,'ORDER_REOPEN_UNSAFE','旧付款链接仍可能有效，请到原付款期限后核实再重新启用');
            attempt.status='CLOSED';attempt.closedAt=attempt.closedAt??now;attempt.closeConfirmed=results[index].closed;
          }
          const queue=await tx.read<WorkQueue>('system/queue.json')||emptyQueue();
          requireThat(queue.orders.length<2000||queue.orders.includes(id),503,'CAPACITY','待支付订单过多，请稍后再试');
          requireThat(!await tx.read<AttemptMapping>(attemptPath(newAttemptId!))&&!await tx.read<Order>(orderPath(newAttemptId!)),409,'ORDER_VERSION_CONFLICT','付款编号冲突，请重试');
          const next:PaymentAttempt={id:newAttemptId!,createdAt:now,expiresAt:new Date(observedAt+PAYMENT_WINDOW_MS).toISOString(),status:'PENDING'};
          current.paymentAttempts!.push(next);current.activeAttemptId=next.id;current.status='PENDING';delete current.lastCheckedAt;
          tx.put(attemptPath(next.id),{orderId:id,mode:current.mode} satisfies AttemptMapping);
          if(!queue.orders.includes(id))queue.orders.push(id);tx.put('system/queue.json',queue);
          record.attemptId=next.id;message='已重新启用，新的付款期限为 10 分钟；沿用原订单商品和金额。';
        }else if(action==='close'){
          for(let index=0;index<attempts.length;index++){
            const attempt=this.attempts(current).find(item=>item.id===attempts[index].id)!;
            attempt.status='CLOSED';attempt.closedAt=attempt.closedAt??now;attempt.closeConfirmed=results[index].closed;
          }
          current.status='CLOSED';const queue=await tx.read<WorkQueue>('system/queue.json')||emptyQueue();queue.orders=queue.orders.filter(value=>value!==id);tx.put('system/queue.json',queue);
          message=this.mayStillPayUntil(current)?'订单已关闭；尚未在支付平台创建的旧付款链接仍可能在原期限前付款，届时有效通知仍会记录实付。':'订单已关闭，支付平台已有的待付款交易已关闭。';
        }else message=results.some(result=>result.trade)?'已按支付平台查询结果核实，尚未确认付款。':'支付平台未查到交易，未补记付款。';
        if(current.status==='PAID'){
          await this.syncCleanupQueue(tx,current);
          if(this.cleanupAttempts(current).length)message+=' 其余付款尝试尚未全部安全关闭，后台将继续核实关单，请勿再次付款。';
        }
        delete current.adminOperation;
        record.status='completed';record.completedAt=now;record.afterStatus=current.status;record.message=message;
        tx.put(orderPath(id),current);tx.put(actionPath(id,input.requestId),record);await indexOrder(tx,current);
        return {message,reopened:action==='reopen'&&current.status==='PENDING'};
      });
      return {...await this.adminDetail(id),message:result.message,...(result.reopened?{checkoutUrl:`${this.env.PAY_BASE_URL}/checkout/${id}#token=${checkoutToken(id,this.env)}`}:{})};
    }catch(error){
      await this.store.transaction(async tx=>{
        const order=await tx.read<Order>(orderPath(id));this.checkedOrder(order);
        if(order.adminOperation?.token!==token)return;
        const record=await tx.read<OrderActionRecord>(actionPath(id,input.requestId));
        if(record){record.status='failed';record.completedAt=new Date(this.now()).toISOString();record.afterStatus=order.status;const code=(error as {code?:unknown})?.code;record.errorCode=typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code)?code:'PROVIDER_OR_STORAGE_ERROR';tx.put(actionPath(id,input.requestId),record);}
        delete order.adminOperation;tx.put(orderPath(id),order);
      });
      throw error;
    }
  }
  async deliver(id:string,client:ProductClient):Promise<void> {
    const now = this.now(); const leaseId=randomId('lease_');
    const delivery=await this.store.transaction(async tx=>{
      const d=await tx.read<Delivery>(deliveryPath(id));
      if (!d || d.deliveredAt || Date.parse(d.nextAttemptAt)>now || (d.leaseUntil && Date.parse(d.leaseUntil)>now)) return null;
      requireThat(d.event.data.clientId===client.id,400,'CLIENT_MISMATCH','产品不匹配');
      requireThat(d.event.mode===this.env.PAYMENT_MODE,409,'ENVIRONMENT_MISMATCH','订单不属于当前支付环境');
      if(!d.webhookProtocol){
        const order=await tx.read<Order>(orderPath(d.event.data.orderId));
        const legacy=!!order?.legacyWechat||client.webhookProtocol==='wechat-legacy-v1'||(!client.webhookProtocol&&!!client.legacyWechat);
        d.webhookProtocol=legacy?'wechat-legacy-v1':'brclio-v1';
        d.webhookClientId=legacy?(order?.legacyWechat?.clientId??client.legacyWechat?.id??client.id):client.id;
      }
      d.leaseId=leaseId;d.leaseUntil=new Date(now+60_000).toISOString();d.attempts++;tx.put(deliveryPath(id),d);return d;
    });
    if (!delivery) return;
    const legacy=delivery.webhookProtocol==='wechat-legacy-v1';
    const data=delivery.event.data,externalOrderId=data.orderId.replace(/^pay_/,'');
    const externalEventId=legacy?`payment.success.${externalOrderId}`:id;
    const body=JSON.stringify(legacy?{eventId:externalEventId,type:'payment.success',orderId:externalOrderId,clientId:delivery.webhookClientId??client.id,
      merchantOrderId:data.productOrderId,sku:data.sku,quantity:1,total:Math.round(Number(data.amount)*100),currency:data.currency,transactionId:data.tradeNo,paidAt:data.paidAt}:delivery.event);
    const timestamp=String(Math.floor(now/1000)),nonce=leaseId.slice('lease_'.length);
    const headers:Record<string,string>={'Content-Type':'application/json','X-Brclio-Event':externalEventId,'X-Brclio-Timestamp':timestamp,
      'X-Brclio-Signature':hmacSha256(client.webhookSecret,legacy?`${timestamp}\n${nonce}\n${body}\n`:timestamp+'.'+body),...(legacy?{'X-Brclio-Nonce':nonce}:{})};
    let status=0;
    try {
      const response=await this.send(client.webhookUrl,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10_000),headers,body});
      status=response.status;await response.body?.cancel();
    } catch { /* Durable retry remains queued. Never log payment bodies. */ }
    await this.store.transaction(async tx=>{
      const d=await tx.read<Delivery>(deliveryPath(id));
      if (!d || d.leaseId!==leaseId || d.deliveredAt) return;
      d.lastStatus=status;delete d.leaseId;delete d.leaseUntil;
      if (status>=200 && status<300) {
        d.deliveredAt=new Date(this.now()).toISOString();
        const order=await tx.read<Order>(orderPath(d.event.data.orderId));
        if (order) {order.fulfillmentStatus='delivered';tx.put(orderPath(order.id),order);await indexOrder(tx,order);}
        const queue=await tx.read<WorkQueue>('system/queue.json') || emptyQueue();
        queue.deliveries=queue.deliveries.filter(x=>x!==id);tx.put('system/queue.json',queue);
      } else d.nextAttemptAt=new Date(this.now()+Math.min(24*3600_000,30_000*2**Math.min(d.attempts,12))).toISOString();
      tx.put(deliveryPath(id),d);
    });
  }
  async maintenance(productClients:ProductClient[]):Promise<void> {
    const batch=await this.store.transaction(async tx=>{
      const q=await tx.read<WorkQueue>('system/queue.json') || emptyQueue();
      const orders=q.orders.slice(0,5),deliveries=q.deliveries.slice(0,10);
      if (q.orders.length>5) q.orders=[...q.orders.slice(5),...orders];
      if (q.deliveries.length>10) q.deliveries=[...q.deliveries.slice(10),...deliveries];
      if (q.orders.length>5 || q.deliveries.length>10) tx.put('system/queue.json',q);
      return {orders,deliveries};
    });
    for (const id of batch.orders) {
      try {
        await this.refresh(id);
      } catch {console.warn('reconciliation_failed');}
    }
    for (const id of batch.deliveries) {
      try {
        const d=await this.store.readJson<Delivery>(deliveryPath(id));
        const client=productClients.find(c=>c.id===d?.event.data.clientId);
        if (client) await this.deliver(id,client);
      } catch {console.warn('webhook_retry_failed');}
    }
  }
}
