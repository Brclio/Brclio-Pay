import {GitHubStore,GitHubError} from './store';
import {createAlipay} from './alipay';
import {authenticate,authenticateCheckout,authenticateHeaders,checkoutToken} from './auth';
import {clients,configurationReady,HttpError,requireReady,requireThat} from './config';
import {Payments} from './payments';
import type {Env,ProductClient} from './types';
import {handleAdmin} from './admin';
import {handleIntegration} from './integration';
import {Registry} from './registry';
import {hmacSha256,sha256,safeEqualHex} from './crypto';
import {GitHubApp} from './github-app';
import {PartitionedStore} from './partitioned-store';
import {createWechat} from './wechat';
import {skillMarkdown,skillZip,type SkillVariant} from './skill';
import {handleLegacyWechat} from './legacy-wechat';

function json(value:unknown,status=200):Response {return Response.json(value,{status});}
function secure(response:Response):Response {
  const res=new Response(response.body,response);
  res.headers.set('X-Content-Type-Options','nosniff');
  res.headers.set('Referrer-Policy','no-referrer');
  res.headers.set('Cache-Control','no-store');
  res.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.headers.set('Strict-Transport-Security','max-age=31536000');
  return res;
}
async function readBody(request:Request,limit=16_384):Promise<string> {
  requireThat(Number(request.headers.get('Content-Length') || 0)<=limit,413,'BODY_TOO_LARGE','请求过大');
  if (!request.body) return '';
  const reader=request.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let length=0;let text='';
  try {
    for (;;) {const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new HttpError(413,'BODY_TOO_LARGE','请求过大');}text+=decoder.decode(value,{stream:true});}
    return text+decoder.decode();
  } finally {reader.releaseLock();}
}
function parseJson(raw:string):unknown {try{return JSON.parse(raw);}catch{throw new HttpError(400,'INVALID_JSON','JSON 格式错误');}}
function findClient(env:Env,id:string):ProductClient {const c=clients(env).find(c=>c.id===id);requireThat(c,503,'CLIENT_UNAVAILABLE','产品暂不可用');return c;}
let cached:{env:Env;payments:Payments}|undefined;
let cachedStore:{key:string;store:PartitionedStore}|undefined;
function storeFor(env:Env):PartitionedStore {
  const key=sha256(JSON.stringify([env.GITHUB_TOKEN,env.GITHUB_APP_ID,env.GITHUB_APP_PRIVATE_KEY,env.GITHUB_APP_INSTALLATION_ID,env.GITHUB_REPOSITORY,env.GITHUB_BRANCH]));
  if(cachedStore?.key===key)return cachedStore.store;
  const app=env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY ? new GitHubApp({appId:env.GITHUB_APP_ID,privateKey:env.GITHUB_APP_PRIVATE_KEY,repository:env.GITHUB_REPOSITORY,installationId:env.GITHUB_APP_INSTALLATION_ID}):undefined;
  const store=new PartitionedStore(new GitHubStore({token:env.GITHUB_TOKEN || '',tokenProvider:app?()=>app.token():undefined,repository:env.GITHUB_REPOSITORY,branch:env.GITHUB_BRANCH}));
  cachedStore={key,store};return store;
}
async function runtimeEnv(env:Env,store?:import('./types').Store):Promise<Env> {
  const registered=await new Registry(env,store || storeFor(env)).resolveClients();
  return {...env,CLIENTS_JSON:JSON.stringify(registered)};
}
let healthCache:{key:string;until:number;value:Record<string,unknown>}|undefined;
export function service(env:Env):Payments {
  if(cached?.env===env)return cached.payments;
  const payments=new Payments(env,storeFor(env),createAlipay(env),Date.now,undefined,env.WECHAT_CHANNELS?.split(',').includes('native')?createWechat(env):undefined);
  cached={env,payments};return payments;
}

