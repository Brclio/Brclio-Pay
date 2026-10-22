import {describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deploymentSkillMarkdown,deploymentSkillZip,isSkillVariant,makeIntegrationPrompt,type SkillVariant} from '../src/skill';
import {handle} from '../src/index';
import type {Env} from '../src/types';

describe('independent deployment Skill delivery',()=>{
  it('extracts a reproducible complete package with resolvable bundled references',async()=>{
    const temporary=await mkdtemp(path.join(tmpdir(),'brclio-deploy-skill-'));
    try{
      const archive=path.join(temporary,'deployment.zip'),bytes=deploymentSkillZip();
      expect(bytes).toEqual(deploymentSkillZip());
      await writeFile(archive,bytes);execFileSync('unzip',['-t',archive],{stdio:'pipe'});execFileSync('unzip',['-q',archive,'-d',temporary],{stdio:'pipe'});
      const base=path.join(temporary,'brclio-pay-deploy');
      expect(await readFile(path.join(base,'SKILL.md'),'utf8')).toBe(deploymentSkillMarkdown());
      for(const file of ['SKILL.md','references/deployment.md','references/environment-variables.md','references/merchant-setup.md']){
        const source=await readFile(path.join(base,file),'utf8');
        for(const match of source.matchAll(/\]\(([^)]+)\)/g)){
          const target=match[1].split('#')[0];
          if(!target||target.includes('://'))continue;
          const resolved=path.resolve(path.dirname(path.join(base,file)),target);
          expect(resolved.startsWith(base+path.sep)).toBe(true);
          expect((await stat(resolved)).isFile()).toBe(true);
        }
      }
      for(const [name,mode] of [['setup-input.example.json','dual'],['setup-alipay.example.json','alipay'],['setup-wechat.example.json','wechat']]){
        expect(JSON.parse(await readFile(path.join(base,'references',name),'utf8')).providerMode).toBe(mode);
      }
    }finally{await rm(temporary,{recursive:true,force:true});}
  });

  it('serves public GET and HEAD without touching data or including task grants',async()=>{
    const fetcher=vi.fn(async()=>{throw Error('Data access not expected');}),env={PAY_BASE_URL:'https://pay.example.com',ASSETS:{fetch:fetcher}} as unknown as Env;
    const context={waitUntil:vi.fn()} as unknown as ExecutionContext;
    for(const method of ['GET','HEAD']){
      const response=await handle(new Request('https://pay.example.com/api/skills/brclio-pay-deploy.zip',{method}),env,context);
      expect(response.status).toBe(200);expect(response.headers.get('Content-Type')).toBe('application/zip');
      expect(response.headers.get('Content-Disposition')).toContain('brclio-pay-deploy.zip');
      const bytes=new Uint8Array(await response.arrayBuffer());expect(bytes).toEqual(method==='HEAD'?new Uint8Array():deploymentSkillZip());
    }
    const markdown=await handle(new Request('https://pay.example.com/api/skills/brclio-pay-deploy/SKILL.md'),env,context);
    expect(await markdown.text()).toBe(deploymentSkillMarkdown());expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not admit infrastructure deployment into product integration grants',()=>{
    expect(isSkillVariant('brclio-pay-deploy')).toBe(false);
    expect(()=>makeIntegrationPrompt({variant:'brclio-pay-deploy' as SkillVariant,clientId:'test-product',mode:'create',token:'brp_int_'+'x'.repeat(64),expiresAt:'2027-01-01T00:00:00Z',baseUrl:'https://pay.example.com'})).toThrow('Invalid scoped integration context');
  });
});
