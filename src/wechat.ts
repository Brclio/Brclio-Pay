import { HttpError, requireThat } from './config';
import { randomNonce } from './crypto';
import type { Env } from './types';
import type { Trade, WechatGateway } from './payments';

type WechatEnvironment = Pick<Env, 'PAYMENT_MODE' | 'WECHAT_MCH_ID' | 'WECHAT_APP_ID' | 'WECHAT_SERIAL_NO' | 'WECHAT_PRIVATE_KEY' | 'WECHAT_API_V3_KEY' | 'WECHAT_PUBLIC_KEYS_JSON' | 'WECHAT_PUBLIC_KEY_ID'>;
interface WechatTransaction {
  appid: string; mchid: string; out_trade_no: string; transaction_id?: string;
  trade_state: string; trade_type?: string; success_time?: string;
  amount?: {total: number; currency?: string};
}
const encoder = new TextEncoder();
const textBytes = (value: string) => encoder.encode(value);
const rsaAlgorithm = {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'};
function decode64(value:string):Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length%4!==0) throw new Error('Invalid base64');
  return Uint8Array.from(atob(value), value => value.charCodeAt(0));
}
function encode64(value:ArrayBuffer):string {return btoa(String.fromCharCode(...new Uint8Array(value)));}
async function rsaKey(pem:string,privateKey:boolean):Promise<CryptoKey> {
  const kind=privateKey?'PRIVATE KEY':'PUBLIC KEY',normalized=pem.replace(/\\n/g,'\n').trim();
  const content=normalized.replace(`-----BEGIN ${kind}-----`,'').replace(`-----END ${kind}-----`,'').replace(/\s/g,'');
  if (!normalized.startsWith(`-----BEGIN ${kind}-----`)) throw new Error('Invalid RSA key');
  const key=await crypto.subtle.importKey(privateKey?'pkcs8':'spki',decode64(content),rsaAlgorithm,false,[privateKey?'sign':'verify']);
  if ((key.algorithm as {name:string;modulusLength:number}).modulusLength<2048) throw new Error('Invalid RSA key');
  return key;
}
/** The public API uses pay_<32 hex>; WeChat permits at most 32 characters. */
export function wechatOrderNumber(id:string):string {
  requireThat(/^pay_[a-f0-9]{32}$/.test(id),400,'INVALID_ORDER','微信支付订单号不正确');
  return id.slice(4);
}
function logicalId(id:unknown):string {
  requireThat(typeof id==='string' && /^[a-f0-9]{32}$/.test(id),502,'WECHAT_RESPONSE_INVALID','微信支付订单号不正确');
  return `pay_${id}`;
}
function normalizedDescription(value:string):string {
  // WeChat bounds its UTF-8 description. Keep the full purchase title in our ledger.
  let result='';for(const character of value){if(textBytes(result+character).byteLength>127)break;result+=character;}
  requireThat(result.length>0,400,'INVALID_REQUEST','商品名称不能为空');return result;
}
export class WechatError extends HttpError {
  constructor(public providerCode:string) {super(502,'WECHAT_REQUEST_FAILED','微信支付暂时未完成请求，请使用同一业务订单号重试或查单');}
}

