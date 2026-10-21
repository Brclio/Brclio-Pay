import {Buffer} from 'node:buffer';
import {requireThat} from './config';
import {sha256} from './crypto';
import type {Order,Store,StoreSnapshot,Transaction} from './types';

export type PaymentMode = Order['mode'];
export type OrderStatus = Order['status'];
export interface ReportingOrder {
  provider?:'alipay'|'wechat';
  id:string; mode:PaymentMode; clientId:string; productOrderId:string; sku:string; subject:string;
  amount:string; amountCents:number; status:OrderStatus; createdAt:string; expiresAt:string;
  paidAt?:string; tradeNo?:string; fulfillmentStatus:Order['fulfillmentStatus'];
  duplicatePayments?:Order['duplicatePayments'];
}
export interface Coverage {
  scope:'ledger'; complete:boolean; sourceOrders:number; indexedOrders:number; missingOrders:number; checkedAt:string;
}
export interface DailyRevenue {date:string; paidAmountCents:number; paidCount:number}
export interface ReportingSummary {
  mode:PaymentMode; currency:'CNY'; basis:'payment-confirmed'; timezone:'Asia/Shanghai'; month:string; clientId?:string;
  paidAmountCents:number; paidCount:number; pendingCount:number; closedCount:number; deliveryPendingCount:number;
  allTime:{paidAmountCents:number;paidCount:number}; daily:DailyRevenue[]; coverage:Coverage;
}
export interface OrderFilters {month?:string; clientId?:string; status?:OrderStatus; limit?:number; cursor?:string}
export interface OrderPage {mode:PaymentMode;items:ReportingOrder[];nextCursor:string|null;coverage:Coverage}
export interface RebuildResult {processed:number;scanned:number;nextCursor:string|null;coverage:Coverage}
interface Metrics {paidAmountCents:number;paidCount:number;pendingCount:number;closedCount:number;deliveryPendingCount:number}
interface MonthBucket extends Metrics {schema:1;mode:PaymentMode;month:string;daily:Record<string,{paidAmountCents:number;paidCount:number}>}
interface TotalBucket {schema:1;mode:PaymentMode;paidAmountCents:number;paidCount:number}
interface IndexedOrder {schema:1;order:ReportingOrder}
const PREFIX='reporting/v1/';
const ORDER_PREFIX=PREFIX+'orders/';
const COUNTERS=['paidAmountCents','paidCount','pendingCount','closedCount','deliveryPendingCount'] as const;
const MAX_SCAN=40;
export const REPORTING_LIMITS={orders:25,scan:MAX_SCAN,rebuild:5,listing:20_000} as const;
const zero=():Metrics=>({paidAmountCents:0,paidCount:0,pendingCount:0,closedCount:0,deliveryPendingCount:0});
function integrity(condition:unknown):asserts condition {requireThat(condition,503,'REPORTING_INTEGRITY','支付统计索引异常，请检查账本与索引');}
function validMode(mode:unknown):asserts mode is PaymentMode {integrity(mode==='live'||mode==='sandbox');}
function monthValue(value:unknown):asserts value is string {requireThat(typeof value==='string'&&/^[2-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(value),400,'INVALID_MONTH','月份格式应为 YYYY-MM');}
function clientValue(value:unknown):asserts value is string {requireThat(typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{1,63}$/.test(value),400,'INVALID_CLIENT_ID','平台 ID 格式错误');}
function time(value:string):number {const valueMs=Date.parse(value);integrity(Number.isFinite(valueMs));return valueMs;}
function shanghaiDay(value:string):string {return new Date(time(value)+8*3600_000).toISOString().slice(0,10);}
function cents(amount:string):number {integrity(typeof amount==='string'&&/^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(amount)&&amount!=='0.00');const [yuan,fen]=amount.split('.');return Number(yuan)*100+Number(fen);}
function checkedAdd(value:number,delta:number):number {const sum=value+delta;integrity(Number.isSafeInteger(value)&&Number.isSafeInteger(delta)&&Number.isSafeInteger(sum)&&sum>=0);return sum;}
function orderView(order:Omit<Order,'requestHash'|'returnUrl'>):ReportingOrder {
  integrity(/^pay_[a-f0-9]{32}$/.test(order.id));validMode(order.mode);clientValue(order.clientId);
  integrity(['PENDING','PAID','CLOSED'].includes(order.status)&&['pending','delivered'].includes(order.fulfillmentStatus));
  time(order.createdAt);time(order.expiresAt);
  integrity(typeof order.productOrderId==='string'&&typeof order.sku==='string'&&typeof order.subject==='string');
  if(order.status==='PAID'){integrity(typeof order.paidAt==='string'&&typeof order.tradeNo==='string');time(order.paidAt!);}
  const duplicates=order.duplicatePayments??[];
  integrity(Array.isArray(duplicates)&&duplicates.length<=19&&(!duplicates.length||order.status==='PAID'));
  const tradeNos=new Set([order.tradeNo]);
  for(const payment of duplicates){
    integrity(payment&&/^pay_[a-f0-9]{32}$/.test(payment.attemptId)&&/^\d{10,64}$/.test(payment.tradeNo)&&!tradeNos.has(payment.tradeNo)&&payment.amount===order.amount);
    time(payment.paidAt);cents(payment.amount);tradeNos.add(payment.tradeNo);
  }
  return {id:order.id,provider:order.provider??'alipay',mode:order.mode,clientId:order.clientId,productOrderId:order.productOrderId,sku:order.sku,subject:order.subject,
    amount:order.amount,amountCents:cents(order.amount),status:order.status,createdAt:order.createdAt,expiresAt:order.expiresAt,
    ...(order.paidAt?{paidAt:order.paidAt}:{}),...(order.tradeNo?{tradeNo:order.tradeNo}:{}),fulfillmentStatus:order.fulfillmentStatus,
    ...(duplicates.length?{duplicatePayments:duplicates.map(({attemptId,tradeNo,paidAt,amount})=>({attemptId,tradeNo,paidAt,amount}))}:{})};
}
function indexPath(order:Pick<ReportingOrder,'id'|'mode'|'createdAt'>):string {
  const month=shanghaiDay(order.createdAt).slice(0,7);
  const key=new Date(time(order.createdAt)).toISOString().replace(/[-:.]/g,'');
  return `${ORDER_PREFIX}${order.mode}/${month}/${key}_${order.id}.json`;
}
function monthPath(mode:PaymentMode,scope:string,month:string):string {return `${PREFIX}${mode}/summary/${scope}/months/${month}.json`;}
function totalPath(mode:PaymentMode,scope:string):string {return `${PREFIX}${mode}/summary/${scope}/total.json`;}
function monthBucket(mode:PaymentMode,month:string):MonthBucket {return {schema:1,mode,month,...zero(),daily:{}};}
function checkedMonth(value:MonthBucket|null,mode:PaymentMode,month:string):MonthBucket {
  if(!value)return monthBucket(mode,month);
  integrity(value.schema===1&&value.mode===mode&&value.month===month&&value.daily&&typeof value.daily==='object'&&!Array.isArray(value.daily));
  for(const key of COUNTERS)integrity(Number.isSafeInteger(value[key])&&value[key]>=0);
  for(const [date,counts] of Object.entries(value.daily))integrity(date.startsWith(month+'-')&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&counts&&Number.isSafeInteger(counts.paidAmountCents)&&counts.paidAmountCents>=0&&Number.isSafeInteger(counts.paidCount)&&counts.paidCount>=0);
  integrity(Object.keys(value.daily).length<=31);return value;
}
function checkedTotal(value:TotalBucket|null,mode:PaymentMode):TotalBucket {
  if(!value)return {schema:1,mode,paidAmountCents:0,paidCount:0};
  integrity(value.schema===1&&value.mode===mode&&Number.isSafeInteger(value.paidCount)&&value.paidCount>=0&&Number.isSafeInteger(value.paidAmountCents)&&value.paidAmountCents>=0);return value;
}
function contributions(order:ReportingOrder|null):Map<string,MonthBucket> {
  const result=new Map<string,MonthBucket>();if(!order)return result;
  const date=order.status==='PAID'?shanghaiDay(order.paidAt!):shanghaiDay(order.createdAt);
  const month=date.slice(0,7),bucket=monthBucket(order.mode,month);
  if(order.status==='PENDING')bucket.pendingCount=1;
  if(order.status==='CLOSED')bucket.closedCount=1;
  if(order.status==='PAID'){
    bucket.paidCount=1;bucket.paidAmountCents=order.amountCents;bucket.deliveryPendingCount=order.fulfillmentStatus==='delivered'?0:1;
    bucket.daily[date]={paidCount:1,paidAmountCents:order.amountCents};
  }
  result.set(month,bucket);
  // A second distinct, verified Alipay payment is actual received money even
  // though the business order and product entitlement remain single. Include
  // it once on its own Shanghai payment date without changing the order price.
  for(const payment of order.duplicatePayments??[]){
    const day=shanghaiDay(payment.paidAt),paymentMonth=day.slice(0,7),additional=result.get(paymentMonth)??monthBucket(order.mode,paymentMonth);
    additional.paidCount++;additional.paidAmountCents+=cents(payment.amount);
    const daily=additional.daily[day]??{paidAmountCents:0,paidCount:0};daily.paidCount++;daily.paidAmountCents+=cents(payment.amount);additional.daily[day]=daily;
    result.set(paymentMonth,additional);
  }
  return result;
}
function paymentTotals(order:ReportingOrder|null):{count:number;amount:number}{
  return order?.status==='PAID'?{count:1+(order.duplicatePayments?.length??0),amount:order.amountCents+(order.duplicatePayments??[]).reduce((total,payment)=>total+cents(payment.amount),0)}:{count:0,amount:0};
}
/** Must be called in the SAME transaction as every order/status/fulfillment write.
 * A compact immutable-price order projection and bounded month/total counters are
 * persisted. No return URLs, request hashes, authorization or merchant keys. */
export async function indexOrder(tx:Transaction,order:Order):Promise<boolean> {
  const after=orderView(order),path=indexPath(after),stored=await tx.read<IndexedOrder>(path);
  let before:ReportingOrder|null=null;
  if(stored){
    integrity(stored.schema===1&&stored.order);before=orderView(stored.order);
    integrity(before.amountCents===stored.order.amountCents);
    integrity(before.id===after.id&&before.mode===after.mode&&before.clientId===after.clientId&&before.createdAt===after.createdAt&&before.amount===after.amount&&before.amountCents===after.amountCents
      &&before.productOrderId===after.productOrderId&&before.sku===after.sku&&before.subject===after.subject);
    for(const payment of before.duplicatePayments??[])integrity((after.duplicatePayments??[]).some(next=>next.tradeNo===payment.tradeNo&&next.attemptId===payment.attemptId&&next.amount===payment.amount&&next.paidAt===payment.paidAt));
    if(JSON.stringify(before)===JSON.stringify(after))return false;
  }
  const previous=contributions(before),next=contributions(after),months=new Set([...previous.keys(),...next.keys()]);
  for(const scope of ['all',`clients/${after.clientId}`]){
    for(const month of months){
      const bucketPath=monthPath(after.mode,scope,month),bucket=checkedMonth(await tx.read<MonthBucket>(bucketPath),after.mode,month);
      const old=previous.get(month),current=next.get(month);
      for(const key of COUNTERS)bucket[key]=checkedAdd(bucket[key],(current?.[key]??0)-(old?.[key]??0));
      for(const date of new Set([...Object.keys(old?.daily??{}),...Object.keys(current?.daily??{})])){
        const day=bucket.daily[date]??{paidAmountCents:0,paidCount:0};
        day.paidAmountCents=checkedAdd(day.paidAmountCents,(current?.daily[date]?.paidAmountCents??0)-(old?.daily[date]?.paidAmountCents??0));
        day.paidCount=checkedAdd(day.paidCount,(current?.daily[date]?.paidCount??0)-(old?.daily[date]?.paidCount??0));
        bucket.daily[date]=day;
      }
      tx.put(bucketPath,bucket);
    }
    const nextPayments=paymentTotals(after),previousPayments=paymentTotals(before);
    const paidDelta=nextPayments.count-previousPayments.count;
    const amountDelta=nextPayments.amount-previousPayments.amount;
    if(paidDelta||amountDelta){
      const path=totalPath(after.mode,scope),bucket=checkedTotal(await tx.read<TotalBucket>(path),after.mode);
      bucket.paidCount=checkedAdd(bucket.paidCount,paidDelta);bucket.paidAmountCents=checkedAdd(bucket.paidAmountCents,amountDelta);tx.put(path,bucket);
    }
  }
  tx.put(path,{schema:1,order:after} satisfies IndexedOrder);return true;
}
function sourcePaths(snapshot:StoreSnapshot):string[]{return snapshot.listJsonPaths('orders/').filter(path=>/^orders\/pay_[a-f0-9]{32}\.json$/.test(path));}
function indexedIds(snapshot:StoreSnapshot):Set<string>{
  return new Set(snapshot.listJsonPaths(ORDER_PREFIX).map(path=>/^reporting\/v1\/orders\/(?:live|sandbox)\/[2-9]\d{3}-(?:0[1-9]|1[0-2])\/\d{8}T\d{9}Z_(pay_[a-f0-9]{32})\.json$/.exec(path)?.[1]).filter((id):id is string=>!!id));
}
function orderIdFromPath(path:string):string {return path.slice('orders/'.length,-'.json'.length);}
function coverage(snapshot:StoreSnapshot,now:number):Coverage {
  const paths=sourcePaths(snapshot),ids=indexedIds(snapshot),indexedOrders=paths.filter(path=>ids.has(orderIdFromPath(path))).length;
  return {scope:'ledger',complete:indexedOrders===paths.length,sourceOrders:paths.length,indexedOrders,missingOrders:paths.length-indexedOrders,checkedAt:new Date(now).toISOString()};
}
function encodeCursor(kind:string,filter:string,after:string):string {return Buffer.from(JSON.stringify({v:1,k:kind,f:sha256(filter),a:after})).toString('base64url');}
function decodeCursor(value:string|undefined,kind:string,filter:string,prefix:string):string|null {
  if(value===undefined)return null;
  let cursor:unknown;
  try {if(value.length>1024||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{requireThat(false,400,'INVALID_CURSOR','分页游标无效');}
  const data=cursor as {v?:unknown;k?:unknown;f?:unknown;a?:unknown};
  requireThat(data&&data.v===1&&data.k===kind&&data.f===sha256(filter)&&typeof data.a==='string'&&data.a.startsWith(prefix)&&data.a.endsWith('.json')&&!data.a.includes('..')&&data.a.length<=240,400,'INVALID_CURSOR','分页游标与筛选条件不匹配');
  return data.a;
}
/** Counters represent confirmed payment amounts, NOT net Alipay settlement or
 * revenue after refunds. Index coverage is conservative across this whole ledger.
 * GitHub listings are immutable and capped at 20k per prefix; order pages scan at
 * most 40 blobs, so selective filters may return a short/empty page with a cursor. */
export class Reporting {
  constructor(public store:Store,public mode:PaymentMode,public now:()=>number=Date.now){validMode(mode);}
  private async snapshot():Promise<StoreSnapshot>{requireThat(this.store.openSnapshot,503,'REPORTING_UNAVAILABLE','存储暂不支持支付统计快照');return this.store.openSnapshot();}
  async summary(input:{month:string;clientId?:string}):Promise<ReportingSummary>{
    monthValue(input.month);if(input.clientId!==undefined)clientValue(input.clientId);
    const snapshot=await this.snapshot(),scope=input.clientId?`clients/${input.clientId}`:'all';
    const [monthly,total]=await Promise.all([snapshot.readJson<MonthBucket>(monthPath(this.mode,scope,input.month)),snapshot.readJson<TotalBucket>(totalPath(this.mode,scope))]);
    const counts=checkedMonth(monthly,this.mode,input.month),allTime=checkedTotal(total,this.mode);
    const [year,month]=input.month.split('-').map(Number),days=new Date(Date.UTC(year,month,0)).getUTCDate();
    return {mode:this.mode,currency:'CNY',basis:'payment-confirmed',timezone:'Asia/Shanghai',month:input.month,...(input.clientId?{clientId:input.clientId}:{}),
      paidAmountCents:counts.paidAmountCents,paidCount:counts.paidCount,pendingCount:counts.pendingCount,closedCount:counts.closedCount,deliveryPendingCount:counts.deliveryPendingCount,
      allTime:{paidAmountCents:allTime.paidAmountCents,paidCount:allTime.paidCount},
      daily:Array.from({length:days},(_,i)=>{const date=`${input.month}-${String(i+1).padStart(2,'0')}`;return {date,...(counts.daily[date]??{paidAmountCents:0,paidCount:0})};}),coverage:coverage(snapshot,this.now())};
  }
  async orders(input:OrderFilters={}):Promise<OrderPage>{
    if(input.month!==undefined)monthValue(input.month);if(input.clientId!==undefined)clientValue(input.clientId);
    requireThat(input.status===undefined||['PENDING','PAID','CLOSED'].includes(input.status),400,'INVALID_STATUS','订单状态无效');
    const limit=input.limit??20;requireThat(Number.isInteger(limit)&&limit>=1&&limit<=REPORTING_LIMITS.orders,400,'INVALID_LIMIT','每页最多 25 笔订单');
    const filter=JSON.stringify({mode:this.mode,month:input.month??null,clientId:input.clientId??null,status:input.status??null});
    const prefix=ORDER_PREFIX+this.mode+'/',after=decodeCursor(input.cursor,'orders',filter,prefix),snapshot=await this.snapshot();
    const paths=snapshot.listJsonPaths(prefix).filter(path=>(!input.month||path.startsWith(prefix+input.month+'/'))&&(!after||path<after)).sort().reverse();
    const items:ReportingOrder[]=[];let scanned=0,last:string|null=null;
    for(const path of paths){
      if(scanned>=MAX_SCAN||items.length>=limit)break;
      scanned++;last=path;const indexed=await snapshot.readJson<IndexedOrder>(path);integrity(indexed?.schema===1&&indexed.order&&indexed.order.mode===this.mode&&indexPath(indexed.order)===path);
      const order=orderView(indexed.order);integrity(order.amountCents===indexed.order.amountCents);
      if((!input.clientId||order.clientId===input.clientId)&&(!input.status||order.status===input.status))items.push(order);
    }
    return {mode:this.mode,items,nextCursor:last&&scanned<paths.length?encodeCursor('orders',filter,last):null,coverage:coverage(snapshot,this.now())};
  }
  /** Administrator route MUST authenticate and require CSRF before calling.
   * Scans all legacy modes only to rebuild reporting; never calls a gateway,
   * emits an event, changes an order, or changes product entitlement. */
  async rebuild(input:{limit?:number;cursor?:string}={}):Promise<RebuildResult>{
    const limit=input.limit??REPORTING_LIMITS.rebuild;requireThat(Number.isInteger(limit)&&limit>=1&&limit<=REPORTING_LIMITS.rebuild,400,'INVALID_LIMIT','每次最多补建 5 笔订单');
    const filter=JSON.stringify({mode:this.mode}),after=decodeCursor(input.cursor,'rebuild',filter,'orders/'),snapshot=await this.snapshot(),ids=indexedIds(snapshot);
    const missing=sourcePaths(snapshot).filter(path=>!ids.has(orderIdFromPath(path)));
    let remaining=missing.filter(path=>!after||path>after);if(!remaining.length&&missing.length)remaining=missing;
    const batch=remaining.slice(0,limit);
    const processed=await this.store.transaction(async tx=>{
      let count=0;
      for(const path of batch){const order=await tx.read<Order>(path);integrity(order&&order.id===orderIdFromPath(path));if(await indexOrder(tx,order))count++;}
      return count;
    });
    const current=await this.snapshot(),status=coverage(current,this.now());
    return {processed,scanned:batch.length,nextCursor:status.complete?null:encodeCursor('rebuild',filter,batch.at(-1)??'orders/pay_'+ '0'.repeat(32)+'.json'),coverage:status};
  }
}
