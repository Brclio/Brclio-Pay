// Daily code deployments retain every dashboard variable. Initial provisioning
// deliberately uses deploy-runtime.mjs with an explicitly reviewed local file.
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function deploymentConfig(config,base=root) {
  if(!config || typeof config!=='object' || typeof config.main!=='string' || !config.assets?.directory
    || !/^[a-z0-9-]+$/.test(config.name) || !/^[a-f0-9]{32}$/.test(config.account_id))throw Error('Invalid Worker deployment configuration');
  return {...config,$schema:resolve(base,'node_modules/wrangler/config-schema.json'),main:resolve(base,config.main),
    assets:{...config.assets,directory:resolve(base,config.assets.directory)},
    alias:Object.fromEntries(Object.entries(config.alias||{}).map(([name,path])=>[name,resolve(base,path)])),
    vars:{},keep_vars:true};
}

async function main() {
  if(process.argv.slice(2).some(arg=>arg!=='--dry-run'))throw Error('Only --dry-run is accepted; maintain runtime values in the Cloudflare dashboard');
  const parsed=ts.parseConfigFileTextToJson('wrangler.jsonc',await readFile(resolve(root,'wrangler.jsonc'),'utf8'));
  if(parsed.error)throw Error('Invalid Worker deployment configuration');
  const config=deploymentConfig(parsed.config);
  const temporary=await mkdtemp(resolve(tmpdir(),'brclio-pay-deploy-'));
  const path=resolve(temporary,'wrangler.json');
  try {
    await writeFile(path,JSON.stringify(config),{mode:0o600});
    const result=spawnSync(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config',path,
      ...process.argv.slice(2)],{cwd:root,env:{...process.env,CLOUDFLARE_ACCOUNT_ID:config.account_id,CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'},encoding:'utf8',maxBuffer:8*1024*1024});
    const output=(result.stdout||'')+'\n'+(result.stderr||'');
    await mkdir(resolve(root,'secrets'),{recursive:true,mode:0o700});
    await writeFile(resolve(root,'secrets/deploy-worker.log'),output,{mode:0o600});
    const version=/Current Version ID:\s*([a-f0-9-]{36})/.exec(output)?.[1];
    console.log(JSON.stringify({worker:config.name,exitCode:result.status,version,dashboardVariablesPreserved:true,
      runtimeValuesInDeployment:0,dryRun:process.argv.includes('--dry-run')}));
    if(result.error || result.status!==0){console.error('Worker deployment failed; diagnostic output is saved locally in secrets/deploy-worker.log');process.exitCode=1;}
  } finally {await rm(temporary,{recursive:true,force:true});}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
