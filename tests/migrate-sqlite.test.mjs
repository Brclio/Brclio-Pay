import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,stat,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeSnapshot,prepareMigration,readPreparedMigration,applyMigration,exportRecovery,sourceAccess,exportSnapshot} from '../scripts/migrate-sqlite.mjs';
import {canonical,TARGET_REPOSITORY} from '../scripts/migrate-data.mjs';
const test=process.env.VITEST?(await import('vitest')).test:(await import('node:test')).default;
const hash=value=>createHash('sha256').update(value).digest('hex');
function file(path,content){const bytes=Buffer.from(content);return {path,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),contentBase64:bytes.toString('base64')};}
function fixture(){return {repository:TARGET_REPOSITORY,branch:'main',revision:'a'.repeat(40),tree:'b'.repeat(40),files:[
  file('orders/2026/11/pay_'+ '1'.repeat(32)+'.json','{ "id": "pay_'+ '1'.repeat(32)+'", "amount": "1.00", "status": "PAID", "fulfillmentStatus": "delivered" }\n'),
  file('registry/clients/example.json','{"apiSecret":"fixture-secret-preserved","skus":{}}\n'),
  file('system/queue.json','{"orders":[],"deliveries":[]}\n'),file('README.md','Original archive\r\nexact bytes\n'),file('archive/binary.bin',Buffer.from([0,1,255,128,2]))]};}
const config=()=>({PAY_BASE_URL:'https://pay.example.test',PAYMENT_ENABLED:'true',CHECKOUT_SECRET:'fixture-checkout-secret-is-preserved',GITHUB_APP_ID:'5411175',GITHUB_REPOSITORY:TARGET_REPOSITORY,GITHUB_BRANCH:'main'});
async function withFixture(callback){const directory=await mkdtemp(join(tmpdir(),'sqlite-migration-test-'));try{const planDirectory=join(directory,'prepared'),prepared=await prepareMigration({snapshot:fixture(),config:config(),output:planDirectory});await callback({directory,planDirectory,prepared});}finally{await rm(directory,{recursive:true,force:true});}}
const source=()=>({revision:async()=>fixture().revision});

test('preparation preserves raw JSON whitespace, binary archive bytes and private output permissions',async()=>withFixture(async({planDirectory,prepared})=>{
  const loaded=await readPreparedMigration(planDirectory,prepared.digest);
  assert.equal(loaded.snapshot.files.length,5);assert.deepEqual(loaded.config,config());
  assert.equal(prepared.counts.orders,1);assert.equal(prepared.counts.archivedFiles,2);assert.equal(prepared.counts.deliveredOrders,1);
  assert.equal((await stat(planDirectory)).mode&0o777,0o700);
  for(const name of ['snapshot.json','runtime-config.json','plan.json'])assert.equal((await stat(join(planDirectory,name))).mode&0o777,0o600);
  assert.equal(loaded.snapshot.files.find(item=>item.path.endsWith('.bin')).contentBase64,fixture().files.at(-1).contentBase64);
  assert.equal(JSON.stringify(prepared).includes('fixture-secret'),false);assert.equal(JSON.stringify(prepared).includes('1.00'),false);
}));

test('rejects snapshot bytes or deployment config changed after review',async()=>withFixture(async({planDirectory,prepared})=>{
  const snapshot=join(planDirectory,'snapshot.json'),before=await readFile(snapshot);
  await writeFile(snapshot,Buffer.concat([before,Buffer.from(' ')]));
  await assert.rejects(readPreparedMigration(planDirectory,prepared.digest),{code:'SNAPSHOT_HASH_MISMATCH'});
  await writeFile(snapshot,before);await writeFile(join(planDirectory,'runtime-config.json'),JSON.stringify({...config(),CHECKOUT_SECRET:'changed'}));
  await assert.rejects(readPreparedMigration(planDirectory,prepared.digest),{code:'CONFIG_HASH_MISMATCH'});
}));

test('rejects modified plan even if attacker recalculates its embedded digest',async()=>withFixture(async({planDirectory,prepared})=>{
  const path=join(planDirectory,'plan.json'),plan=JSON.parse(await readFile(path));plan.source.revision='c'.repeat(40);const {digest,...rest}=plan;plan.digest=hash(canonical(rest));await writeFile(path,JSON.stringify(plan));
  await assert.rejects(readPreparedMigration(planDirectory,prepared.digest),{code:'PLAN_DIGEST_MISMATCH'});
}));

test('rejects incorrect Git blob identity, path traversal and duplicate filenames',()=>{
  const bad=fixture();bad.files[0].contentBase64=Buffer.from('{}').toString('base64');assert.throws(()=>normalizeSnapshot(bad),{code:'SOURCE_BLOB_SHA_MISMATCH'});
  const traversal=fixture();traversal.files.push(file('../escape.json','{}'));assert.throws(()=>normalizeSnapshot(traversal),{code:'INVALID_SOURCE_PATH'});
  const duplicate=fixture();duplicate.files.push(duplicate.files[0]);assert.throws(()=>normalizeSnapshot(duplicate),{code:'DUPLICATE_SOURCE_PATH'});
});

test('rejects source movement before any target database is created',async()=>withFixture(async({directory,planDirectory,prepared})=>{
  const database=join(directory,'live.sqlite');let touched=false;
  await assert.rejects(applyMigration({directory:planDirectory,expectedDigest:prepared.digest,database,github:{revision:async()=>'c'.repeat(40)},StoreClass:class{constructor(){touched=true;}}}),{code:'SOURCE_REVISION_CHANGED'});
  assert.equal(touched,false);await assert.rejects(stat(database),{code:'ENOENT'});
}));

