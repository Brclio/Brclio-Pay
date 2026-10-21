import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {convertV4MiniflareOptions,Log,LogLevel,Miniflare} from 'miniflare';
import {unstable_generateASSETSBinding} from 'wrangler';
import {handle} from '../src/index';
import type {Payments} from '../src/payments';
import type {Env} from '../src/types';

const root=fileURLToPath(new URL('../',import.meta.url).href);
const publicDirectory=path.join(root,'public'),pagesDirectory=path.join(root,'dist-pages');
const assets=['/styles.css','/admin.css','/admin.js','/checkout.js','/landing.js'];
const config=JSON.parse(readFileSync(path.join(root,'wrangler.jsonc'),'utf8'));
const routes=JSON.parse(readFileSync(path.join(root,'cloudflare/pages/_routes.json'),'utf8'));
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const workerCalls:string[]=[],pagesCalls:string[]=[];
let workerRuntime:Miniflare,pagesRuntime:Miniflare;
let expectedHeaders:Record<string,string>;
const quiet={debug(){},debugWithSanitization(){},info(){},log(){},warn(){},error(){}} as unknown as Parameters<typeof unstable_generateASSETSBinding>[0]['log'];
const assetWatchers=new AbortController();
// Real Pages static serving, including its _headers parser, without any network.
let workerAssets:ReturnType<typeof unstable_generateASSETSBinding>;
const fixtureEnv={PAY_BASE_URL:'https://pay.example.test',PAYMENT_MODE:'live',PAYMENT_ENABLED:'true',
  CHECKOUT_SECRET:'isolated-static-routing-checkout-'.repeat(2),ADMIN_SESSION_SECRET:'a'.repeat(64),
  ADMIN_EMAIL:'routing@example.test',ADMIN_PASSWORD_PEPPER:'b'.repeat(64),ADMIN_PASSWORD_HASH:'pbkdf2-sha256$100000$'+'c'.repeat(64)+'$'+'d'.repeat(64),
  INTEGRATION_LIMITER:{limit:async()=>({success:true})},
  ASSETS:{fetch:(request:Request)=>workerAssets(request as unknown as Parameters<typeof workerAssets>[0])}} as unknown as Env;
const ctx={waitUntil(){}} as unknown as ExecutionContext;

async function backend(request:Request):Promise<Response> {
  // The selected paths never require configured merchant keys or remote storage.
  // Anonymous gates must run before constructing a payment/GitHub service.
  return handle(request,fixtureEnv,ctx,{store:{readJson(){throw new Error('Anonymous routing must not read storage');},transaction(){throw new Error('Anonymous routing must not write storage');}}} as unknown as Payments);
}
function checkHeaders(response:Response) {
  for(const [name,value] of Object.entries(expectedHeaders))expect(response.headers.get(name),name).toBe(value);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.has('set-cookie')).toBe(false);
}

beforeAll(async()=>{
  // A stale build must not retain assets that have been removed from public/.
  execFileSync(process.execPath,['scripts/build-pages.mjs'],{cwd:root,stdio:'pipe'});
  writeFileSync(path.join(pagesDirectory,'obsolete-static-fixture.js'),'stale');
  execFileSync(process.execPath,['scripts/build-pages.mjs'],{cwd:root,stdio:'pipe'});
  workerAssets=await unstable_generateASSETSBinding({directory:publicDirectory,log:quiet,signal:assetWatchers.signal});
  const secured=await backend(new Request('https://pay.example.test/api/v1/orders'));
  expectedHeaders=Object.fromEntries(['x-content-type-options','referrer-policy','cache-control','content-security-policy','permissions-policy','strict-transport-security'].map(name=>[name,secured.headers.get(name)!]));
  workerRuntime=new Miniflare(convertV4MiniflareOptions({modules:true,
    script:'export default {fetch(request,env){return env.BACKEND.fetch(request)}}',
    compatibilityDate:'2026-10-13',log:new Log(LogLevel.NONE),
    serviceBindings:{BACKEND:async request=>{workerCalls.push(new URL(request.url).pathname);return backend(new Request(request.url,{method:request.method,headers:request.headers}));}},
    assets:{directory:publicDirectory,binding:'ASSETS',run_worker_first:config.assets.run_worker_first,routerConfig:{has_user_worker:true}},
  }));
  // Use Wrangler's actual advanced-mode local routing pipeline rather than
  // duplicating _routes.json matching logic in the test.
  const require=createRequire(import.meta.url);
  const wranglerRoot=path.resolve(path.dirname(require.resolve('wrangler')),'..');
  const pipeline=await build({entryPoints:[path.join(wranglerRoot,'templates/pages-dev-pipeline.ts')],
    bundle:true,write:false,format:'esm',platform:'neutral',logLevel:'silent',
    alias:{__ENTRY_POINT__:path.join(pagesDirectory,'_worker.js')},define:{__ROUTES__:JSON.stringify(routes)},
  });
  const pagesAssets=await unstable_generateASSETSBinding({directory:pagesDirectory,log:quiet,signal:assetWatchers.signal});
  pagesRuntime=new Miniflare(convertV4MiniflareOptions({modules:true,script:pipeline.outputFiles[0].text,
    compatibilityDate:'2026-10-13',log:new Log(LogLevel.NONE),
    serviceBindings:{ASSETS:request=>pagesAssets(request),PAYMENT_BACKEND:async request=>{pagesCalls.push(new URL(request.url).pathname);return backend(new Request(request.url,{method:request.method,headers:request.headers}));}},
  }));
},20_000);
afterAll(async()=>{assetWatchers.abort();await Promise.all([workerRuntime?.dispose(),pagesRuntime?.dispose()]);});

