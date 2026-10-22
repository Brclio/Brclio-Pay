import {describe,expect,it} from 'vitest';
const source=()=>import(new URL('../scripts/deploy-worker.mjs',import.meta.url).href);

describe('daily deployment preserves dashboard configuration',()=>{
  it('omits even public defaults while retaining code, assets, infrastructure and keep_vars',async()=>{
    const {deploymentConfig}=await source();
    const original={name:'brclio-pay-unified',account_id:'a'.repeat(32),main:'src/index.ts',
      vars:{PAYMENT_ENABLED:'true',CHECKOUT_SECRET:'must-not-be-in-a-daily-deployment'},keep_vars:false,
      assets:{directory:'./public',binding:'ASSETS'},alias:{'node:util':'./src/safe-node-util.ts'},
      ratelimits:[{name:'ADMIN_LOGIN_LIMITER'}],triggers:{crons:['* * * * *']}};
    const config=deploymentConfig(original,'/fixture');
    expect(config.vars).toEqual({});expect(config.keep_vars).toBe(true);expect(JSON.stringify(config)).not.toContain(original.vars.CHECKOUT_SECRET);
    expect(config).toMatchObject({main:'/fixture/src/index.ts',assets:{directory:'/fixture/public',binding:'ASSETS'},
      alias:{'node:util':'/fixture/src/safe-node-util.ts'},ratelimits:original.ratelimits,triggers:original.triggers});
    expect(original.vars.PAYMENT_ENABLED).toBe('true');expect(original.keep_vars).toBe(false);
  });
  it('rejects invalid deployment targets before spawning Wrangler',async()=>{
    const {deploymentConfig}=await source();
    expect(()=>deploymentConfig({name:'unrelated;command',account_id:'x',main:'index.ts',assets:{directory:'public'}})).toThrow();
  });
  it('selects an independent installation configuration without forwarding runtime arguments',async()=>{
    const {deploymentArguments,deploymentConfig}=await source();
    expect(deploymentArguments([])).toEqual({config:'wrangler.jsonc',dryRun:false});
    expect(deploymentArguments(['--config','secrets/setup-generated/wrangler.json','--dry-run'])).toEqual({config:'secrets/setup-generated/wrangler.json',dryRun:true});
    expect(()=>deploymentArguments(['--config'])).toThrow();
    expect(()=>deploymentArguments(['--var','PAYMENT_ENABLED:true'])).toThrow();
    const config=deploymentConfig({name:'my-independent-pay',account_id:'b'.repeat(32),main:'/fixture/src/index.ts',assets:{directory:'/fixture/public'},
      vars:{PAYMENT_ENABLED:'false',WECHAT_CHANNELS:'native'}});
    expect(config.name).toBe('my-independent-pay');expect(config.account_id).toBe('b'.repeat(32));expect(config.vars).toEqual({});
  });
});
