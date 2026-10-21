import {describe,expect,it} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {URL as NodeURL} from 'node:url';
import {createHash,createHmac} from 'node:crypto';
import {SKILL_VARIANTS,skillMarkdown,skillZip,makeIntegrationPrompt} from '../src/skill';

describe('three portable payment Skills',()=>{
  it.each(SKILL_VARIANTS)('delivers a complete independent %s bundle and matching scoped task',async variant=>{
    const temporary=await mkdtemp(path.join(tmpdir(),'brclio-variant-'));
    try {
      const zip=path.join(temporary,'skill.zip');await writeFile(zip,skillZip(variant));
      execFileSync('unzip',['-t',zip],{stdio:'pipe'});
      execFileSync('unzip',['-q',zip,'-d',temporary],{stdio:'pipe'});
      const directory=path.join(temporary,variant);
      expect(await readFile(path.join(directory,'SKILL.md'),'utf8')).toBe(skillMarkdown(variant));
      for(const file of ['scripts/inspect-platform.mjs','scripts/integration-client.mjs','assets/payment-client.mjs','assets/webhook-handler.mjs','assets/payment-completion.mjs','references/integration.md'])expect((await readFile(path.join(directory,file),'utf8')).length).toBeGreaterThan(100);
      const token='brp_int_'+'d'.repeat(64);
      const prompt=makeIntegrationPrompt({variant,clientId:'product',mode:'create',baseUrl:'https://pay.bornforthis.cn',expiresAt:'2027-01-01T00:00:00Z',token});
      expect(prompt).toContain(skillMarkdown(variant));expect(prompt).toContain(`X-Brclio-Skill 请求头设置 ${variant}`);
      expect(new TextDecoder().decode(skillZip(variant))).not.toContain(token);
      const expected=variant==='brclio-alipay-integrate'?"providers: ['alipay']":variant==='brclio-wechatpay-integrate'?"providers: ['wechat']":"providers: ['alipay','wechat']";
      expect(skillMarkdown(variant)).toContain(expected);
    } finally {await rm(temporary,{recursive:true,force:true});}
  });
  it('signs the explicit provider and preserves an omitted provider for old products',async()=>{
    const {createPaymentClient}=await import(new NodeURL('../examples/payment-client.mjs',import.meta.url).href);
    const apiSecret='test-only-client-secret-'.repeat(3),calls:{body:string;headers:Headers}[]=[];
    const pay=createPaymentClient({clientId:'product',apiSecret,fetcher:async(_url:URL,init:RequestInit)=>{
      const body=String(init.body),headers=new Headers(init.headers);calls.push({body,headers});
      const canonical=['POST','/api/v1/orders',headers.get('X-Brclio-Timestamp'),headers.get('X-Brclio-Nonce'),createHash('sha256').update(body).digest('hex')].join('\n');
      expect(headers.get('X-Brclio-Signature')).toBe(createHmac('sha256',apiSecret).update(canonical).digest('hex'));
      return Response.json({id:'pay_'+'a'.repeat(32)});
    }});
    const common={productOrderId:'order-1',sku:'pro',returnUrl:'https://product.example/return'};
    await pay.createOrder(common);await pay.createOrder({...common,provider:'wechat'});
    expect(JSON.parse(calls[0].body)).not.toHaveProperty('provider');expect(JSON.parse(calls[1].body).provider).toBe('wechat');
    expect(()=>pay.createOrder({...common,provider:'unsupported'})).toThrow('Invalid payment provider');
  });
});
