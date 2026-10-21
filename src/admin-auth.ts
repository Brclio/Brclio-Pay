import {Buffer} from 'node:buffer';
import {hmacSha256,randomNonce,safeEqualHex,sha256} from './crypto';
import {HttpError,requireThat} from './config';
import type {Env} from './types';

const COOKIE='__Host-brclio_admin';
const SESSION_SECONDS=8*3600;
interface Session {sub:string;iat:number;exp:number;csrf:string;credential:string}
export interface AdminIdentity {email:string;csrfToken:string}
function configured(env:Env):void {
  requireThat(typeof env.ADMIN_EMAIL==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL) && /^[a-f0-9]{64}$/.test(env.ADMIN_SESSION_SECRET || '') && /^[a-f0-9]{64}$/.test(env.ADMIN_PASSWORD_PEPPER || '') && /^pbkdf2-sha256\$100000\$[a-f0-9]{64}\$[a-f0-9]{64}$/.test(env.ADMIN_PASSWORD_HASH || ''),503,'ADMIN_NOT_CONFIGURED','管理后台尚未完成配置');
}
function sessionSubject(env:Env):string{return sha256(env.ADMIN_EMAIL!.trim().toLowerCase());}
export function requireAdminOrigin(request:Request,env:Env):void {
  requireThat(request.headers.get('Origin')===new URL(env.PAY_BASE_URL).origin,403,'ADMIN_ORIGIN','请从支付中心管理页面操作');
  requireThat(!['cross-site','none'].includes(request.headers.get('Sec-Fetch-Site') || ''),403,'ADMIN_ORIGIN','请求来源无效');
}
export async function verifyAdminPassword(password:string,env:Env):Promise<boolean> {
  configured(env);
  const [,iteration,salt,expected]=env.ADMIN_PASSWORD_HASH!.split('$');
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(hmacSha256(env.ADMIN_PASSWORD_PEPPER!,password)),'PBKDF2',false,['deriveBits']);
  const result=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:Number(iteration),salt:Buffer.from(salt,'hex')},material,256);
  return safeEqualHex(Buffer.from(result).toString('hex'),expected);
}
export async function adminLogin(request:Request,env:Env,input:unknown,now=Date.now()):Promise<Response> {
  configured(env);requireAdminOrigin(request,env);
  requireThat(env.ADMIN_LOGIN_LIMITER,503,'ADMIN_NOT_CONFIGURED','登录保护尚未配置');
  const ip=request.headers.get('CF-Connecting-IP') || 'unknown';
  const limit=await env.ADMIN_LOGIN_LIMITER.limit({key:hmacSha256(env.ADMIN_SESSION_SECRET!,'login-ip:'+ip)});
  requireThat(limit.success,429,'LOGIN_RATE_LIMIT','登录尝试过于频繁，请一分钟后重试');
  requireThat(input && typeof input==='object' && !Array.isArray(input),400,'INVALID_REQUEST','登录参数错误');
  const {email,password}=input as {email?:unknown;password?:unknown};
  requireThat(typeof email==='string' && email.length<=254 && typeof password==='string' && password.length>0 && password.length<=1024,400,'INVALID_REQUEST','请填写账号和密码');
  // Both existing and unknown account names run the same password work.
  const passwordMatches=await verifyAdminPassword(password,env);
  requireThat(safeEqualHex(sha256(email.trim().toLowerCase()),sessionSubject(env)) && passwordMatches,401,'INVALID_LOGIN','账号或密码错误');
  const seconds=Math.floor(now/1000);const csrf=sha256(randomNonce());
  const payload:Session={sub:sessionSubject(env),iat:seconds,exp:seconds+SESSION_SECONDS,csrf,credential:sha256(env.ADMIN_PASSWORD_HASH!)};
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const value=encoded+'.'+hmacSha256(env.ADMIN_SESSION_SECRET!,'admin-session-v1:'+encoded);
  return Response.json({user:{email:env.ADMIN_EMAIL},csrfToken:csrf},{headers:{'Set-Cookie':`${COOKIE}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`}});
}
export function adminSession(request:Request,env:Env,now=Date.now()):AdminIdentity {
  configured(env);
  const values=(request.headers.get('Cookie') || '').split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));
  requireThat(values.length===1 && values[0].length<2048,401,'ADMIN_LOGIN_REQUIRED','请先登录管理后台');
  const value=values[0].slice(COOKIE.length+1);const pieces=value.split('.');
  requireThat(pieces.length===2 && /^[A-Za-z0-9_-]+$/.test(pieces[0]) && safeEqualHex(pieces[1],hmacSha256(env.ADMIN_SESSION_SECRET!,'admin-session-v1:'+pieces[0])),401,'ADMIN_LOGIN_REQUIRED','登录已失效，请重新登录');
  let data:Session;
  try{data=JSON.parse(Buffer.from(pieces[0],'base64url').toString('utf8'));}catch{throw new HttpError(401,'ADMIN_LOGIN_REQUIRED','登录已失效，请重新登录');}
  const seconds=Math.floor(now/1000);
  requireThat(data && typeof data.sub==='string' && safeEqualHex(data.sub,sessionSubject(env)) && Number.isInteger(data.iat) && Number.isInteger(data.exp) && data.iat<=seconds+30 && data.exp>seconds && data.exp-data.iat===SESSION_SECONDS && typeof data.csrf==='string' && /^[a-f0-9]{64}$/.test(data.csrf) && safeEqualHex(data.credential,sha256(env.ADMIN_PASSWORD_HASH!)),401,'ADMIN_LOGIN_REQUIRED','登录已失效，请重新登录');
  return {email:env.ADMIN_EMAIL!,csrfToken:data.csrf};
}
export function requireAdminMutation(request:Request,env:Env,identity:AdminIdentity):void {
  requireAdminOrigin(request,env);
  requireThat(safeEqualHex(request.headers.get('X-CSRF-Token') || '',identity.csrfToken),403,'ADMIN_CSRF','页面验证已失效，请刷新页面后重试');
}
export function adminLogout():Response {
  return Response.json({ok:true},{headers:{'Set-Cookie':`${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`}});
}