describe('exact public static routing',()=>{
  it('bypasses only the five existing public CSS/JS files in both entry points and copies a fresh identical Pages build',()=>{
    expect(config.assets.run_worker_first).toEqual(['/*',...assets.map(asset=>'!'+asset)]);
    expect(routes).toEqual({version:1,include:['/*'],exclude:assets});
    expect(JSON.parse(readFileSync(path.join(pagesDirectory,'_routes.json'),'utf8'))).toEqual(routes);
    expect(readFileSync(path.join(pagesDirectory,'_headers'),'utf8')).toBe(readFileSync(path.join(publicDirectory,'_headers'),'utf8'));
    expect(existsSync(path.join(pagesDirectory,'obsolete-static-fixture.js'))).toBe(false);
    for(const asset of assets){
      expect(existsSync(path.join(publicDirectory,asset)),asset).toBe(true);
      expect(digest(readFileSync(path.join(publicDirectory,asset)))).toBe(digest(readFileSync(path.join(pagesDirectory,asset))));
    }
    expect(config.assets.not_found_handling).toBeUndefined();
  });

  it.each(['Worker','Pages'])('%s directly serves GET/HEAD assets with unchanged bytes and all original no-store/security headers',async entry=>{
    const runtime=entry==='Worker'?workerRuntime:pagesRuntime,calls=entry==='Worker'?workerCalls:pagesCalls;
    const count=calls.length;
    for(const asset of assets){
      for(const method of ['GET','HEAD']){
        const response=await runtime.dispatchFetch('https://pay.example.test'+asset+'?asset-version=fixture',{method});
        expect(response.status).toBe(200);checkHeaders(response as unknown as Response);
        if(method==='GET')expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(digest(readFileSync(path.join(publicDirectory,asset))));
        else expect(await response.text()).toBe('');
      }
    }
    expect(calls.length).toBe(count);
  });

  it.each(['Worker','Pages'])('%s keeps HTML, API, checkout, return, docs, brand and Skill paths behind the payment Worker',async entry=>{
    const runtime=entry==='Worker'?workerRuntime:pagesRuntime,calls=entry==='Worker'?workerCalls:pagesCalls;
    const id='pay_'+'1'.repeat(32);
    const paths=['/','/index.html','/admin','/admin.html','/checkout/'+id,'/checkout.html',
      '/api/v1/catalog','/api/v1/orders','/api/checkout/'+id,'/api/admin/session','/api/admin/skill.zip',
      '/api/integration/v1/skill.zip','/skills/brclio-pay-integrate.zip','/docs/integration.md',
      '/brand/brclio-pay-icon.png','/checkout.js.bak','/styles.css.map','/api/admin.js'];
    for(const pathname of paths){
      const count=calls.length;
      const response=await runtime.dispatchFetch('https://pay.example.test'+pathname,{redirect:'manual'});
      expect(calls.slice(count)).toEqual([pathname]);checkHeaders(response as unknown as Response);
      if(pathname.startsWith('/api/') || pathname.startsWith('/skills/'))expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status,response.status>=500?`${pathname}: ${await response.text()}`:pathname).toBeLessThan(500);
      await response.body?.cancel();
    }
    const count=calls.length;
    const returned=await runtime.dispatchFetch('https://pay.example.test/payment/return?out_trade_no='+id,{redirect:'manual'});
    expect(calls.slice(count)).toEqual(['/payment/return']);expect(returned.status).toBe(303);
    expect(returned.headers.get('location')).toBe('https://pay.example.test/checkout/'+id);checkHeaders(returned as unknown as Response);
  });
});
