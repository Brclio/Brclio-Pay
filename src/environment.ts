import {requireThat} from './config';
import {sha256} from './crypto';
import type {Env,Store} from './types';

export const ENVIRONMENT_GUIDE_PATH='maintenance/environment/guide.json';
const REPOSITORY='BrclioData/BrclioPay-Data';
const BINDING_NAMES=new Set(['ASSETS','ADMIN_LOGIN_LIMITER','INTEGRATION_LIMITER','PAYMENT_API_LIMITER']);
// The cached guide GET includes only reviewed, non-credential values. Editable
// documentation cannot expand this list; owner reveals use the separate POST.
const PUBLIC_VALUE_NAMES=new Set([
  'PAY_BASE_URL','PAYMENT_MODE','PAYMENT_ENABLED','ALIPAY_CHANNELS','ALIPAY_APP_ID','ALIPAY_SELLER_ID','ALIPAY_GATEWAY',
  'WECHAT_MCH_ID','WECHAT_APP_ID','WECHAT_SERIAL_NO','WECHAT_PUBLIC_KEY_ID','WECHAT_CHANNELS',
  'GITHUB_APP_ID','GITHUB_APP_INSTALLATION_ID','GITHUB_REPOSITORY','GITHUB_BRANCH','REGISTRY_STORAGE_MODE','LEGACY_WECHAT_BASE_URL',
]);
// The owner may explicitly reveal these deployed string bindings through the
// authenticated POST route. Editable guide entries cannot extend this scope.
const RUNTIME_VALUE_NAMES=new Set([...PUBLIC_VALUE_NAMES,
  'ALIPAY_PRIVATE_KEY','ALIPAY_PUBLIC_KEY','WECHAT_PRIVATE_KEY','WECHAT_API_V3_KEY','WECHAT_PUBLIC_KEYS_JSON',
  'GITHUB_TOKEN','GITHUB_APP_PRIVATE_KEY','CHECKOUT_SECRET','CLIENTS_JSON','REGISTRY_ENCRYPTION_KEY',
  'ADMIN_EMAIL','ADMIN_PASSWORD_HASH','ADMIN_PASSWORD_PEPPER','ADMIN_SESSION_SECRET','LEGACY_WECHAT_CHECKOUT_SECRET',
]);

/** Called only after owner session, same-origin and CSRF verification. No storage
 * access, enumeration, logging, or persistence of the returned runtime value. */
export function environmentValue(env:Env,input:unknown) {
  requireThat(record(input) && keys(input,['name']) && typeof input.name==='string' && RUNTIME_VALUE_NAMES.has(input.name),
    400,'INVALID_ENVIRONMENT_VARIABLE','请选择可查看的运行变量，资源绑定没有文本值');
  const runtime=env as unknown as Record<string,unknown>;
  const value=Object.hasOwn(runtime,input.name) && typeof runtime[input.name]==='string'?runtime[input.name] as string:null;
  return {name:input.name,configured:value!==null&&value.trim().length>0,value,retrievedAt:new Date().toISOString()};
}
export interface EnvironmentVariableGuide {
  name:string;label:string;description:string;required:boolean;sensitive:boolean;
  example:string;location:string;changeNotes:string;maintenance:string;
  generation?:string;scope?:string;
}
export interface EnvironmentGuide {
  schema:1;title:string;updatedAt:string;intro:string[];
  groups:{id:string;title:string;description:string;variables:EnvironmentVariableGuide[]}[];
  notes:string[];
}
const record=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);
const text=(value:unknown,max=8000):value is string=>typeof value==='string' && value.length<=max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const keys=(value:Record<string,unknown>,expected:string[])=>Object.keys(value).length===expected.length && expected.every(key=>Object.hasOwn(value,key));
const texts=(value:unknown):value is string[]=>Array.isArray(value) && value.length<=30 && value.every(item=>text(item,4000));

