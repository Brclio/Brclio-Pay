import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {isIP} from 'node:net';
import {once} from 'node:events';
import worker,{handle} from '../src/index';
import type {Env} from '../src/types';

const BODY_LIMIT=256*1024;
const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);

/** Bounded, per-process limiter. The systemd deployment runs exactly one process. */
export function rateLimiter(maximum:number,periodMs=60_000,now:()=>number=Date.now):NonNullable<Env['ADMIN_LOGIN_LIMITER']> {
  const entries=new Map<string,{count:number;until:number}>();let sweepAt=0;
  return {async limit({key}){
    const time=now();
    if(time>=sweepAt){for(const [id,value] of entries)if(value.until<=time)entries.delete(id);sweepAt=time+periodMs;}
    let current=entries.get(key);
    if(!current||current.until<=time){
      if(!current&&entries.size>=50_000)return {success:false};
      current={count:0,until:time+periodMs};entries.set(key,current);
    }
    if(current.count>=maximum)return {success:false};
    current.count++;return {success:true};
  }};
}

function errorResponse(status:number,code:string):Response {
  return Response.json({error:{code,message:'请求无法处理'}},{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}

async function bodyFor(req:IncomingMessage):Promise<Uint8Array> {
  if(Number(req.headers['content-length']||0)>BODY_LIMIT)throw new RangeError('request body limit');
  const parts:Buffer[]=[];let total=0;
  for await(const part of req){total+=part.length;if(total>BODY_LIMIT)throw new RangeError('request body limit');parts.push(part);}
  return new Uint8Array(Buffer.concat(parts));
}

/** Only loopback Nginx is trusted to set X-Real-IP. All Cloudflare/forwarded headers are replaced. */
export async function incomingRequest(req:IncomingMessage,allowedHosts:ReadonlySet<string>):Promise<Request> {
  if(!LOOPBACK.has(req.socket.remoteAddress||''))throw new Error('untrusted proxy');
  const host=req.headers.host;
  if(!host||!allowedHosts.has(host.toLowerCase()))throw new Error('untrusted host');
  const path=req.url||'/';
  if(!path.startsWith('/')||path.startsWith('//')||/[\\\x00-\x20\x7f]/.test(path))throw new Error('invalid path');
  const headers=new Headers();
  for(const [name,value] of Object.entries(req.headers)){
    if(['host','connection','transfer-encoding','cf-connecting-ip','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip'].includes(name))continue;
    if(Array.isArray(value))for(const item of value)headers.append(name,item);
    else if(value!==undefined)headers.set(name,value);
  }
  const realIp=req.headers['x-real-ip'];
  headers.set('CF-Connecting-IP',typeof realIp==='string'&&isIP(realIp)?realIp:req.socket.remoteAddress!);
  const method=req.method||'GET';
  if(method==='GET'||method==='HEAD'){
    if(req.headers['transfer-encoding']||Number(req.headers['content-length']||0)>0)throw new Error('unexpected body');
    return new Request('https://'+host+path,{method,headers});
  }
  const body=await bodyFor(req);
  return new Request('https://'+host+path,{method,headers,body:body.buffer as ArrayBuffer});
}

async function writeResponse(res:ServerResponse,response:Response,head:boolean):Promise<void> {
  res.statusCode=response.status;
  for(const [name,value] of response.headers)if(name!=='set-cookie')res.setHeader(name,value);
  const cookies=(response.headers as unknown as {getSetCookie():string[]}).getSetCookie();
  if(cookies.length)res.setHeader('Set-Cookie',cookies);
  if(head||!response.body){await response.body?.cancel();res.end();return;}
  const reader=response.body.getReader();
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;if(res.destroyed)break;if(!res.write(value))await Promise.race([once(res,'drain'),once(res,'close')]);}
    if(!res.destroyed)res.end();
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

export interface RuntimeOptions {
  env:Env;
  maintenance?:boolean;
  maintenanceIntervalMs?:number;
  /** Test injection; production always uses the payment handler. */
  handler?:typeof handle;
}

export function createPaymentServer({env,maintenance=true,maintenanceIntervalMs=60_000,handler=handle}:RuntimeOptions){
  const origins=[env.PAY_BASE_URL,env.LEGACY_WECHAT_BASE_URL].filter(Boolean) as string[];
  const allowedHosts=new Set(origins.map(origin=>{const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('invalid public origin');return url.host.toLowerCase();}));
  const pending=new Set<Promise<unknown>>(),activeRequests=new Set<Promise<void>>();let closing=false,maintenanceRunning=false;
  const context={waitUntil(task:Promise<unknown>){const tracked=Promise.resolve(task).catch(()=>{console.warn('background_task_failed');});pending.add(tracked);void tracked.finally(()=>pending.delete(tracked));},passThroughOnException(){}} as unknown as ExecutionContext;
  async function processRequest(req:IncomingMessage,res:ServerResponse){
    if(closing){res.writeHead(503,{'Cache-Control':'no-store','Connection':'close'});res.end();return;}
    try{
      let request:Request;
      try{request=await incomingRequest(req,allowedHosts);}catch(error){await writeResponse(res,errorResponse(error instanceof RangeError?413:400,error instanceof RangeError?'BODY_TOO_LARGE':'INVALID_REQUEST'),req.method==='HEAD');return;}
      await writeResponse(res,await handler(request,env,context),req.method==='HEAD');
    }catch{console.warn('request_failed');if(!res.headersSent){res.writeHead(503,{'Cache-Control':'no-store','Content-Type':'application/json'});res.end('{"error":{"code":"SERVICE_UNAVAILABLE","message":"服务暂不可用"}}');}else res.destroy();}
  }
  const server=createServer({maxHeaderSize:16*1024},(req,res)=>{
    const task=processRequest(req,res);activeRequests.add(task);
    void task.finally(()=>activeRequests.delete(task));
  });
  server.requestTimeout=30_000;server.headersTimeout=15_000;server.keepAliveTimeout=5_000;
  server.maxRequestsPerSocket=1000;
  server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
  async function runMaintenance(){
    if(closing||maintenanceRunning||!maintenance)return;
    maintenanceRunning=true;
    const tasks:Promise<unknown>[]=[];
    try{await worker.scheduled({} as ScheduledController,env,{...context,waitUntil(task:Promise<unknown>){tasks.push(task);context.waitUntil(task);}} as unknown as ExecutionContext);await Promise.allSettled(tasks);}finally{maintenanceRunning=false;}
  }
  const timer=maintenance?setInterval(()=>{void runMaintenance();},maintenanceIntervalMs):undefined;
  timer?.unref();
  return {server,runMaintenance,async close(){
    closing=true;if(timer)clearInterval(timer);
    if(server.listening)await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();});
    // The supervisor's stop timeout is the last bound; callbacks are allowed to persist their leases/outbox.
    while(activeRequests.size||pending.size)await Promise.allSettled([...activeRequests,...pending]);
  }};
}
