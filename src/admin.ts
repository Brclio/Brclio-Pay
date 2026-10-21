import {adminLogin,adminLogout,adminSession,requireAdminMutation} from './admin-auth';
import {clients,HttpError,requireThat} from './config';
import {jsonBody} from './http';
import {Registry,type ClientConfig} from './registry';
import {makeIntegrationPrompt,skillMarkdown,skillZip,type SkillVariant} from './skill';
import type {Env,Store} from './types';
import {Reporting,type OrderStatus} from './reporting';
import {Payments,type AdminOrderAction,type OrderActionInput} from './payments';
import {createAlipay} from './alipay';
import {hmacSha256} from './crypto';

export interface AdminPaymentOptions {
  service?:()=>Promise<Payments>;
  waitUntil?:(promise:Promise<unknown>)=>void;
}

function reportQuery(url:URL,keys:string[]):Record<string,string> {
  const result:Record<string,string>={};
  for(const [key,value] of url.searchParams) {
    requireThat(keys.includes(key) && !Object.hasOwn(result,key) && value.length<=1024,400,'INVALID_REQUEST','报表查询参数无效');
    result[key]=value;
  }
  return result;
}

export async function handleAdmin(request:Request,env:Env,store:Store,paymentOptions:AdminPaymentOptions={}):Promise<Response> {
  const url=new URL(request.url);const {pathname,search}=url;
  const reportRead=request.method==='GET' && ['/api/admin/reports/summary','/api/admin/reports/orders'].includes(pathname);
  const skillRead=request.method==='GET' && ['/api/admin/skill','/api/admin/skill.zip'].includes(pathname);
  const variant=(url.searchParams.get('variant')||'brclio-pay-integrate') as SkillVariant;
  if(skillRead)requireThat(['brclio-pay-integrate','brclio-alipay-integrate','brclio-wechatpay-integrate'].includes(variant)&&[...url.searchParams.keys()].every(k=>k==='variant'),400,'INVALID_SKILL','Skill 类型无效');
  requireThat(!search || reportRead || skillRead,400,'INVALID_REQUEST','此管理接口不接受查询参数');
  if(pathname==='/api/admin/login') {
    requireThat(request.method==='POST',405,'METHOD_NOT_ALLOWED','请求方法不支持');
    return adminLogin(request,env,await jsonBody(request,4096));
  }
  const identity=adminSession(request,env);
  if(request.method!=='GET')requireAdminMutation(request,env,identity);
  if(pathname==='/api/admin/session' && request.method==='GET')return Response.json({user:{email:identity.email},csrfToken:identity.csrfToken});
  if(pathname==='/api/admin/logout' && request.method==='POST')return adminLogout();
  if(pathname==='/api/admin/skill' && request.method==='GET')return Response.json({content:skillMarkdown(variant)});
  if(pathname==='/api/admin/skill.zip' && request.method==='GET')return new Response(skillZip(variant) as BodyInit,{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${variant}.zip"`}});
  const orderAction=/^\/api\/admin\/orders\/(pay_[a-f0-9]{32})(?:\/(close|reopen|reconcile))?$/.exec(pathname);
  if(orderAction) {
    const [,id,action]=orderAction;
    requireThat(request.method===(action?'POST':'GET'),405,'METHOD_NOT_ALLOWED','请求方法不支持');
    let input:OrderActionInput|undefined;
    if(action) {
      const body=await jsonBody(request,4096);
      requireThat(body && typeof body==='object' && !Array.isArray(body),400,'INVALID_REQUEST','订单操作参数无效');
      const value=body as Record<string,unknown>;
      requireThat(Object.keys(value).every(key=>['expectedVersion','requestId','reason'].includes(key))
        && typeof value.expectedVersion==='string' && /^[a-f0-9]{64}$/.test(value.expectedVersion)
        && typeof value.requestId==='string' && /^[A-Za-z0-9_-]{8,100}$/.test(value.requestId)
        && typeof value.reason==='string' && value.reason.trim().length>0 && value.reason.trim().length<=500
        && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.reason),400,'INVALID_REQUEST','请填写操作原因并重新读取订单版本');
      input={expectedVersion:value.expectedVersion,requestId:value.requestId,reason:value.reason.trim()};
      if(env.PAYMENT_API_LIMITER) {
        const limit=await env.PAYMENT_API_LIMITER.limit({key:hmacSha256(env.CHECKOUT_SECRET,'admin-order:'+identity.email)});
        requireThat(limit.success,429,'PAYMENT_RATE_LIMIT','订单操作过于频繁，请稍后重试');
      }
    }
    // Do not initialize a gateway or read the registry before authentication,
    // CSRF, method and input validation have succeeded.
    const payments=paymentOptions.service ? await paymentOptions.service() : new Payments(
      {...env,CLIENTS_JSON:JSON.stringify(await new Registry(env,store).resolveClients())},store,createAlipay(env));
    const original=await payments.order(id);
    const client=clients(payments.env).find(item=>item.id===original.clientId);
    const detail=action ? await payments.adminAction(id,action as AdminOrderAction,input!,identity.email,client) : await payments.adminDetail(id);
    detail.actions.reopen=detail.actions.reopen && payments.env.PAYMENT_ENABLED==='true' && !!client && client.enabled!==false
      && Object.hasOwn(client.skus,original.sku) && client.skus[original.sku].enabled!==false;
    if(action && detail.order.status==='PAID' && client) {
      const delivery=payments.deliver(`evt_${id}`,client).catch(()=>console.warn('webhook_delivery_failed'));
      if(paymentOptions.waitUntil)paymentOptions.waitUntil(delivery);else await delivery;
    }
    return Response.json(detail);
  }
  if(reportRead) {
    const reporting=new Reporting(store,env.PAYMENT_MODE);
    if(pathname==='/api/admin/reports/summary') {
      const query=reportQuery(url,['month','clientId']);
      const month=query.month || new Date(Date.now()+8*3600000).toISOString().slice(0,7);
      return Response.json(await reporting.summary({month,...(query.clientId?{clientId:query.clientId}:{})}));
    }
    const query=reportQuery(url,['month','clientId','status','limit','cursor']);
    requireThat(query.limit===undefined || /^\d{1,2}$/.test(query.limit),400,'INVALID_LIMIT','每页数量格式错误');
    return Response.json(await reporting.orders({...(query.month?{month:query.month}:{}),...(query.clientId?{clientId:query.clientId}:{}),...(query.status?{status:query.status as OrderStatus}:{}),...(query.limit?{limit:Number(query.limit)}:{}),...(query.cursor?{cursor:query.cursor}:{})}));
  }
  if(pathname==='/api/admin/reports/rebuild' && request.method==='POST') {
    const body=await jsonBody(request,4096) as {limit?:number;cursor?:string};
    requireThat(body && typeof body==='object' && !Array.isArray(body) && Object.keys(body).every(key=>['limit','cursor'].includes(key)) && (body.cursor===undefined || typeof body.cursor==='string'),400,'INVALID_REQUEST','补建参数无效');
    return Response.json(await new Reporting(store,env.PAYMENT_MODE).rebuild(body));
  }
  const registry=new Registry(env,store);
  if(pathname==='/api/admin/clients' && request.method==='GET')return Response.json({clients:await registry.list()});
  if(pathname==='/api/admin/clients' && request.method==='POST') {
    const body=await jsonBody(request) as {config?:ClientConfig;expectedVersion?:string};
    requireThat(body && typeof body==='object' && body.config && typeof body.expectedVersion==='string',400,'INVALID_REQUEST','平台配置或版本缺失');
    return Response.json({client:await registry.upsertClient(body.config,body.expectedVersion,identity.email)});
  }
  if(pathname==='/api/admin/grants' && request.method==='POST') {
    const body=await jsonBody(request,16384) as {clientId:string;mode:'create'|'update';allowedOrigins:string[];pricingMode?:'detect'|'manual';domainMode?:'fixed'|'auto';skillVariant?:SkillVariant};
    requireThat(body && typeof body==='object' && !Array.isArray(body) && Object.keys(body).every(key=>['clientId','mode','allowedOrigins','pricingMode','domainMode','skillVariant'].includes(key)),400,'INVALID_REQUEST','授权参数无效');
    const {skillVariant,...grantInput}=body;
    requireThat(!skillVariant||['brclio-pay-integrate','brclio-alipay-integrate','brclio-wechatpay-integrate'].includes(skillVariant),400,'INVALID_SKILL','Skill 类型无效');
    const grant=await registry.createGrant(grantInput,identity.email);
    return Response.json({grantId:grant.id,clientId:grant.clientId,expiresAt:grant.expiresAt,prompt:makeIntegrationPrompt({variant:skillVariant,clientId:grant.clientId,mode:grant.mode,token:grant.token,expiresAt:grant.expiresAt,baseUrl:env.PAY_BASE_URL,paymentMode:env.PAYMENT_MODE,pricingMode:grant.pricingMode,domainMode:grant.domainMode})});
  }
  if(pathname==='/api/admin/grants' && request.method==='GET')return Response.json({grants:await registry.listGrants()});
  const revoke=/^\/api\/admin\/grants\/(grant_[a-f0-9]{32})\/revoke$/.exec(pathname);
  if(revoke && request.method==='POST') {
    await registry.revokeGrant(revoke[1],identity.email);
    return Response.json({ok:true});
  }
  if(pathname==='/api/admin/audit' && request.method==='GET')return Response.json({entries:await registry.audit()});
  throw new HttpError(404,'NOT_FOUND','管理接口不存在');
}
