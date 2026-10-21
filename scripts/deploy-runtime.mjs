// Initial deployment with server-only Text vars. Never forward Wrangler binding values to logs.
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const input=process.argv[2]||'secrets/runtime-vars.json';
const config=JSON.parse(await readFile(resolve(root,'wrangler.jsonc'),'utf8'));
const runtime=JSON.parse(await readFile(resolve(root,input),'utf8'));
const required=['GITHUB_APP_PRIVATE_KEY','ALIPAY_PRIVATE_KEY','ALIPAY_PUBLIC_KEY','ALIPAY_SELLER_ID','CHECKOUT_SECRET','ADMIN_EMAIL','ADMIN_PASSWORD_HASH','ADMIN_PASSWORD_PEPPER','ADMIN_SESSION_SECRET','WECHAT_PRIVATE_KEY','WECHAT_SERIAL_NO','WECHAT_API_V3_KEY','WECHAT_PUBLIC_KEYS_JSON'];
if(required.some(name=>typeof runtime[name]!=='string'||!runtime[name]))throw Error('Required runtime binding is missing; values withheld');
config.main=resolve(root,config.main);config.assets.directory=resolve(root,config.assets.directory);
config.alias=Object.fromEntries(Object.entries(config.alias||{}).map(([name,path])=>[name,resolve(root,path)]));
config.vars={...runtime,...config.vars};
for(const name of ['GITHUB_TOKEN','REGISTRY_ENCRYPTION_KEY','ENCRYPTION_KEY','ORDER_ID_SECRET'])delete config.vars[name];
const path=resolve(root,'secrets/deploy-runtime.wrangler.json');
await mkdir(dirname(path),{recursive:true,mode:0o700});
await writeFile(path,JSON.stringify(config),{mode:0o600});
try{
 const result=spawnSync(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config',path],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
 const output=(result.stdout||'')+'\n'+(result.stderr||'');
 const version=/Current Version ID:\s*([a-f0-9-]{36})/.exec(output)?.[1];
 console.log(JSON.stringify({worker:config.name,account:config.account_id,exitCode:result.status,version,bindingNames:Object.keys(config.vars).sort()}));
 if(result.status!==0){const errors=[...output.matchAll(/\[ERROR\]([^\n]*)/g)].map(m=>m[1].trim()).filter(line=>!Object.values(runtime).some(value=>line.includes(value)||value.length>20&&line.includes(value.slice(0,20))));console.error(JSON.stringify({deploymentFailed:true,errors}));process.exitCode=1;}
}finally{await unlink(path).catch(()=>{});}