export async function handle(request:Request,env:Env,ctx:ExecutionContext,provided?:Payments):Promise<Response> {
  try {
    const url=new URL(request.url);const path=url.pathname;
    const legacyCheckout=/^\/api\/legacy\/wechat\/checkout\/([a-f0-9]{32})\/exchange$/.exec(path);
    if(legacyCheckout){
      requireThat(request.method==='GET'&&!url.search,405,'METHOD_NOT_ALLOWED','请求方法不支持');
      const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
      requireThat(env.LEGACY_WECHAT_CHECKOUT_SECRET&&safeEqualHex(token,hmacSha256(env.LEGACY_WECHAT_CHECKOUT_SECRET,'checkout:v1:'+legacyCheckout[1])),401,'UNAUTHORIZED','支付链接无效，请从产品重新打开');
      const id='pay_'+legacyCheckout[1],base=env.LEGACY_WECHAT_BASE_URL||'https://paywc.bornforthis.cn';
      return secure(json({checkoutUrl:`${base}/checkout/${id}#token=${checkoutToken(id,env)}`}));
    }
    const legacyHost=new URL(env.LEGACY_WECHAT_BASE_URL||'https://paywc.bornforthis.cn').hostname;
    if(url.hostname===legacyHost&&(path==='/api/v1/orders'||/^\/api\/v1\/orders\/[a-f0-9]{32}(?:\/(?:refresh|retry-notification))?$/.test(path)||/^\/api\/checkout\/[a-f0-9]{32}(?:\/refresh)?$/.test(path))){
      const legacyRead=/^\/api\/checkout\//.test(path);
      if(legacyRead)requireThat(/^Bearer [a-f0-9]{64}$/.test(request.headers.get('Authorization')||''),401,'UNAUTHORIZED','需要支付授权');
      else{
        const timestamp=request.headers.get('X-Brclio-Timestamp')||'';
        requireThat(/^[a-z0-9][a-z0-9_-]{1,63}$/.test(request.headers.get('X-Brclio-Client')||'')&&/^\d{10}$/.test(timestamp)&&Math.abs(Date.now()/1000-Number(timestamp))<=300&&/^[A-Za-z0-9_-]{16,128}$/.test(request.headers.get('X-Brclio-Nonce')||'')&&/^[a-f0-9]{64}$/.test(request.headers.get('X-Brclio-Signature')||''),401,'UNAUTHORIZED','请求签名无效或已过期');
      }
      if(env.PAYMENT_API_LIMITER){const limit=await env.PAYMENT_API_LIMITER.limit({key:hmacSha256(env.CHECKOUT_SECRET,'payment-ip:'+(request.headers.get('CF-Connecting-IP')||'unknown'))});requireThat(limit.success,429,'PAYMENT_RATE_LIMIT','请求过于频繁，请稍后重试');}
      const effective=await runtimeEnv(env,provided?.store);requireReady(effective,false);
      const payments=provided||service(effective);
      return secure(await handleLegacyWechat(request,effective,payments,ctx));
    }
    if(url.hostname===legacyHost&&['/admin','/admin/','/admin.html'].includes(path))return secure(Response.redirect(env.PAY_BASE_URL+'/admin',302));
    const skillMatch=/^\/api\/skills\/(brclio-pay-integrate|brclio-alipay-integrate|brclio-wechatpay-integrate)(\.zip|\/SKILL\.md)$/.exec(path);
    if(skillMatch && ['GET','HEAD'].includes(request.method)){
      const variant=skillMatch[1] as SkillVariant;
      return secure(new Response(request.method==='HEAD'?null:skillMatch[2]==='.zip'?skillZip(variant) as BodyInit:skillMarkdown(variant),{headers:{'Content-Type':skillMatch[2]==='.zip'?'application/zip':'text/markdown;charset=utf-8',...(skillMatch[2]==='.zip'?{'Content-Disposition':`attachment; filename="${variant}.zip"`}:{})}}));
    }
    if (request.method==='GET' && path==='/api/health') {
      const key=hmacSha256(env.CHECKOUT_SECRET || 'unconfigured',JSON.stringify([env.GITHUB_REPOSITORY,env.PAYMENT_ENABLED,env.CLIENTS_JSON,env.REGISTRY_ENCRYPTION_KEY]));
      if(healthCache?.key===key && healthCache.until>Date.now())return secure(json(healthCache.value));
      let ready=false;try{const effective=await runtimeEnv(env,provided?.store);ready=configurationReady(effective);if(ready&&effective.WECHAT_CHANNELS?.split(',').includes('native'))createWechat(effective);}catch{ready=false;/* report availability only */}
      const value={service:'Brclio Pay',version:'1.2.1',ready,acceptingPayments:ready && env.PAYMENT_ENABLED==='true',mode:env.PAYMENT_MODE || 'live',providers:{alipay:{configured:!!(env.ALIPAY_PRIVATE_KEY&&env.ALIPAY_PUBLIC_KEY),channels:env.ALIPAY_CHANNELS?.split(',')||[]},wechat:{configured:!!(env.WECHAT_PRIVATE_KEY&&env.WECHAT_API_V3_KEY&&env.WECHAT_PUBLIC_KEYS_JSON),channels:env.WECHAT_CHANNELS?.split(',')||[]}},storage:'github-private-plaintext'};
      healthCache={key,until:Date.now()+15000,value};return secure(json(value));
    }
    if(path.startsWith('/api/admin/'))return secure(await handleAdmin(request,env,provided?.store || storeFor(env),{
      service:async()=>{
        const effective=await runtimeEnv(env,provided?.store);
        return provided ? new Payments(effective,provided.store,provided.gateway,provided.now,provided.send,provided.wechatGateway) : service(effective);
      },waitUntil:promise=>ctx.waitUntil(promise),
    }));
    if(path.startsWith('/api/integration/')) {
      requireThat(env.INTEGRATION_LIMITER && env.ADMIN_SESSION_SECRET,503,'INTEGRATION_NOT_CONFIGURED','接入服务尚未完成配置');
      const limit=await env.INTEGRATION_LIMITER.limit({key:hmacSha256(env.ADMIN_SESSION_SECRET,'integration-ip:'+(request.headers.get('CF-Connecting-IP') || 'unknown'))});
      requireThat(limit.success,429,'INTEGRATION_RATE_LIMIT','接入请求过于频繁，请稍后重试');
      return secure(await handleIntegration(request,env,provided?.store || storeFor(env)));
    }
    if (request.method==='GET' && path==='/payment/return') {
      const id=url.searchParams.get('payment_order_id') || url.searchParams.get('out_trade_no');requireThat(id && /^pay_[a-f0-9]{32}$/.test(id),400,'INVALID_ORDER','订单参数错误');
      // A return query is untrusted. It grants no rights and cannot change payment status.
      return secure(Response.redirect(`${env.PAY_BASE_URL}/checkout/${id}`,303));
    }
    if (!path.startsWith('/api/')) {
      requireThat(['GET','HEAD'].includes(request.method),405,'METHOD_NOT_ALLOWED','请求方法不支持');
      const staticUrl=new URL(request.url);
      if(['/admin','/admin/','/admin.html'].includes(path))staticUrl.pathname='/admin.html';
      if(['/clients','/clients/','/clients.html'].includes(path))staticUrl.pathname='/clients.html';
      if(path.startsWith('/skills/') || path.endsWith('.zip'))throw new HttpError(404,'NOT_FOUND','文件不存在');
      if (/^\/checkout\/pay_[a-f0-9]{32}$/.test(path)) staticUrl.pathname='/checkout.html';
      if (/^\/checkout\/[a-f0-9]{32}\/?$/.test(path)) staticUrl.pathname='/legacy-checkout.html';
      return secure(await env.ASSETS.fetch(new Request(staticUrl,{method:request.method})));
    }
    // Reject invalid routes and missing/expired credentials before spending a GitHub read.
    const productMatch=/^\/api\/v1\/orders\/(pay_[a-f0-9]{32})(\/refresh)?$/.exec(path);
    const checkoutMatch=/^\/api\/checkout\/(pay_[a-f0-9]{32})(\/(pay|refresh))?$/.exec(path);
    if(path==='/api/alipay/notify') {
      requireThat(request.method==='POST',405,'METHOD_NOT_ALLOWED','请求方法不支持');
      requireThat(request.headers.get('Content-Type')?.split(';')[0].trim()==='application/x-www-form-urlencoded',415,'INVALID_CONTENT_TYPE','通知类型错误');
    } else if(path==='/api/wechat/notify') {
      requireThat(request.method==='POST',405,'METHOD_NOT_ALLOWED','请求方法不支持');
      requireThat(request.headers.get('Content-Type')?.split(';')[0].trim()==='application/json',415,'INVALID_CONTENT_TYPE','通知类型错误');
    } else if(path==='/api/v1/orders' || path==='/api/v1/catalog' || productMatch) {
      requireThat(request.method===(path==='/api/v1/orders' || productMatch?.[2]?'POST':'GET'),405,'METHOD_NOT_ALLOWED','请求方法不支持');
      authenticateHeaders(request);
    } else if(checkoutMatch) {
      requireThat(!url.search,400,'INVALID_REQUEST','请通过 Authorization 传递支付令牌');
      requireThat(request.method===(checkoutMatch[3]?'POST':'GET'),405,'METHOD_NOT_ALLOWED','请求方法不支持');
      authenticateCheckout(request,checkoutMatch[1],env);
    } else throw new HttpError(404,'NOT_FOUND','接口不存在');
    if(env.PAYMENT_API_LIMITER) {
      const limit=await env.PAYMENT_API_LIMITER.limit({key:hmacSha256(env.CHECKOUT_SECRET,'payment-ip:'+(request.headers.get('CF-Connecting-IP') || 'unknown'))});
      requireThat(limit.success,429,'PAYMENT_RATE_LIMIT','请求过于频繁，请稍后重试');
    }
    env=await runtimeEnv(env,provided?.store);
    requireReady(env,false);
    const payments=provided || service(env);
    if(path==='/api/v1/catalog') {
      const raw=await readBody(request);requireThat(raw==='',400,'INVALID_REQUEST','目录接口不接受请求体');
      const client=authenticate(request,raw,env);
      const skus=Object.fromEntries(Object.entries(client.skus).sort(([a],[b])=>a.localeCompare(b)).map(([sku,item])=>[sku,{...item,enabled:item.enabled!==false}]));
      return secure(json({clientId:client.id,name:client.name,enabled:client.enabled!==false,acceptingPayments:env.PAYMENT_ENABLED==='true' && client.enabled!==false,mode:env.PAYMENT_MODE,currency:'CNY',version:sha256(JSON.stringify(skus)),providers:client.providers||['alipay'],channels:{alipay:env.ALIPAY_CHANNELS.split(','),wechat:env.WECHAT_CHANNELS?.split(',')||[]},skus}));
    }
    if(path==='/api/wechat/notify'){
      const order=await payments.wechatNotification(request.headers,await readBody(request,65536));
      if(order?.status==='PAID')ctx.waitUntil(payments.deliver(`evt_${order.id}`,findClient(env,order.clientId)).catch(()=>console.warn('webhook_delivery_failed')));
      return secure(new Response(null,{status:204}));
    }
    if (path==='/api/alipay/notify' && request.method==='POST') {
      requireThat(request.headers.get('Content-Type')?.split(';')[0].trim()==='application/x-www-form-urlencoded',415,'INVALID_CONTENT_TYPE','通知类型错误');
      const raw=await readBody(request,32_768);const form=new URLSearchParams(raw);const data:Record<string,string>=Object.create(null);
      for (const [key,value] of form) {requireThat(!Object.hasOwn(data,key),400,'DUPLICATE_FIELD','重复通知字段');data[key]=value;}
      const order=await payments.notification(data);
      if(order?.status==='PAID')ctx.waitUntil(payments.deliver(`evt_${order.id}`,findClient(env,order.clientId)).catch(()=>console.warn('webhook_delivery_failed')));
      return secure(new Response('success',{headers:{'Content-Type':'text/plain;charset=utf-8'}}));
    }
    if (path==='/api/v1/orders' && request.method==='POST') {
      requireReady(env,true);
      requireThat(request.headers.get('Content-Type')?.split(';')[0].trim()==='application/json',415,'INVALID_CONTENT_TYPE','请求需要 JSON');
      const raw=await readBody(request);const client=authenticate(request,raw,env);
      requireThat(client.enabled!==false,403,'CLIENT_DISABLED','该平台已暂停新订单');
      return secure(json(await payments.create(client,parseJson(raw)),201));
    }
    if (productMatch) {
      requireThat(request.method===(productMatch[2]?'POST':'GET'),405,'METHOD_NOT_ALLOWED','请求方法不支持');
      const raw=await readBody(request);requireThat(raw==='' || raw==='{}',400,'INVALID_REQUEST','此接口不接受参数');
      const client=authenticate(request,raw,env);let order=await payments.order(productMatch[1]);
      requireThat(order.clientId===client.id,404,'NOT_FOUND','订单不存在');
      if(productMatch[2])order=await payments.refresh(order.id);
      if(productMatch[2] && order.status==='PAID')ctx.waitUntil(payments.deliver(`evt_${order.id}`,client).catch(()=>console.warn('webhook_delivery_failed')));
      return secure(json({...payments.view(order,client),productOrderId:order.productOrderId,sku:order.sku,tradeNo:order.tradeNo,paidAt:order.paidAt}));
    }
    if(checkoutMatch) {
      requireThat(!url.search,400,'INVALID_REQUEST','请通过 Authorization 传递支付令牌');
      const [,id,,action]=checkoutMatch;authenticateCheckout(request,id,env);
      requireThat(request.method===(action?'POST':'GET'),405,'METHOD_NOT_ALLOWED','请求方法不支持');
      let order=await payments.order(id);const client=findClient(env,order.clientId);
      if(action==='refresh')order=await payments.refresh(id);
      if(action==='pay') {
        const expiresAt=payments.paymentExpiresAt(order);
        requireReady(env,true);requireThat(order.status==='PENDING' && Date.now()<Date.parse(expiresAt),409,'ORDER_NOT_PAYABLE','订单已支付、关闭或过期，请返回产品创建新订单');
        requireThat(client.enabled!==false,403,'CLIENT_DISABLED','该平台已暂停新付款');
        requireThat((client.providers||['alipay']).includes(order.provider||'alipay'),403,'PROVIDER_NOT_ALLOWED','该产品已暂停此付款方式');
        const input=parseJson(await readBody(request)) as {channel?:string};
        requireThat(input && typeof input.channel==='string',400,'CHANNEL_UNAVAILABLE','请选择支付方式');
        return secure(json(await payments.pay(id,input.channel,`${env.PAY_BASE_URL}/payment/return?payment_order_id=${id}`)));
      }
      if(action==='refresh' && order.status==='PAID')ctx.waitUntil(payments.deliver(`evt_${id}`,client).catch(()=>console.warn('webhook_delivery_failed')));
      return secure(json(payments.view(order,client)));
    }
    throw new HttpError(404,'NOT_FOUND','接口不存在');
  } catch(error) {
    const status=error instanceof HttpError?error.status:error instanceof GitHubError && error.status===409?409:503;
    const code=error instanceof HttpError || error instanceof GitHubError?error.code:'SERVICE_UNAVAILABLE';
    const message=error instanceof HttpError?error.message:'服务暂不可用，请稍后重试';
    // SDK/provider errors may contain credentials; only stable internal codes go to logs.
    if(status>=500)console.warn(code);
    if(new URL(request.url).pathname==='/api/alipay/notify')return secure(new Response('failure',{status,headers:{'Content-Type':'text/plain;charset=utf-8'}}));
    return secure(json({error:{code,message}},status));
  }
}
export default {
  fetch:handle,
  async scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext) {
    ctx.waitUntil((async()=>{try {const effective=await runtimeEnv(env);requireReady(effective,false);await service(effective).maintenance(clients(effective));}catch{console.warn('maintenance_not_ready');}})());
  }
};