/** Direct APIv3 transport: exact-byte RSA signatures, pinned public keys, and authenticated notifications. */
export function createWechat(env:WechatEnvironment,fetcher:typeof fetch=(input,init)=>globalThis.fetch(input,init),now:()=>number=Date.now):WechatGateway {
  let keys:Record<string,string>;
  try {keys=JSON.parse(env.WECHAT_PUBLIC_KEYS_JSON||'{}');} catch {throw new HttpError(503,'WECHAT_CONFIGURATION_INVALID','微信支付公钥配置不正确');}
  requireThat(env.PAYMENT_MODE==='live' && /^\d{6,20}$/.test(env.WECHAT_MCH_ID||'') && /^wx[A-Za-z0-9]{16}$/.test(env.WECHAT_APP_ID||'') && /^[A-Fa-f0-9]{16,64}$/.test(env.WECHAT_SERIAL_NO||'') && !!env.WECHAT_PRIVATE_KEY && textBytes(env.WECHAT_API_V3_KEY||'').length===32,503,'WECHAT_CONFIGURATION_INVALID','微信支付商户配置尚未完成');
  requireThat(keys && typeof keys==='object' && !Array.isArray(keys) && Object.keys(keys).length>0 && Object.entries(keys).every(([id,key])=>/^PUB_KEY_ID_[A-Za-z0-9_]+$/.test(id) && typeof key==='string' && key.trim().startsWith('-----BEGIN PUBLIC KEY-----')),503,'WECHAT_CONFIGURATION_INVALID','微信支付公钥配置不正确');
  const publicKeyId=env.WECHAT_PUBLIC_KEY_ID||Object.keys(keys)[0];
  requireThat(Object.hasOwn(keys,publicKeyId),503,'WECHAT_CONFIGURATION_INVALID','微信支付公钥配置不正确');
  const importedKeys=new Map<string,Promise<CryptoKey>>();
  const keyFor=(id:string)=>{let key=importedKeys.get(id);if(!key){key=rsaKey(keys[id],false);importedKeys.set(id,key);}return key;};
  let privateKey:Promise<CryptoKey>|undefined;
  const sign=async(message:string)=>encode64(await crypto.subtle.sign(rsaAlgorithm,await (privateKey??=rsaKey(env.WECHAT_PRIVATE_KEY!,true)),textBytes(message)));
  async function verify(headers:Headers,body:string):Promise<void> {
    const timestamp=headers.get('Wechatpay-Timestamp')||'',nonce=headers.get('Wechatpay-Nonce')||'',signature=headers.get('Wechatpay-Signature')||'',serial=headers.get('Wechatpay-Serial')||'';
    let valid=false;
    if (/^\d{10}$/.test(timestamp) && Math.abs(now()/1000-Number(timestamp))<=300 && nonce.length>0 && nonce.length<=256 && signature && !signature.startsWith('WECHATPAY/SIGNTEST/') && Object.hasOwn(keys,serial)) {
      try {valid=await crypto.subtle.verify(rsaAlgorithm,await keyFor(serial),decode64(signature),textBytes(`${timestamp}\n${nonce}\n${body}\n`));} catch {/* Fail closed on malformed key or signature. */}
    }
    requireThat(valid,401,'WECHAT_SIGNATURE_INVALID','微信支付签名校验失败');
  }
  async function request<T>(method:string,path:string,value?:unknown):Promise<T> {
    const body=value===undefined?'':JSON.stringify(value),timestamp=String(Math.floor(now()/1000)),nonce=randomNonce().slice(0,32);
    const signature=await sign(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`);
    const authorization=`WECHATPAY2-SHA256-RSA2048 mchid="${env.WECHAT_MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${env.WECHAT_SERIAL_NO}",signature="${signature}"`;
    let response:Response;
    try {response=await fetcher(`https://api.mch.weixin.qq.com${path}`,{method,headers:{Authorization:authorization,Accept:'application/json','Content-Type':'application/json','User-Agent':'BrclioPay/1.0','Wechatpay-Serial':publicKeyId},body:body||undefined,redirect:'manual',signal:AbortSignal.timeout(8000)});} catch {throw new HttpError(502,'WECHAT_UNAVAILABLE','微信支付网络暂时不可用，请稍后查单');}
    const raw=await response.text();
    requireThat(raw.length<=1024*1024,502,'WECHAT_RESPONSE_INVALID','微信支付响应过大');
    await verify(response.headers,raw);
    let data:any;try {data=raw?JSON.parse(raw):{};} catch {throw new HttpError(502,'WECHAT_RESPONSE_INVALID','微信支付响应格式不正确');}
    requireThat(data && typeof data==='object' && !Array.isArray(data),502,'WECHAT_RESPONSE_INVALID','微信支付响应格式不正确');
    if(!response.ok){const code=['ORDERPAID','ORDER_NOT_EXIST','ORDERNOTEXIST','OUT_TRADE_NO_USED','ORDER_CLOSED','PARAM_ERROR','NO_AUTH','APPID_MCHID_NOT_MATCH','FREQUENCY_LIMITED'].includes(data.code)?data.code:'UPSTREAM_ERROR';throw new WechatError(code);}
    return data as T;
  }
  function trade(value:WechatTransaction):Trade {
    requireThat(value && value.mchid===env.WECHAT_MCH_ID && value.appid===env.WECHAT_APP_ID && ['SUCCESS','REFUND','NOTPAY','CLOSED','REVOKED','USERPAYING','PAYERROR'].includes(value.trade_state) && (!value.trade_type||value.trade_type==='NATIVE'),400,'PAYMENT_MISMATCH','微信支付交易身份或状态不匹配');
    const paid=value.trade_state==='SUCCESS',amount=value.amount;
    requireThat((!paid&&!amount)||(!!amount&&Number.isSafeInteger(amount.total)&&amount.total>0&&(paid?amount.currency==='CNY':!amount.currency||amount.currency==='CNY')),400,'PAYMENT_MISMATCH','微信支付交易金额或币种不正确');
    let paidAt:string|undefined;
    if(paid){requireThat(/^\d{20,64}$/.test(value.transaction_id||'') && typeof value.success_time==='string' && Number.isFinite(Date.parse(value.success_time)),400,'PAYMENT_MISMATCH','微信支付交易流水或付款时间不正确');paidAt=new Date(value.success_time!).toISOString();}
    return {provider:'wechat',outTradeNo:logicalId(value.out_trade_no),tradeNo:value.transaction_id||'',tradeStatus:paid?'TRADE_SUCCESS':['REFUND','CLOSED','REVOKED'].includes(value.trade_state)?'TRADE_CLOSED':'WAIT_BUYER_PAY',totalAmount:amount?`${Math.floor(amount.total/100)}.${String(amount.total%100).padStart(2,'0')}`:'',sellerId:value.mchid,appId:value.appid,...(amount?.currency?{currency:amount.currency}:{}),...(paidAt?{paidAt}:{})};
  }
  return {
    async create(order,options){
      const id=wechatOrderNumber(order.id),amount=Number(order.totalAmount.replace('.',''));
      requireThat(/^\d{1,6}\.\d{2}$/.test(order.totalAmount)&&Number.isSafeInteger(amount)&&amount>0&&!!order.expiresAt&&Date.parse(order.expiresAt)-now()>=90_000,409,'ORDER_NOT_PAYABLE','订单即将过期，请返回产品重新发起');
      const notify=new URL(options.notifyUrl);requireThat(notify.protocol==='https:'&&!notify.username&&!notify.password&&!notify.hash,503,'WECHAT_CONFIGURATION_INVALID','微信支付通知地址不正确');
      const data=await request<{code_url?:unknown}>('POST','/v3/pay/transactions/native',{appid:env.WECHAT_APP_ID,mchid:env.WECHAT_MCH_ID,description:normalizedDescription(order.subject),out_trade_no:id,time_expire:order.expiresAt,notify_url:notify.toString(),amount:{total:amount,currency:'CNY'}});
      requireThat(typeof data.code_url==='string'&&data.code_url.startsWith('weixin://wxpay/bizpayurl?')&&data.code_url.length<=2048,502,'WECHAT_RESPONSE_INVALID','微信二维码响应不正确');
      return {codeUrl:data.code_url};
    },
    async query(id){
      try {const value=await request<WechatTransaction>('GET',`/v3/pay/transactions/out-trade-no/${wechatOrderNumber(id)}?mchid=${encodeURIComponent(env.WECHAT_MCH_ID!)}`);requireThat(value.out_trade_no===wechatOrderNumber(id),502,'PAYMENT_MISMATCH','微信查询交易号不匹配');return trade(value);}
      catch(error){if(error instanceof WechatError&&['ORDER_NOT_EXIST','ORDERNOTEXIST'].includes(error.providerCode))return null;throw error;}
    },
    async close(id){await request('POST',`/v3/pay/transactions/out-trade-no/${wechatOrderNumber(id)}/close`,{mchid:env.WECHAT_MCH_ID});},
    async notification(headers,raw){
      await verify(headers,raw);
      let event:any;try{event=JSON.parse(raw);}catch{throw new HttpError(400,'NOTIFY_INVALID','微信通知正文不正确');}
      requireThat(event?.event_type==='TRANSACTION.SUCCESS'&&event.resource_type==='encrypt-resource'&&event.resource?.algorithm==='AEAD_AES_256_GCM'&&event.resource?.original_type==='transaction'&&typeof event.resource.ciphertext==='string'&&typeof event.resource.nonce==='string'&&typeof event.resource.associated_data==='string',400,'NOTIFY_INVALID','微信通知类型不正确');
      let value:WechatTransaction;
      try{const key=await crypto.subtle.importKey('raw',textBytes(env.WECHAT_API_V3_KEY!),'AES-GCM',false,['decrypt']);const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:textBytes(event.resource.nonce),additionalData:textBytes(event.resource.associated_data),tagLength:128},key,decode64(event.resource.ciphertext));value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(plain));}catch{throw new HttpError(400,'NOTIFY_DECRYPT_FAILED','微信支付通知解密失败');}
      requireThat(value.trade_state==='SUCCESS',400,'NOTIFY_INVALID','微信支付通知状态不正确');return trade(value);
    },
  };
}
export type WechatAdapter = ReturnType<typeof createWechat>;
