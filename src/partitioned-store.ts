import {sha256} from './crypto';
import {requireThat} from './config';
import type {Store,Transaction,StoreSnapshot} from './types';

const location=(kind:string,id:string)=>`${kind==='orders'?'order':'event'}-locations/${sha256(id).slice(0,2)}/${id}.json`;
function category(path:string):{kind:string;id:string}|null {
  const match=/^(orders|events)\/((?:evt_)?pay_[a-f0-9]{32})\.json$/.exec(path);
  return match?{kind:match[1],id:match[2]}:null;
}
function fixed(path:string):string {
  return path.replace(/^indexes\/([^/]+)\/([a-f0-9]{64})\.json$/,(_,client,hash)=>`indexes/${client}/${hash.slice(0,2)}/${hash}.json`)
    .replace(/^payment-attempts\/(pay_[a-f0-9]{32})\.json$/,(_,id)=>`payment-attempts/${sha256(id).slice(0,2)}/${id}.json`);
}
export function datedPath(kind:string,id:string,createdAt:string):string {
  const time=Date.parse(createdAt);
  requireThat(Number.isFinite(time),503,'STORAGE_INTEGRITY','记录创建时间无效');
  const month=new Date(time+8*3600_000).toISOString().slice(0,7).replace('-','/');
  return `${kind}/${month}/${id}.json`;
}
/** Logical paths preserve the existing payment contract; physical records are independent and dated. */
export class PartitionedStore implements Store {
  constructor(public readonly underlying:Store){}
  private async resolve<T>(path:string,read:<V>(path:string)=>Promise<V|null>):Promise<T|null>{
    const item=category(path);
    if(!item)return read<T>(fixed(path));
    const pointer=await read<{schema:number;path:string}>(location(item.kind,item.id));
    if(!pointer)return null;
    requireThat(pointer.schema===1&&new RegExp(`^${item.kind}/[0-9]{4}/[0-9]{2}/${item.id}\\.json$`).test(pointer.path),503,'STORAGE_INTEGRITY','记录索引无效');
    const record=await read<T>(pointer.path);
    requireThat(record!==null,503,'STORAGE_INTEGRITY','记录索引指向缺失文件');
    return record;
  }
  readJson<T>(path:string):Promise<T|null>{return this.resolve<T>(path,p=>this.underlying.readJson(p));}
  transaction<T>(callback:(tx:Transaction)=>Promise<T>):Promise<T>{
    return this.underlying.transaction(async physical=>callback({
      read:<V>(path:string)=>this.resolve<V>(path,p=>physical.read(p)),
      put:(path,value)=>{
        const item=category(path);
        if(!item){physical.put(fixed(path),value);return;}
        const data=value as {id?:string;createdAt?:string;event?:{id:string;createdAt:string}};
        const record=item.kind==='events'?data.event:data;
        requireThat(record?.id===item.id&&typeof record.createdAt==='string',503,'STORAGE_INTEGRITY','记录与索引不一致');
        const target=datedPath(item.kind,item.id,record.createdAt);
        physical.put(target,value);physical.put(location(item.kind,item.id),{schema:1,path:target});
      }
    }));
  }
  async openSnapshot():Promise<StoreSnapshot>{
    requireThat(this.underlying.openSnapshot,503,'SNAPSHOT_UNAVAILABLE','账本快照不可用');
    const snapshot=await this.underlying.openSnapshot();
    return {revision:snapshot.revision,
      listJsonPaths:prefix=>snapshot.listJsonPaths(prefix).map(path=>path.replace(/^(orders|events)\/[0-9]{4}\/[0-9]{2}\//,'$1/')),
      readJson:<T>(path:string)=>this.resolve<T>(path,p=>snapshot.readJson(p))};
  }
}