test('refuses to overwrite an existing database, including an empty file',async()=>withFixture(async({directory,planDirectory,prepared})=>{
  const database=join(directory,'live.sqlite');await writeFile(database,'');
  await assert.rejects(applyMigration({directory:planDirectory,expectedDigest:prepared.digest,database,github:source()}),{code:'DATABASE_ALREADY_EXISTS'});
  assert.equal((await readFile(database)).length,0);
}));

test('imports exact data and config into SQLite and produces complete private reverse recovery artifact',async()=>withFixture(async({directory,planDirectory,prepared})=>{
  const database=join(directory,'live.sqlite');const applied=await applyMigration({directory:planDirectory,expectedDigest:prepared.digest,database,github:source()});
  assert.equal(applied.verifiedFiles,5);assert.equal(applied.runtimeConfigVerified,true);assert.equal((await stat(database)).mode&0o777,0o600);
  const output=join(directory,'recovery.json'),summary=await exportRecovery({database,output});assert.equal(summary.files,5);assert.equal(summary.standbyUnchanged,true);
  const recovery=JSON.parse(await readFile(output)),{digest,...rest}=recovery;assert.equal(digest,hash(canonical(rest)));assert.deepEqual(recovery.runtimeConfig,config());
  for(const original of fixture().files)assert.equal(recovery.files.find(item=>item.path===original.path)?.contentBase64,original.contentBase64);
  assert.equal((await stat(output)).mode&0o777,0o600);assert.equal(recovery.sourceMetadata.planDigest,prepared.digest);
}));

test('source mutation during import prevents publishing the staged SQLite database',async()=>withFixture(async({directory,planDirectory,prepared})=>{
  let checks=0;const database=join(directory,'live.sqlite');
  await assert.rejects(applyMigration({directory:planDirectory,expectedDigest:prepared.digest,database,github:{revision:async()=>++checks>=3?'c'.repeat(40):fixture().revision}}),{code:'SOURCE_REVISION_CHANGED'});
  assert.equal(checks,3);await assert.rejects(stat(database),{code:'ENOENT'});
}));

test('live export verifies the source revision after reading every raw blob',async()=>{
  const snapshot=fixture();const github={snapshot:async()=>snapshot,bytes:async(_,file)=>Buffer.from(file.contentBase64,'base64'),revision:async()=>'c'.repeat(40)};
  await assert.rejects(exportSnapshot(github),{code:'SOURCE_CHANGED_DURING_EXPORT'});
});

test('GitHub App export requests a read-only token restricted to the unified data repository',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const calls=[];const fetcher=async(url,init)=>{const path=new URL(url).pathname;calls.push({path,body:init.body?JSON.parse(init.body):undefined});let result;
    if(path==='/app')result={id:5411175,owner:{login:'BrclioData'}};
    else if(path.endsWith('/installation'))result={id:123,permissions:{contents:'write'}};
    else if(path.endsWith('/access_tokens'))result={token:'fake-scoped-token'};else throw Error('unexpected request');
    return new Response(JSON.stringify(result),{status:200});};
  await sourceAccess({...config(),GITHUB_APP_PRIVATE_KEY:privateKey},fetcher);
  assert.deepEqual(calls.at(-1).body,{repositories:['BrclioPay-Data'],permissions:{contents:'read',metadata:'read'}});
  assert.equal(calls.length,3);
});

test('retains hidden and non-ASCII repository files as exact SQLite archives',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sqlite-archive-paths-'));
  try{
    const snapshot=fixture();snapshot.files.push(file('.gitignore','private\n'),file('档案/readme.txt','历史说明\n'),file('.github/config.json','{"retained":true}\n'));
    const planDirectory=join(directory,'prepared'),prepared=await prepareMigration({snapshot,config:config(),output:planDirectory});
    assert.equal(prepared.counts.archivedFiles,5);
    const database=join(directory,'live.sqlite');await applyMigration({directory:planDirectory,expectedDigest:prepared.digest,database,github:source()});
    const output=join(directory,'recovery.json');await exportRecovery({database,output});const recovery=JSON.parse(await readFile(output));
    for(const original of snapshot.files)assert.equal(recovery.files.find(item=>item.path===original.path)?.contentBase64,original.contentBase64);
  }finally{await rm(directory,{recursive:true,force:true});}
});


test('private outputs cannot escape through a secrets symlink or an external alias into public assets',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));await mkdir(join(root,'secrets'),{recursive:true});
  const privateTemp=await mkdtemp(join(root,'secrets','sqlite-path-test-')),external=await mkdtemp(join(tmpdir(),'sqlite-path-alias-'));
  try{
    await symlink(join(root,'public'),join(privateTemp,'public-alias'));
    await assert.rejects(prepareMigration({snapshot:fixture(),config:config(),output:join(privateTemp,'public-alias','must-not-exist')}),{code:'PRIVATE_OUTPUT_REQUIRED'});
    await symlink(join(root,'public'),join(external,'public-alias'));
    await assert.rejects(prepareMigration({snapshot:fixture(),config:config(),output:join(external,'public-alias','nested','must-not-exist')}),{code:'PRIVATE_OUTPUT_REQUIRED'});
    await assert.rejects(exportRecovery({database:join(external,'not-opened.sqlite'),output:join(privateTemp,'public-alias','credentials.json')}),{code:'PRIVATE_OUTPUT_REQUIRED'});
  }finally{await rm(privateTemp,{recursive:true,force:true});await rm(external,{recursive:true,force:true});}
});
