import {describe,it,expect} from 'vitest';
import {PartitionedStore} from '../src/partitioned-store';
import {Registry} from '../src/registry';
import {sha256} from '../src/crypto';
import type {Store,Transaction,Env} from '../src/types';
class Memory implements Store {
  files=new Map<string,unknown>();
  async readJson<T>(path:string):Promise<T|null>{return structuredClone((this.files.get(path)??null) as T|null);}
  async transaction<T>(fn:(tx:Transaction)=>Promise<T>):Promise<T>{
    const pending=new Map(this.files);
    const result=await fn({read:async<V>(p:string)=>structuredClone((pending.get(p)??null) as V|null),put:(p,v)=>{pending.set(p,structuredClone(v));}});
    this.files=pending;return result;
  }
  async openSnapshot(){const files=new Map(this.files);return {revision:'revision',listJsonPaths:(p:string)=>[...files.keys()].filter(k=>k.startsWith(p)),readJson:async<T>(p:string)=>structuredClone((files.get(p)??null) as T|null)};}
}
describe('dated plaintext storage',()=>{
  it('atomically stores Shanghai month boundary order/event and locators and can reopen snapshot',async()=>{
    const memory=new Memory(),store=new PartitionedStore(memory),id='pay_'+'a'.repeat(32),eid='evt_'+id;
    await store.transaction(async tx=>{tx.put(`orders/${id}.json`,{id,createdAt:'2026-10-31T17:00:00Z',amount:'1.00'});tx.put(`events/${eid}.json`,{event:{id:eid,createdAt:'2026-10-31T17:00:00Z'}});});
    expect(memory.files.has(`orders/2026/11/${id}.json`)).toBe(true);
    expect(await memory.readJson(`order-locations/${sha256(id).slice(0,2)}/${id}.json`)).toEqual({schema:1,path:`orders/2026/11/${id}.json`});
    expect((await store.readJson<{amount:string}>(`orders/${id}.json`))?.amount).toBe('1.00');
    const snapshot=await store.openSnapshot();expect(snapshot.listJsonPaths('orders/')).toEqual([`orders/${id}.json`]);
    expect(await snapshot.readJson(`orders/${id}.json`)).toEqual(await store.readJson(`orders/${id}.json`));
    expect(memory.files.has(`events/2026/11/${eid}.json`)).toBe(true);
  });
  it('does not commit orphan locator or event on transaction failure',async()=>{
    const memory=new Memory(),store=new PartitionedStore(memory),id='pay_'+'a'.repeat(32);
    await expect(store.transaction(async tx=>{tx.put(`orders/${id}.json`,{id,createdAt:'2026-10-01T00:00:00Z'});throw Error('failed');})).rejects.toThrow('failed');
    expect(memory.files.size).toBe(0);
  });
  it('persists independent plaintext client and authorization records without registry encryption key',async()=>{
    const memory=new Memory(),registry=new Registry({REGISTRY_STORAGE_MODE:'plain',CLIENTS_JSON:'[]',PAY_BASE_URL:'https://pay.bornforthis.cn',PAYMENT_MODE:'live'} as Env,memory);
    const view=await registry.upsertClient({id:'test-client',name:'test',webhookUrl:'https://test.example.com/hooks/pay',returnOrigins:['https://test.example.com'],providers:['alipay','wechat'],skus:{annual:{amount:'3.00',subject:'annual'}}},'absent','operator');
    const saved=await registry.get('test-client');expect(saved?.providers).toEqual(['alipay','wechat']);
    expect(memory.files.has('registry/clients/test-client.json')).toBe(true);
    expect(memory.files.has('system/clients.enc.json')).toBe(false);
    const grant=await registry.createGrant({clientId:'test-client',mode:'update',allowedOrigins:['https://test.example.com']},'operator');
    expect((await registry.grantContext(grant.token)).client?.version).toBe(view.version);
    expect(memory.files.has(`registry/grants/${grant.id}.json`)).toBe(true);
    expect([...memory.files.keys()].some(p=>p.startsWith('registry/audit/2026/'))).toBe(true);
  });
});
