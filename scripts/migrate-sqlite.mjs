#!/usr/bin/env node
/** Exact, private, two-step export/import of the unified payment repository. */
import {createHash, createSign, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, lstat, unlink, link, mkdtemp, rm, chmod, realpath} from 'node:fs/promises';
import {resolve, dirname, relative, isAbsolute, join, basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {fetch as networkFetch,EnvHttpProxyAgent} from 'undici';
import {Github, TARGET_REPOSITORY, canonical} from './migrate-data.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SHA=/^[a-f0-9]{64}$/, GITSHA=/^[a-f0-9]{40}$/;
const MAX_BYTES=512*1024*1024;
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const hash=value=>createHash('sha256').update(value).digest('hex');
const gitHash=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const check=(value,code)=>{if(!value)fail(code);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
let exportDispatcher;
/** Honor the same explicit proxy environment as the existing Cloudflare tooling. */
async function exportFetch(input,init={}){
  if(!exportDispatcher&&[process.env.HTTPS_PROXY,process.env.https_proxy,process.env.HTTP_PROXY,process.env.http_proxy].some(Boolean))exportDispatcher=new EnvHttpProxyAgent();
  const signal=init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000);
  const attempts=(init.method||'GET')==='GET'?2:1;
  for(let attempt=0;attempt<attempts;attempt++){
    try{
      const response=await networkFetch(input,{...init,signal,...(exportDispatcher?{dispatcher:exportDispatcher}:{})});
      if(response.status>=500&&attempt+1<attempts){await response.body?.cancel();continue;}
      return response;
    }catch{if(attempt+1>=attempts||signal.aborted)fail('GITHUB_EXPORT_NETWORK_FAILED');}
  }
  fail('GITHUB_EXPORT_NETWORK_FAILED');
}
function safePath(value){check(typeof value==='string'&&value.length>0&&value.length<=4096&&!value.startsWith('/')&&!/[\\\x00-\x1f\x7f]/.test(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..'),'INVALID_SOURCE_PATH');return value;}
const documentPath=path=>path.length<=240&&/^[A-Za-z0-9][A-Za-z0-9_./-]*\.json$/.test(path)&&!path.split('/').some(part=>part.startsWith('.')||part.includes('..'));
async function privateLocation(filename){
  check(typeof filename==='string'&&filename.length>0,'PRIVATE_OUTPUT_REQUIRED');
  // Resolve the nearest existing ancestor: lexical secrets/ paths may otherwise
  // follow a symlink into public/ and expose imported records or runtime keys.
  let ancestor=resolve(filename);const remainder=[];let canonicalAncestor;
  for(;;){
    try{canonicalAncestor=await realpath(ancestor);break;}
    catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(ancestor);check(parent!==ancestor,'PRIVATE_OUTPUT_REQUIRED');remainder.unshift(basename(ancestor));ancestor=parent;}
  }
  const absolute=resolve(canonicalAncestor,...remainder),inside=relative(await realpath(ROOT),absolute);
  check(inside.startsWith('../')||isAbsolute(inside)||inside==='secrets'||inside.startsWith('secrets/'),'PRIVATE_OUTPUT_REQUIRED');
  return absolute;
}
async function absent(filename){try{await lstat(filename);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
async function jsonFile(filename){
  const info=await lstat(filename);check(info.isFile()&&!info.isSymbolicLink()&&info.size<=MAX_BYTES,'INVALID_PRIVATE_FILE');
  const bytes=await readFile(filename);let value;try{value=JSON.parse(utf8.decode(bytes));}catch{fail('INVALID_PRIVATE_JSON');}return {bytes,value};
}
function runtimeConfig(value){
  check(record(value)&&Object.keys(value).length>0&&Object.keys(value).length<=256,'INVALID_RUNTIME_CONFIG');
  for(const [name,text] of Object.entries(value))check(/^[A-Z][A-Z0-9_]{0,99}$/.test(name)&&typeof text==='string'&&Buffer.byteLength(text)<=256*1024,'INVALID_RUNTIME_CONFIG');
  return value;
}
function fileEntry(file){
  safePath(file.path);check(GITSHA.test(file.sha),'INVALID_BLOB_SHA');
  const bytes=file.bytes!==undefined?Buffer.from(file.bytes):typeof file.contentBase64==='string'?Buffer.from(file.contentBase64,'base64'):null;
  check(bytes&&bytes.length<=MAX_BYTES,'INVALID_SOURCE_CONTENT');
  if(file.contentBase64!==undefined)check(bytes.toString('base64')===file.contentBase64,'INVALID_SOURCE_BASE64');
  check(gitHash(bytes)===file.sha,'SOURCE_BLOB_SHA_MISMATCH');
  if(file.sha256!==undefined)check(hash(bytes)===file.sha256,'SOURCE_FILE_HASH_MISMATCH');
  if(documentPath(file.path)){try{JSON.parse(utf8.decode(bytes));}catch{fail('INVALID_SOURCE_JSON');}}
  return {path:file.path,sha:file.sha,sha256:hash(bytes),size:bytes.length,contentBase64:bytes.toString('base64')};
}
export function normalizeSnapshot(value){
  check(record(value)&&value.repository===TARGET_REPOSITORY&&GITSHA.test(value.revision)&&GITSHA.test(value.tree)&&typeof value.branch==='string'&&/^[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/.test(value.branch)&&!value.branch.includes('..')&&Array.isArray(value.files),'INVALID_SOURCE_SNAPSHOT');
  const files=value.files.map(fileEntry).sort((a,b)=>a.path.localeCompare(b.path));
  check(new Set(files.map(file=>file.path)).size===files.length,'DUPLICATE_SOURCE_PATH');
  check(files.reduce((sum,file)=>sum+file.size,0)<=MAX_BYTES,'SOURCE_TOO_LARGE');
  return {schema:1,repository:TARGET_REPOSITORY,branch:value.branch,revision:value.revision,tree:value.tree,files};
}
/** The installation token can read only the unified data repository. */
export async function sourceAccess(config,fetcher=exportFetch){
  runtimeConfig(config);
  check(config.GITHUB_APP_ID==='5411175'&&config.GITHUB_REPOSITORY===TARGET_REPOSITORY&&config.GITHUB_APP_PRIVATE_KEY,'SOURCE_CONFIGURATION_MISMATCH');
  const now=Math.floor(Date.now()/1000),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iat:now-60,exp:now+540,iss:'5411175'});
  let signature;try{signature=createSign('RSA-SHA256').update(unsigned).sign(config.GITHUB_APP_PRIVATE_KEY).toString('base64url');}catch{fail('GITHUB_APP_KEY_INVALID');}
  const app=new Github(unsigned+'.'+signature,fetcher),identity=await app.request('/app');
  check(identity.id===5411175&&identity.owner?.login==='BrclioData','GITHUB_APP_IDENTITY_MISMATCH');
  const installation=await app.request(`/repos/${TARGET_REPOSITORY}/installation`);
  check(installation.id&&!installation.suspended_at&&['read','write'].includes(installation.permissions?.contents),'GITHUB_APP_PERMISSION_REQUIRED');
  const access=await app.request(`/app/installations/${installation.id}/access_tokens`,'POST',{repositories:['BrclioPay-Data'],permissions:{contents:'read',metadata:'read'}});
  check(typeof access.token==='string'&&access.token.length>0,'GITHUB_APP_TOKEN_FAILED');
  const github=new Github(access.token,fetcher);
  // Unlike the legacy migration helper, retain hidden and non-ASCII archive filenames.
  github.snapshot=async(repository,branch)=>{
    check(repository===TARGET_REPOSITORY,'SOURCE_REPOSITORY_MISMATCH');
    const meta=await github.request('/repos/'+repository);check(meta.private===true,'REPOSITORY_NOT_PRIVATE');
    branch||=meta.default_branch;
    const revision=await github.revision(repository,branch);check(GITSHA.test(revision),'INVALID_SOURCE_REVISION');
    const commit=await github.request(`/repos/${repository}/git/commits/${revision}`);check(GITSHA.test(commit.tree?.sha),'INVALID_SOURCE_TREE');
    const tree=await github.request(`/repos/${repository}/git/trees/${commit.tree.sha}?recursive=1`);
    check(tree.truncated===false&&Array.isArray(tree.tree),'GITHUB_TRUNCATED_TREE');
    const files=[];
    for(const entry of tree.tree){if(entry.type==='tree')continue;check(entry.type==='blob'&&GITSHA.test(entry.sha),'UNSUPPORTED_GIT_ENTRY');safePath(entry.path);files.push({path:entry.path,sha:entry.sha});}
    return {repository,branch,revision,tree:commit.tree.sha,files};
  };
  return github;
}
export async function exportSnapshot(github,branch='main'){
  const snapshot=await github.snapshot(TARGET_REPOSITORY,branch);let next=0;const files=new Array(snapshot.files.length);
  await Promise.all(Array.from({length:Math.min(4,files.length)},async()=>{while(next<files.length){const i=next++,file=snapshot.files[i];files[i]={...file,bytes:await github.bytes(TARGET_REPOSITORY,file)};}}));
  check(await github.revision(TARGET_REPOSITORY,snapshot.branch)===snapshot.revision,'SOURCE_CHANGED_DURING_EXPORT');
  return normalizeSnapshot({...snapshot,files});
}
function counts(snapshot){
  const result={files:snapshot.files.length,jsonDocuments:0,archivedFiles:0,orders:0,paidOrders:0,pendingOrders:0,closedOrders:0,deliveredOrders:0,events:0,pendingDeliveries:0,clients:0,grants:0,plans:0,audits:0};
  for(const file of snapshot.files){
    if(!documentPath(file.path)){result.archivedFiles++;continue;}result.jsonDocuments++;
    const value=JSON.parse(utf8.decode(Buffer.from(file.contentBase64,'base64')));
    if(/^orders\/\d{4}\/\d{2}\/pay_[a-f0-9]{32}\.json$/.test(file.path)){result.orders++;if(value.status==='PAID')result.paidOrders++;if(value.status==='PENDING')result.pendingOrders++;if(value.status==='CLOSED')result.closedOrders++;if(value.fulfillmentStatus==='delivered')result.deliveredOrders++;}
    if(/^events\/\d{4}\/\d{2}\/evt_pay_[a-f0-9]{32}\.json$/.test(file.path)){result.events++;if(!value.deliveredAt)result.pendingDeliveries++;}
    for(const [prefix,key] of [['registry/clients/','clients'],['registry/grants/','grants'],['registry/plans/','plans'],['registry/audit/','audits']])if(file.path.startsWith(prefix))result[key]++;
  }
  return result;
}
function planDigest(plan){const {digest,...rest}=plan;return hash(canonical(rest));}
export async function prepareMigration({snapshot,config,output,github,now=()=>new Date().toISOString()}){
  const directory=await privateLocation(output);check(await absent(directory),'OUTPUT_ALREADY_EXISTS');runtimeConfig(config);
  const source=normalizeSnapshot(snapshot||await exportSnapshot(github||await sourceAccess(config),config.GITHUB_BRANCH||'main'));
  const snapshotText=JSON.stringify(source)+'\n',configText=JSON.stringify(config)+'\n';
  check(Buffer.byteLength(snapshotText)<=MAX_BYTES,'SOURCE_TOO_LARGE');
  const plan={schema:1,kind:'brclio-pay-github-to-sqlite',preparedAt:now(),source:{repository:source.repository,branch:source.branch,revision:source.revision,tree:source.tree},
    files:source.files.map(({path,sha,sha256,size})=>({path,sha,sha256,size})),snapshotSha256:hash(snapshotText),runtimeConfigSha256:hash(configText),runtimeConfigCount:Object.keys(config).length,counts:counts(source)};
  plan.digest=planDigest(plan);
  await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
  await writeFile(join(directory,'snapshot.json'),snapshotText,{flag:'wx',mode:0o600});
  await writeFile(join(directory,'runtime-config.json'),configText,{flag:'wx',mode:0o600});
  await writeFile(join(directory,'plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
  return {digest:plan.digest,sourceRevision:source.revision,counts:plan.counts,runtimeConfigCount:plan.runtimeConfigCount};
}
export async function readPreparedMigration(directory,expectedDigest){
  directory=await privateLocation(directory);check(SHA.test(expectedDigest||''),'EXPECTED_DIGEST_REQUIRED');
  const {value:plan}=await jsonFile(join(directory,'plan.json'));
  check(plan.schema===1&&plan.kind==='brclio-pay-github-to-sqlite'&&plan.digest===expectedDigest&&planDigest(plan)===expectedDigest,'PLAN_DIGEST_MISMATCH');
  const source=await jsonFile(join(directory,'snapshot.json')),runtime=await jsonFile(join(directory,'runtime-config.json'));
  check(hash(source.bytes)===plan.snapshotSha256,'SNAPSHOT_HASH_MISMATCH');check(hash(runtime.bytes)===plan.runtimeConfigSha256,'CONFIG_HASH_MISMATCH');
  const snapshot=normalizeSnapshot(source.value),config=runtimeConfig(runtime.value);
  check(canonical(snapshot.files.map(({path,sha,sha256,size})=>({path,sha,sha256,size})))===canonical(plan.files)&&canonical(counts(snapshot))===canonical(plan.counts),'PLAN_CONTENT_MISMATCH');
  check(canonical({repository:snapshot.repository,branch:snapshot.branch,revision:snapshot.revision,tree:snapshot.tree})===canonical(plan.source)&&Object.keys(config).length===plan.runtimeConfigCount,'PLAN_CONTENT_MISMATCH');
  return {directory,plan,snapshot,config};
}
let storePromise;
async function storeModule(){
  storePromise??=(async()=>{
    const directory=await mkdtemp(join(tmpdir(),'brclio-sqlite-module-')),filename=join(directory,'sqlite-store.mjs');
    try{await build({entryPoints:[join(ROOT,'server/sqlite-store.ts')],outfile:filename,platform:'node',target:'node22',format:'esm',bundle:true,logLevel:'silent'});return await import(pathToFileURL(filename).href);}
    finally{await rm(directory,{recursive:true,force:true});}
  })();return storePromise;
}
export async function verifyImported(store,prepared){
  const result=await store.exportSnapshot(),{snapshot,config,plan}=prepared;
  const expected=new Map(snapshot.files.map(file=>[file.path,file]));
  check(result.documents.length===plan.counts.jsonDocuments&&(result.archives?.length||0)===plan.counts.archivedFiles,'IMPORT_COUNT_MISMATCH');
  for(const item of [...result.documents,...result.archives||[]]){const file=expected.get(item.path);check(file&&hash(Buffer.from(item.content))===file.sha256,'IMPORT_CONTENT_MISMATCH');expected.delete(item.path);}
  check(expected.size===0&&canonical(result.runtimeConfig)===canonical(config),'IMPORT_CONFIG_OR_FILE_MISMATCH');
  check(result.sourceRevision===snapshot.revision,'IMPORT_SOURCE_MISMATCH');
  return {verifiedFiles:snapshot.files.length,runtimeConfigVerified:true,sourceRevisionVerified:true};
}
export async function applyMigration({directory,expectedDigest,database,github,StoreClass,now=()=>new Date().toISOString()}){
  const prepared=await readPreparedMigration(directory,expectedDigest),{plan,snapshot,config}=prepared;
  const target=await privateLocation(database);
  for(const suffix of ['','-wal','-shm'])check(await absent(target+suffix),'DATABASE_ALREADY_EXISTS');
  const access=github||await sourceAccess(config);
  const assertSource=async()=>check(await access.revision(TARGET_REPOSITORY,snapshot.branch)===snapshot.revision,'SOURCE_REVISION_CHANGED');
  await assertSource();
  const SQLiteStore=StoreClass||(await storeModule()).SQLiteStore;
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const staged=join(dirname(target),'.brclio-migration-'+randomUUID()+'.sqlite');
  let store,published=false;
  try{
    await writeFile(staged,'',{flag:'wx',mode:0o600});store=new SQLiteStore(staged);
    const documents=[],archives=[];
    for(const file of snapshot.files){const bytes=Buffer.from(file.contentBase64,'base64');if(documentPath(file.path))documents.push({path:file.path,content:utf8.decode(bytes)});else archives.push({path:file.path,content:bytes});}
    await assertSource();
    await store.importDocuments(documents,{sourceRevision:snapshot.revision,runtimeConfig:config,archives,sourceMetadata:{schema:1,...plan.source,planDigest:plan.digest,snapshotSha256:plan.snapshotSha256,runtimeConfigSha256:plan.runtimeConfigSha256,preparedAt:plan.preparedAt,appliedAt:now()}});
    const verified=await verifyImported(store,prepared);await assertSource();
    await store.close();store=undefined;
    // Hard-link publication is atomic and fails if another process created the destination.
    await link(staged,target);published=true;await unlink(staged);
    const evidence={schema:1,appliedAt:now(),planDigest:plan.digest,sourceRevision:snapshot.revision,counts:plan.counts,runtimeConfigCount:plan.runtimeConfigCount,...verified};
    await writeFile(join(prepared.directory,'applied-'+plan.digest+'-'+hash(target).slice(0,16)+'.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
    return evidence;
  }finally{
    if(store)await store.close();
    for(const suffix of ['','-wal','-shm'])await unlink(staged+suffix).catch(error=>{if(error.code!=='ENOENT')throw error;});
    // Never delete a published database on evidence-writing failure.
    void published;
  }
}
/** Private rollback artifact only; never changes the standby GitHub repository. */
export async function exportRecovery({database,output,StoreClass,now=()=>new Date().toISOString()}){
  const target=await privateLocation(output);check(await absent(target),'OUTPUT_ALREADY_EXISTS');
  check(database&&!await absent(database),'DATABASE_REQUIRED');
  const SQLiteStore=StoreClass||(await storeModule()).SQLiteStore,store=new SQLiteStore(database);
  let snapshot;try{snapshot=await store.exportSnapshot();}finally{await store.close();}
  const files=[...snapshot.documents,...snapshot.archives||[]].map(item=>{
    const bytes=Buffer.from(item.content);return {path:item.path,sha:gitHash(bytes),sha256:hash(bytes),size:bytes.length,contentBase64:bytes.toString('base64')};
  }).sort((a,b)=>a.path.localeCompare(b.path));
  const recovery={schema:1,kind:'brclio-pay-sqlite-recovery',exportedAt:now(),sqliteRevision:snapshot.revision,originalSourceRevision:snapshot.sourceRevision,
    sourceMetadata:snapshot.sourceMetadata||null,files,runtimeConfig:snapshot.runtimeConfig};
  recovery.digest=hash(canonical(recovery));
  await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,JSON.stringify(recovery)+'\n',{flag:'wx',mode:0o600});
  return {digest:recovery.digest,files:files.length,runtimeConfigCount:Object.keys(snapshot.runtimeConfig).length,sqliteRevision:snapshot.revision,standbyUnchanged:true};
}
function argumentsFor(argv){
  const [action,...flags]=argv;check(['prepare','apply','verify','export-recovery'].includes(action),'USAGE_REQUIRED');const values={};
  for(let i=0;i<flags.length;i+=2){check(/^--(?:config|output|snapshot|plan|expected-digest|database)$/.test(flags[i])&&flags[i+1]&&!flags[i+1].startsWith('--')&&!Object.hasOwn(values,flags[i]),'INVALID_ARGUMENT');values[flags[i]]=flags[i+1];}
  return {action,values};
}
export async function main(argv=process.argv.slice(2)){
  const {action,values:v}=argumentsFor(argv);let result;
  if(action==='prepare'){
    check(v['--config']&&v['--output'],'CONFIG_AND_OUTPUT_REQUIRED');
    const config=(await jsonFile(v['--config'])).value,snapshot=v['--snapshot']?(await jsonFile(v['--snapshot'])).value:undefined;
    result=await prepareMigration({config,snapshot,output:v['--output']});
  }else if(action==='apply'){
    check(v['--plan']&&v['--database'],'PLAN_AND_DATABASE_REQUIRED');result=await applyMigration({directory:v['--plan'],expectedDigest:v['--expected-digest'],database:v['--database']});
  }else if(action==='export-recovery'){
    check(v['--database']&&v['--output'],'DATABASE_AND_OUTPUT_REQUIRED');result=await exportRecovery({database:v['--database'],output:v['--output']});
  }else{
    const prepared=await readPreparedMigration(v['--plan'],v['--expected-digest']);check(v['--database']&&!await absent(v['--database']),'DATABASE_REQUIRED');
    const {SQLiteStore}=await storeModule(),store=new SQLiteStore(v['--database']);try{result=await verifyImported(store,prepared);}finally{await store.close();}
  }
  console.log(JSON.stringify({operation:action,...result}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({failed:true,code:typeof error.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'SQLITE_MIGRATION_FAILED'}));process.exitCode=1;}).finally(async()=>{await exportDispatcher?.close();});
