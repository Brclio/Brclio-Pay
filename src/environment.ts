import {requireThat} from './config';
import {sha256} from './crypto';
import type {Env,Store} from './types';

export const ENVIRONMENT_GUIDE_PATH='maintenance/environment/guide.json';
const REPOSITORY='BrclioData/BrclioPay-Data';
const BINDING_NAMES=new Set(['ASSETS','ADMIN_LOGIN_LIMITER','INTEGRATION_LIMITER','PAYMENT_API_LIMITER']);
export interface EnvironmentVariableGuide {
  name:string;label:string;description:string;required:boolean;sensitive:boolean;
  example:string;location:string;changeNotes:string;maintenance:string;
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

/** Only documentation belongs here; values are never read into the response. */
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
      if(!record(variable) || !keys(variable,['name','label','description','required','sensitive','example','location','changeNotes','maintenance'])
        || !text(variable.name,100) || !/^[A-Z][A-Z0-9_]*$/.test(variable.name) || names.has(variable.name)
        || typeof variable.required!=='boolean' || typeof variable.sensitive!=='boolean'
        || !['label','description','example','location','changeNotes','maintenance'].every(key=>text(variable[key],key==='label'?200:8000)))invalid();
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
  return {
    document,
    variables:document.groups.flatMap(group=>group.variables.map(variable=>({
      name:variable.name,
      configured:typeof (env as unknown as Record<string,unknown>)[variable.name]==='string'
        ? ((env as unknown as Record<string,string>)[variable.name]).trim().length>0
        : !!(env as unknown as Record<string,unknown>)[variable.name],
      storageType:BINDING_NAMES.has(variable.name)?'binding' as const:'Text' as const,
    }))),
    source:{repository:REPOSITORY,path:ENVIRONMENT_GUIDE_PATH,
      url:`https://github.com/${REPOSITORY}/blob/main/${ENVIRONMENT_GUIDE_PATH}`,
      revision:sha256(JSON.stringify(document))},
    // Runtime bindings do not disclose the Cloudflare storage type. This is the
    // documented maintenance policy, separately checked by the release audit.
    storageTypeBasis:'maintenance-convention' as const,
  };
}
