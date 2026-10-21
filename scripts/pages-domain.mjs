// Local setup only: reuse Wrangler's existing OAuth session without printing credentials.
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {fetch,ProxyAgent} from 'undici';
import ts from 'typescript';
const [action='status']=process.argv.slice(2);
if(!['status','add'].includes(action))throw new Error('Usage: node scripts/pages-domain.mjs status|add');
// Let Wrangler refresh its OAuth session before reading the short-lived token.
try{execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','whoami'],{stdio:'ignore',timeout:45_000});}
catch{throw new Error('Cloudflare authentication unavailable; run npx wrangler login');}
const config=readFileSync(join(homedir(),'Library/Preferences/.wrangler/config/default.toml'),'utf8');
const token=/^oauth_token\s*=\s*"([^"]+)"/m.exec(config)?.[1];
if(!token)throw new Error('Sign in with wrangler login first');
const proxy=process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher=proxy?new ProxyAgent(proxy):undefined;
const root=fileURLToPath(new URL('../',import.meta.url));
const worker=ts.parseConfigFileTextToJson('wrangler.jsonc',readFileSync(join(root,'wrangler.jsonc'),'utf8'));
const pages=ts.parseConfigFileTextToJson('cloudflare/pages/wrangler.jsonc',readFileSync(join(root,'cloudflare/pages/wrangler.jsonc'),'utf8'));
const account=worker.config?.account_id;
const project=pages.config?.name;
const domain=new URL(worker.config?.vars?.PAY_BASE_URL).hostname;
if(worker.error || pages.error || !/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9-]+$/.test(project)
  || (pages.config.account_id && pages.config.account_id!==account))throw new Error('Invalid deployment account/project configuration');
const base=`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/domains`;
try {
  const response=await fetch(action==='add'?base:base+'/'+domain,{method:action==='add'?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(action==='add'?{body:JSON.stringify({name:domain})}:{}),dispatcher,redirect:'error'});
  const result=await response.json();
  console.log(JSON.stringify({httpStatus:response.status,success:result.success,domain:result.result?.name,status:result.result?.status,validation:result.result?.validation_data,verification:result.result?.verification_data,errors:result.errors?.map(e=>({code:e.code,message:e.message}))}));
  if(!response.ok)process.exitCode=1;
}catch{console.error('Cloudflare domain request failed');process.exitCode=1;}finally{await dispatcher?.close();}
