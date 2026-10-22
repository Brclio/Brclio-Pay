import {afterEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {handleAdmin} from '../src/admin';
import {hmacSha256,sha256} from '../src/crypto';
import {environmentValue,validateEnvironmentGuide} from '../src/environment';
import type {Env,Store} from '../src/types';

// Synthetic deployment bindings only. No deployment or repository access.
const env={PAY_BASE_URL:'https://pay.example.com',PAYMENT_MODE:'live',ADMIN_EMAIL:'admin@example.com',
  ADMIN_PASSWORD_HASH:'pbkdf2-sha256$100000$'+'1'.repeat(64)+'$'+'2'.repeat(64),ADMIN_PASSWORD_PEPPER:'3'.repeat(64),ADMIN_SESSION_SECRET:'4'.repeat(64),
  CHECKOUT_SECRET:'ephemeral-checkout-secret',GITHUB_TOKEN:'ephemeral-repository-token',
  GITHUB_APP_PRIVATE_KEY:'-----BEGIN PRIVATE KEY-----\nsynthetic-only\n-----END PRIVATE KEY-----\n',
  ASSETS:{fetch:async()=>new Response()},ADMIN_LOGIN_LIMITER:{limit:async()=>({success:true})}} as unknown as Env;
const csrf='a'.repeat(64);
interface RequestOptions {
  path?:string;method?:string;authenticated?:boolean;body?:unknown;rawBody?:string;
  headers?:Record<string,string|null|undefined>;
}
function request({path='/api/admin/environment/value',method='POST',authenticated=true,body={name:'CHECKOUT_SECRET'},rawBody,headers:changes={}}:RequestOptions={}) {
  const seconds=Math.floor(Date.now()/1000),payload={sub:sha256(env.ADMIN_EMAIL!),iat:seconds,exp:seconds+8*3600,csrf,credential:sha256(env.ADMIN_PASSWORD_HASH!)};
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const headers=new Headers({'Content-Type':'application/json',Origin:env.PAY_BASE_URL,'X-CSRF-Token':csrf,
    ...(authenticated?{Cookie:'__Host-brclio_admin='+encoded+'.'+hmacSha256(env.ADMIN_SESSION_SECRET!,'admin-session-v1:'+encoded)}:{})});
  for(const [name,value] of Object.entries(changes))if(value===null)headers.delete(name);else if(value!==undefined)headers.set(name,value);
  return new Request(env.PAY_BASE_URL+path,{method,headers,...(['GET','HEAD'].includes(method)?{}:{body:rawBody??JSON.stringify(body)})});
}
function fixture(runtime:Env=env) {
  const readJson=vi.fn(async()=>{throw Error('Unexpected repository read');}),transaction=vi.fn(async()=>{throw Error('Unexpected repository write');});
  const storage={readJson,transaction} as unknown as Store,service=vi.fn(async()=>{throw Error('Unexpected gateway initialization');});
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unexpected outbound request'));
  return {call:(options:RequestOptions={})=>handleAdmin(request(options),runtime,storage,{service}),
    assertIsolated:()=>{expect(readJson).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();expect(service).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();}};
}
afterEach(()=>vi.restoreAllMocks());

describe('explicit owner environment value access',()=>{
  it('returns exactly one current deployed string after session, Origin and CSRF checks without repository or gateway access',async()=>{
    const f=fixture(),before=Date.now(),response=await f.call({body:{name:'GITHUB_APP_PRIVATE_KEY'}}),body=await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({name:'GITHUB_APP_PRIVATE_KEY',configured:true,value:env.GITHUB_APP_PRIVATE_KEY,retrievedAt:expect.any(String)});
    expect(Date.parse((body as {retrievedAt:string}).retrievedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse((body as {retrievedAt:string}).retrievedAt)).toBeLessThanOrEqual(Date.now());
    expect(JSON.stringify(body)).not.toContain(env.CHECKOUT_SECRET);expect(JSON.stringify(body)).not.toContain(env.GITHUB_TOKEN);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(response.headers.get('Pragma')).toBe('no-cache');expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(response.headers.get('Vary')).toBe('Cookie, Origin');
    f.assertIsolated();
  });
  it('reads the present binding on each request and preserves whitespace and multiline content exactly',async()=>{
    const runtime={...env},f=fixture(runtime);
    expect(await (await f.call()).json()).toMatchObject({value:'ephemeral-checkout-secret'});
    runtime.CHECKOUT_SECRET='  rotated synthetic binding\nwith another line\n';
    expect(await (await f.call()).json()).toMatchObject({configured:true,value:runtime.CHECKOUT_SECRET});f.assertIsolated();
  });
  it.each([
    {authenticated:false},
    {authenticated:false,headers:{Authorization:'Bearer ephemeral-repository-token'}},
    {authenticated:false,headers:{'X-Brclio-Token':'ephemeral-product-token'}},
  ])('requires an owner session even when other tokens are supplied: %j',async options=>{
    const f=fixture();await expect(f.call(options as RequestOptions)).rejects.toMatchObject({status:401});f.assertIsolated();
  });
  it.each([
    {'X-CSRF-Token':null},
    {'X-CSRF-Token':'0'.repeat(64)},
    {Origin:null},
    {Origin:'https://foreign.example'},
    {'Sec-Fetch-Site':'cross-site'},
    {'Sec-Fetch-Site':'none'},
  ])('requires same-origin CSRF protection before reading a value: %j',async headers=>{
    const f=fixture();await expect(f.call({headers})).rejects.toMatchObject({status:403});f.assertIsolated();
  });
  it.each(['GET','HEAD','PUT','DELETE'])('rejects %s access without exposing values',async method=>{
    const f=fixture();await expect(f.call({method})).rejects.toMatchObject({status:405});f.assertIsolated();
  });
  it('rejects query-based name selection',async()=>{
    const f=fixture();await expect(f.call({path:'/api/admin/environment/value?name=CHECKOUT_SECRET'})).rejects.toMatchObject({status:400});f.assertIsolated();
  });
  it.each([
    null,[],{},'CHECKOUT_SECRET',{name:123},{name:['CHECKOUT_SECRET']},
    {name:'CHECKOUT_SECRET',all:true},{names:['CHECKOUT_SECRET','GITHUB_TOKEN']},
    {name:'UNKNOWN_RUNTIME_BINDING'},{name:'__proto__'},{name:'constructor'},{name:'toString'},
    ...['ASSETS','ADMIN_LOGIN_LIMITER','INTEGRATION_LIMITER','PAYMENT_API_LIMITER'].map(name=>({name})),
  ])('rejects unreviewed names, resource bindings and bulk input: %j',async body=>{
    const f=fixture({...env,UNKNOWN_RUNTIME_BINDING:'synthetic-unknown'} as Env);
    await expect(f.call({body})).rejects.toMatchObject({status:400,code:'INVALID_ENVIRONMENT_VARIABLE'});f.assertIsolated();
  });
  it('enforces JSON and byte limits before revealing a value',async()=>{
    const f=fixture();
    await expect(f.call({headers:{'Content-Type':'text/plain'}})).rejects.toMatchObject({status:415});
    await expect(f.call({rawBody:'not JSON'})).rejects.toMatchObject({status:400,code:'INVALID_JSON'});
    await expect(f.call({rawBody:' '.repeat(257)+'{"name":"CHECKOUT_SECRET"}'})).rejects.toMatchObject({status:413});
    await expect(f.call({headers:{'Content-Length':'257'}})).rejects.toMatchObject({status:413});
    await expect(f.call({body:{name:'非'.repeat(100)}})).rejects.toMatchObject({status:413});f.assertIsolated();
  });
  it.each([undefined,null,123,true,{secret:'do not stringify'},['do not stringify']])('returns null for absent or non-string runtime values: %j',async value=>{
    const runtime={...env,WECHAT_API_V3_KEY:value} as unknown as Env,f=fixture(runtime);
    expect(await (await f.call({body:{name:'WECHAT_API_V3_KEY'}})).json()).toMatchObject({name:'WECHAT_API_V3_KEY',configured:false,value:null});f.assertIsolated();
  });
  it.each(['','  \n\t'])('preserves an empty string binding while reporting it as unconfigured: %j',async value=>{
    const f=fixture({...env,WECHAT_API_V3_KEY:value});
    expect(await (await f.call({body:{name:'WECHAT_API_V3_KEY'}})).json()).toMatchObject({configured:false,value});f.assertIsolated();
  });
  it('does not reveal inherited properties of an environment object',()=>{
    const runtime=Object.create({CHECKOUT_SECRET:'synthetic-inherited-value'}) as Env;
    expect(environmentValue(runtime,{name:'CHECKOUT_SECRET'})).toMatchObject({configured:false,value:null});
  });
  it('supports every reviewed runtime variable in the maintained deployment guide',()=>{
    const seed=validateEnvironmentGuide(JSON.parse(readFileSync('resources/environment-guide.json','utf8')));
    const bindings=new Set(['ASSETS','ADMIN_LOGIN_LIMITER','INTEGRATION_LIMITER','PAYMENT_API_LIMITER']);
    const names=seed.groups.flatMap(group=>group.variables.map(variable=>variable.name)).filter(name=>!bindings.has(name));
    expect(names).toHaveLength(33);
    for(const name of names){
      const value=`synthetic-runtime:${name}\n`;
      expect(environmentValue({[name]:value} as unknown as Env,{name})).toMatchObject({name,configured:true,value});
    }
  });
});