/** Only documentation belongs in the repository; never persist runtime values. */
export function validateEnvironmentGuide(value:unknown):EnvironmentGuide {
  const invalid=()=>requireThat(false,503,'ENVIRONMENT_GUIDE_INVALID','环境变量说明格式有误，请检查数据仓库中的说明文件');
  if(!record(value) || !keys(value,['schema','title','updatedAt','intro','groups','notes']) || value.schema!==1
    || !text(value.title,200) || !value.title.trim() || !text(value.updatedAt,40) || !Number.isFinite(Date.parse(value.updatedAt))
    || !texts(value.intro) || !texts(value.notes) || !Array.isArray(value.groups) || !value.groups.length || value.groups.length>20)invalid();
  const guide=value as unknown as EnvironmentGuide;
  const groupIds=new Set<string>(),names=new Set<string>();
  for(const group of guide.groups) {
    if(!record(group) || !keys(group,['id','title','description','variables']) || !text(group.id,60) || !/^[a-z][a-z0-9-]*$/.test(group.id)
      || groupIds.has(group.id) || !text(group.title,200) || !text(group.description) || !Array.isArray(group.variables)
      || !group.variables.length || group.variables.length>100)invalid();
    groupIds.add(group.id);
    for(const variable of group.variables) {
      if(!record(variable) || Object.keys(variable).some(key=>!['name','label','description','required','sensitive','example','location','changeNotes','maintenance','generation','scope'].includes(key))
        || !['name','label','description','required','sensitive','example','location','changeNotes','maintenance'].every(key=>Object.hasOwn(variable,key))
        || !text(variable.name,100) || !/^[A-Z][A-Z0-9_]*$/.test(variable.name) || names.has(variable.name)
        || typeof variable.required!=='boolean' || typeof variable.sensitive!=='boolean'
        || !['label','description','example','location','changeNotes','maintenance'].every(key=>text(variable[key],key==='label'?200:8000))
        || !['generation','scope'].every(key=>variable[key]===undefined || text(variable[key],8000)))invalid();
      names.add(variable.name);
    }
  }
  if(names.size>200 || new TextEncoder().encode(JSON.stringify(guide)).byteLength>200*1024)invalid();
  return guide;
}

export async function environmentGuide(env:Env,store:Store) {
  const stored=await store.readJson<unknown>(ENVIRONMENT_GUIDE_PATH);
  requireThat(stored!==null,503,'ENVIRONMENT_GUIDE_MISSING','环境变量说明尚未同步，请检查数据仓库中的说明文件');
  const document=validateEnvironmentGuide(stored);
  const runtime=env as unknown as Record<string,unknown>;
  const repository=env.GITHUB_REPOSITORY || REPOSITORY,branch=env.GITHUB_BRANCH || 'main';
  return {
    document,
    variables:document.groups.flatMap(group=>group.variables.map(variable=>{
      const value=Object.hasOwn(runtime,variable.name)?runtime[variable.name]:undefined;
      const binding=BINDING_NAMES.has(variable.name),publicValue=PUBLIC_VALUE_NAMES.has(variable.name);
      return {
        name:variable.name,configured:typeof value==='string'?value.trim().length>0:!!value,
        canReveal:RUNTIME_VALUE_NAMES.has(variable.name),
        storageType:binding?'binding' as const:'runtime' as const,
        disclosure:binding?'binding' as const:publicValue?'public' as const:'protected' as const,
        ...(publicValue && typeof value==='string'?{value}:{}),
      };
    })),
    source:{repository,path:ENVIRONMENT_GUIDE_PATH,
      url:`https://github.com/${repository}/blob/${encodeURIComponent(branch)}/${ENVIRONMENT_GUIDE_PATH}`,
      revision:sha256(JSON.stringify(document))},
    // Runtime bindings cannot distinguish dashboard Text from Secret storage.
    storageTypeBasis:'runtime-binding-only' as const,
  };
}
