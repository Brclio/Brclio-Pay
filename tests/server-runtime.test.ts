import {afterEach,describe,expect,it,vi} from 'vitest';
import {request as httpRequest} from 'node:http';
import {mkdtemp,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,pbkdf2Sync} from 'node:crypto';
import {createPaymentServer,rateLimiter} from '../server/runtime';
import {staticAssets} from '../server/assets';
import {hmacSha256,sha256} from '../src/crypto';
import {configurationReady,requireInfrastructureReady} from '../src/config';
import type {Env,ProductClient,Store,Transaction} from '../src/types';

const base='https://pay.example.com';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
const product:ProductClient={id:'server-product',name:'Server fixture',apiSecret:'a'.repeat(64),webhookSecret:'b'.repeat(64),providers:['alipay','wechat'],webhookUrl:'https://product.example.com/payment',returnOrigins:['https://product.example.com'],skus:{pro:{subject:'Pro',amount:'3.00'}}};
class MemoryStore implements Store {
  data=new Map<string,unknown>();
  async readJson<T>(path:string){return (structuredClone(this.data.get(path))??null) as T|null;}
  async transaction<T>(callback:(tx:Transaction)=>Promise<T>){const next=structuredClone(this.data);const result=await callback({read:async<V>(path:string)=>(structuredClone(next.get(path))??null) as V|null,put:(path,value)=>next.set(path,structuredClone(value))});this.data=next;return result;}
}
function fixture():Env {
  const pepper='c'.repeat(64),salt='d'.repeat(64),password='local-runtime-fixture';
  return {ASSETS:{fetch:async()=>new Response('fixture page')} as unknown as Fetcher,STORAGE:new MemoryStore(),STORAGE_BACKEND:'sqlite',PAY_BASE_URL:base,LEGACY_WECHAT_BASE_URL:'https://wechat.example.com',PAYMENT_MODE:'live',PAYMENT_ENABLED:'true',ALIPAY_CHANNELS:'page,wap',ALIPAY_APP_ID:'2021007109602288',ALIPAY_SELLER_ID:'2088123456789012',ALIPAY_PRIVATE_KEY:privateKey,ALIPAY_PUBLIC_KEY:publicKey,WECHAT_CHANNELS:'native',WECHAT_MCH_ID:'1234567890',WECHAT_APP_ID:'wx0123456789abcdef',WECHAT_SERIAL_NO:'A'.repeat(40),WECHAT_PRIVATE_KEY:privateKey,WECHAT_PUBLIC_KEYS_JSON:JSON.stringify({PUB_KEY_ID_fixture:publicKey}),WECHAT_API_V3_KEY:'v'.repeat(32),GITHUB_TOKEN:'',GITHUB_REPOSITORY:'',GITHUB_BRANCH:'',CHECKOUT_SECRET:'e'.repeat(64),CLIENTS_JSON:JSON.stringify([product]),REGISTRY_STORAGE_MODE:'plain',ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD_PEPPER:pepper,ADMIN_PASSWORD_HASH:`pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(hmacSha256(pepper,password),Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')}`,ADMIN_SESSION_SECRET:'f'.repeat(64),ADMIN_LOGIN_LIMITER:rateLimiter(5),INTEGRATION_LIMITER:rateLimiter(30),PAYMENT_API_LIMITER:rateLimiter(120)};
}
type Reply={status:number;headers:import('node:http').IncomingHttpHeaders;text:string;json:()=>any};
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();while(cleanups.length)await cleanups.pop()!();});
async function listening(env=fixture(),handler?:Parameters<typeof createPaymentServer>[0]['handler']){
  const runtime=createPaymentServer({env,maintenance:false,handler});
  await new Promise<void>(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  const address=runtime.server.address() as {port:number};
  cleanups.push(()=>runtime.close());
  function call(path:string,options:{method?:string;headers?:Record<string,string>;body?:string}={}):Promise<Reply>{
    return new Promise((resolve,reject)=>{
      const req=httpRequest({host:'127.0.0.1',port:address.port,path,method:options.method||'GET',headers:{Host:'pay.example.com',...options.headers}},res=>{
        const parts:Buffer[]=[];res.on('data',chunk=>parts.push(chunk));res.on('end',()=>{const text=Buffer.concat(parts).toString();resolve({status:res.statusCode!,headers:res.headers,text,json:()=>JSON.parse(text)});});
      });req.on('error',reject);req.end(options.body);
    });
  }
  return {runtime,call,env};
}

describe('server runtime and local storage selection',()=>{
  it('serves healthy SQLite configuration and signed catalog without GitHub credentials or network requests',async()=>{
    const {call}=await listening();const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('network forbidden'));
    expect((await call('/api/health')).json()).toMatchObject({ready:true,acceptingPayments:true,storage:'sqlite-local'});
    expect((await call('/api/v1/catalog')).status).toBe(401);
    const path='/api/v1/catalog',timestamp=String(Math.floor(Date.now()/1000)),nonce='server_nonce_0123456789';
    const signed=await call(path,{headers:{'X-Brclio-Client':product.id,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Signature':hmacSha256(product.apiSecret,['GET',path,timestamp,nonce,sha256('')].join('\n'))}});
    expect(signed.status).toBe(200);expect(signed.json().providers).toEqual(['alipay','wechat']);expect(network).not.toHaveBeenCalled();
  });
  it('fails closed if SQLite is selected without its injected store even when GitHub is configured',()=>{
    const env=fixture();delete env.STORAGE;env.GITHUB_TOKEN='legacy-token';env.GITHUB_REPOSITORY='legacy/data';
    expect(configurationReady(env)).toBe(false);expect(()=>requireInfrastructureReady(env)).toThrow();
  });
  it('preserves provider signature rejection and rejects forged browser confirmation',async()=>{
    const {call,env}=await listening(),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('network forbidden'));
    const wechat=await call('/api/wechat/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    expect(wechat.status).toBe(401);expect(wechat.json().error.code).toBe('WECHAT_SIGNATURE_INVALID');
    const alipay=await call('/api/alipay/notify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'out_trade_no=pay_'+ '1'.repeat(32)+'&trade_status=TRADE_SUCCESS&sign=invalid'});
    expect(alipay.status).toBeGreaterThanOrEqual(400);expect(alipay.text).toBe('failure');
    const redirect=await call('/payment/return?out_trade_no=pay_'+ '1'.repeat(32)+'&trade_status=TRADE_SUCCESS');
    expect(redirect.status).toBe(303);expect((env.STORAGE as MemoryStore).data.size).toBe(0);expect(network).not.toHaveBeenCalled();
  });
  it('keeps administrator login, same-origin, CSRF and individual secret reveal checks through the HTTP bridge',async()=>{
    const {call,env}=await listening();
    expect((await call('/api/admin/environment/value',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"name":"CHECKOUT_SECRET"}'})).status).toBe(401);
    const login=await call('/api/admin/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email:env.ADMIN_EMAIL,password:'local-runtime-fixture'})});
    expect(login.status).toBe(200);expect(login.headers['set-cookie']?.[0]).toContain('HttpOnly; Secure; SameSite=Strict');
    const cookie=login.headers['set-cookie']![0].split(';')[0],csrf=login.json().csrfToken;
    const input={method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:'{"name":"CHECKOUT_SECRET"}'};
    expect((await call('/api/admin/environment/value',input)).status).toBe(403);
    expect((await call('/api/admin/environment/value',{...input,headers:{...input.headers,Origin:'https://evil.example.com','X-CSRF-Token':csrf}})).status).toBe(403);
    const revealed=await call('/api/admin/environment/value',{...input,headers:{...input.headers,'X-CSRF-Token':csrf}});
    expect(revealed.status).toBe(200);expect(revealed.json().value).toBe(env.CHECKOUT_SECRET);expect(revealed.headers['cache-control']).toBe('no-store');
    expect((await call('/api/admin/environment/value',{...input,headers:{...input.headers,'X-CSRF-Token':csrf},body:'{"name":"STORAGE"}'})).status).toBe(400);
  });
  it('rejects unknown hosts and replaces untrusted forwarding metadata with the loopback proxy client IP',async()=>{
    const {call}=await listening(fixture(),async request=>Response.json({url:request.url,ip:request.headers.get('CF-Connecting-IP'),forwarded:request.headers.get('X-Forwarded-For')}));
    expect((await call('/',{headers:{Host:'attacker.example.com','X-Forwarded-Host':'pay.example.com'}})).status).toBe(400);
    const response=await call('/test',{headers:{'X-Real-IP':'203.0.113.8','CF-Connecting-IP':'203.0.113.99','X-Forwarded-For':'203.0.113.99','X-Forwarded-Proto':'http'}});
    expect(response.json()).toEqual({url:base+'/test',ip:'203.0.113.8',forwarded:null});
    expect((await call('/test',{headers:{Host:'wechat.example.com'}})).json().url).toBe('https://wechat.example.com/test');
  });
  it('caps body size before calling the payment handler',async()=>{
    const handler=vi.fn(async()=>new Response('called'));const {call}=await listening(fixture(),handler);
    const response=await call('/api/admin/login',{method:'POST',headers:{'Content-Length':String(256*1024+1)},body:'x'.repeat(256*1024+1)});
    expect(response.status).toBe(413);expect(handler).not.toHaveBeenCalled();
  });
  it('drains an active handler after its client disconnects before closing storage',async()=>{
    let begin!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{begin=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const env=fixture();let committed=false;
    const {runtime}=await listening(env,async()=>{begin();await gate;await env.STORAGE!.transaction(async tx=>{tx.put('shutdown-fixture.json',{persisted:true});});committed=true;return new Response('saved');});
    const port=(runtime.server.address() as {port:number}).port;
    const request=httpRequest({host:'127.0.0.1',port,path:'/',headers:{Host:'pay.example.com'}});request.on('error',()=>{});request.end();
    await started;request.destroy();let closed=false;const close=runtime.close().then(()=>{closed=true;});
    await new Promise(resolve=>setTimeout(resolve,10));expect(closed).toBe(false);expect(committed).toBe(false);
    release();await close;expect(committed).toBe(true);expect(await env.STORAGE!.readJson('shutdown-fixture.json')).toEqual({persisted:true});
  });
  it('rate limits per client and permits a fresh window',async()=>{
    let now=1;const limiter=rateLimiter(2,60_000,()=>now);
    expect(await limiter.limit({key:'client'})).toEqual({success:true});expect(await limiter.limit({key:'client'})).toEqual({success:true});expect(await limiter.limit({key:'client'})).toEqual({success:false});
    expect(await limiter.limit({key:'different'})).toEqual({success:true});now+=60_000;expect(await limiter.limit({key:'client'})).toEqual({success:true});
  });
  it('serves release assets and refuses hidden files and symlinks outside the asset root',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'brclio-assets-'));cleanups.push(()=>rm(directory,{recursive:true,force:true}));
    await writeFile(join(directory,'index.html'),'<h1>Pay</h1>');await writeFile(join(directory,'.env'),'hidden');await symlink('/etc/hosts',join(directory,'leak.txt'));
    const assets=staticAssets(directory);
    expect(await (await assets.fetch(base+'/')).text()).toBe('<h1>Pay</h1>');
    expect((await assets.fetch(base+'/.env')).status).toBe(404);expect((await assets.fetch(base+'/leak.txt')).status).toBe(404);
    const head=await assets.fetch(new Request(base+'/',{method:'HEAD'}));expect(await head.text()).toBe('');expect(head.headers.get('Content-Type')).toContain('text/html');
  });
});
