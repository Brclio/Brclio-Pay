import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const source=()=>import(new URL('../scripts/sync-environment-guide.mjs',import.meta.url).href);
const seed=()=>JSON.parse(readFileSync('resources/environment-guide.json','utf8'));

describe('reviewed environment guide updates',()=>{
  it('can review an older schema-1 guide without overwriting it or relaxing the new catalog',async()=>{
    const {synchronizeEnvironmentGuide,validateEnvironmentGuide}=await source();
    const current=seed(),previous=seed();
    previous.updatedAt='2026-10-21T00:00:00.000Z';
    for(const group of previous.groups){
      group.variables=group.variables.filter((item:{name:string})=>!['GITHUB_TOKEN','REGISTRY_ENCRYPTION_KEY'].includes(item.name));
      for(const variable of group.variables){delete variable.generation;delete variable.scope;}
    }
    expect(()=>validateEnvironmentGuide(previous)).toThrow('ENVIRONMENT_GUIDE_VARIABLES_INCOMPLETE');
    const github={snapshot:vi.fn(async()=>({revision:'a'.repeat(40),tree:'b'.repeat(40),files:[{path:'maintenance/environment/guide.json',sha:'c'.repeat(40)}]})),
      bytes:vi.fn(async()=>Buffer.from(JSON.stringify(previous))),request:vi.fn()};
    const result=await synchronizeEnvironmentGuide(github,current);
    expect(result).toMatchObject({operation:'update',variableCount:37,applied:false});
    expect(github.request).not.toHaveBeenCalled();
    await expect(synchronizeEnvironmentGuide(github,current,{apply:true,expectedHead:'d'.repeat(40),expectedDigest:result.documentDigest}))
      .rejects.toThrow('EXPECTED_HEAD_MISMATCH_NO_WRITE');
    expect(github.request).not.toHaveBeenCalled();
  });
});
