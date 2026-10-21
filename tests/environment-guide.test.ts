import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {handleAdmin} from '../src/admin';
import {environmentGuide,ENVIRONMENT_GUIDE_PATH,validateEnvironmentGuide,type EnvironmentGuide} from '../src/environment';
import {hmacSha256,sha256} from '../src/crypto';
import type {Env,Store} from '../src/types';

const variable={name:'CHECKOUT_SECRET',label:'收银台签名',description:'服务端签名材料',required:true,sensitive:true,
  example:'<随机生成的签名密钥>',location:'Cloudflare 后台',changeNotes:'变更前确认链接期限',maintenance:'填写 Text'};
function guide():EnvironmentGuide {
  return {schema:1,title:'环境变量说明',updatedAt:'2026-10-21T12:00:00.000Z',intro:['维护说明'],
    groups:[{id:'checkout',title:'收银台',description:'独立签名',variables:[variable,{...variable,name:'ALIPAY_GATEWAY',required:false}]},
      {id:'bindings',title:'资源绑定',description:'不是文本变量',variables:[{...variable,name:'ASSETS',sensitive:false}]}],notes:['说明文件仅含名称和用法']};
}
const env={PAY_BASE_URL:'https://pay.example.com',PAYMENT_MODE:'live',ADMIN_EMAIL:'admin@example.com',
  ADMIN_PASSWORD_HASH:'pbkdf2-sha256$100000$'+'1'.repeat(64)+'$'+'2'.repeat(64),ADMIN_PASSWORD_PEPPER:'3'.repeat(64),ADMIN_SESSION_SECRET:'4'.repeat(64),
  CHECKOUT_SECRET:'actual-checkout-value-must-never-appear',ALIPAY_GATEWAY:'  ',ASSETS:{fetch:async()=>new Response()}} as unknown as Env;
const csrf='a'.repeat(64);
function request(path='/api/admin/environment',authenticated=true,method='GET') {
  const seconds=Math.floor(Date.now()/1000),payload={sub:sha256(env.ADMIN_EMAIL!),iat:seconds,exp:seconds+8*3600,csrf,credential:sha256(env.ADMIN_PASSWORD_HASH!)};
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return new Request(env.PAY_BASE_URL+path,{method,headers:authenticated?{
    Cookie:'__Host-brclio_admin='+encoded+'.'+hmacSha256(env.ADMIN_SESSION_SECRET!,'admin-session-v1:'+encoded),Origin:env.PAY_BASE_URL,'X-CSRF-Token':csrf}:undefined});
}
function store(value:unknown=guide()) {
  return {readJson:vi.fn(async()=>structuredClone(value)),transaction:vi.fn(async()=>{throw Error('Unexpected write');})} as unknown as Store;
}
describe('administrator environment guide',()=>{
  it('authenticates before accessing the private guide or any gateway',async()=>{
    const storage=store(),service=vi.fn();await expect(handleAdmin(request(undefined,false),env,storage,{service})).rejects.toMatchObject({status:401});
    expect(storage.readJson).not.toHaveBeenCalled();expect(storage.transaction).not.toHaveBeenCalled();expect(service).not.toHaveBeenCalled();
  });
  it('returns private-repository documentation and presence only without reading actual values into the response',async()=>{
    const storage=store(),response=await handleAdmin(request(),env,storage),body=await response.text(),data=JSON.parse(body);
    expect(response.status).toBe(200);expect(data.document).toEqual(guide());
    expect(data.variables).toEqual([{name:'CHECKOUT_SECRET',configured:true,storageType:'Text'},
      {name:'ALIPAY_GATEWAY',configured:false,storageType:'Text'},{name:'ASSETS',configured:true,storageType:'binding'}]);
    expect(data.source).toMatchObject({repository:'BrclioData/BrclioPay-Data',path:ENVIRONMENT_GUIDE_PATH,revision:sha256(JSON.stringify(guide()))});
    expect(data.storageTypeBasis).toBe('maintenance-convention');
    for(const secret of [env.CHECKOUT_SECRET,env.ADMIN_SESSION_SECRET!,env.ADMIN_PASSWORD_PEPPER!,env.ADMIN_PASSWORD_HASH!])expect(body).not.toContain(secret);
    expect(storage.readJson).toHaveBeenCalledWith(ENVIRONMENT_GUIDE_PATH);expect(storage.transaction).not.toHaveBeenCalled();
  });
  it('observes an edited guide from storage without a code deployment or static fallback',async()=>{
    const storage=store(),first=await environmentGuide(env,storage),next={...guide(),title:'更新后的说明'};
    vi.mocked(storage.readJson).mockResolvedValue(next);const second=await environmentGuide(env,storage);
    expect(second.document.title).toBe(next.title);expect(second.source.revision).not.toBe(first.source.revision);
  });
  it('fails explicitly when the repository file is missing or malformed',async()=>{
    await expect(environmentGuide(env,store(null))).rejects.toMatchObject({status:503,code:'ENVIRONMENT_GUIDE_MISSING'});
    for(const bad of [{...guide(),schema:2},{...guide(),groups:[]},{...guide(),value:'accidental-variable-value'},
      {...guide(),groups:[{...guide().groups[0],variables:[{...variable,value:'accidental-variable-value'}]}]},
      {...guide(),groups:[{...guide().groups[0],variables:[variable,variable]}]}]) {
      await expect(environmentGuide(env,store(bad))).rejects.toMatchObject({status:503,code:'ENVIRONMENT_GUIDE_INVALID'});
    }
  });
  it('enforces read-only method and query boundaries without touching storage',async()=>{
    const storage=store();await expect(handleAdmin(request('/api/admin/environment?name=CHECKOUT_SECRET'),env,storage)).rejects.toMatchObject({status:400});
    await expect(handleAdmin(request('/api/admin/environment',true,'POST'),env,storage)).rejects.toMatchObject({status:405});
    expect(storage.readJson).not.toHaveBeenCalled();expect(storage.transaction).not.toHaveBeenCalled();
  });
  it('accepts the maintained seed and identifies actual resource bindings without labelling them Text',async()=>{
    const seed=validateEnvironmentGuide(JSON.parse(readFileSync('resources/environment-guide.json','utf8')));
    const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
    const names=seed.groups.flatMap(group=>group.variables.map(item=>item.name));
    for(const name of [...Object.keys(config.vars),...config.ratelimits.map((item:{name:string})=>item.name),config.assets.binding])expect(names).toContain(name);
    const result=await environmentGuide(env,store(seed));
    expect(result.variables.filter(item=>item.storageType==='binding').map(item=>item.name).sort())
      .toEqual(['ASSETS','ADMIN_LOGIN_LIMITER','INTEGRATION_LIMITER','PAYMENT_API_LIMITER'].sort());
    expect(result.variables.filter(item=>item.storageType==='Text')).toHaveLength(31);
  });
});
