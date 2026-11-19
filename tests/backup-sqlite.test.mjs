import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,chmod,realpath,rm,stat,readFile,writeFile,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const test=process.env.VITEST?(await import('vitest')).test:(await import('node:test')).default;
const execute=promisify(execFile);
const script=fileURLToPath(new URL('../scripts/backup-sqlite.py',import.meta.url));
const fixtureSecret='SYNTHETIC_BACKUP_CONFIG_MUST_NOT_BE_LOGGED';

async function withDatabase(callback){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'brclio-online-backup-')));
  const database=join(directory,'live.sqlite'),backups=join(directory,'backups');
  await mkdir(backups,{mode:0o700});
  const db=new DatabaseSync(database);await chmod(database,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE documents(path TEXT PRIMARY KEY, content TEXT NOT NULL) STRICT;
    CREATE TABLE runtime_config(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE source_archives(path TEXT PRIMARY KEY, content BLOB NOT NULL) STRICT;
    CREATE TABLE store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
  db.prepare('INSERT INTO documents VALUES (?,?)').run('orders/fixture.json','{"amount":"1.00","status":"PAID"}\n');
  db.prepare('INSERT INTO documents VALUES (?,?)').run('events/fixture.json','{"attempts":0,"deliveredAt":null}\n');
  db.prepare('INSERT INTO runtime_config VALUES (?,?)').run('CHECKOUT_SECRET',fixtureSecret);
  db.prepare('INSERT INTO source_archives VALUES (?,?)').run('archive.bin',Buffer.from([0,255,1,128]));
  db.prepare('INSERT INTO store_meta VALUES (?,?)').run('source_revision','fixture-revision');
  try{await callback({directory,database,backups,db});}finally{db.close();await rm(directory,{recursive:true,force:true});}
}
async function run(database,output){
  try{const result=await execute('python3',[script,'--database',database,'--output',output]);return {status:0,...result};}
  catch(error){return {status:error.code,stdout:error.stdout||'',stderr:error.stderr||''};}
}

test('online backup includes committed WAL documents, outbox, config and binary archives while excluding an uncommitted transaction',async()=>withDatabase(async({database,backups,db})=>{
  assert.ok((await stat(database+'-wal')).size>0);
  db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO documents VALUES (?,?)').run('orders/uncommitted.json','{"status":"PENDING"}');
  const output=join(backups,'snapshot.sqlite');
  const result=await run(database,output);
  db.exec('ROLLBACK');
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
  assert.equal(result.stdout.includes(fixtureSecret),false);
  const report=JSON.parse(result.stdout);assert.equal(report.ok,true);assert.equal(report.integrity,'ok');assert.equal(report.tables,4);
  assert.equal(report.sha256,createHash('sha256').update(await readFile(output)).digest('hex'));
  assert.equal((await stat(output)).mode&0o777,0o600);assert.equal((await stat(backups)).mode&0o777,0o700);
  const restored=new DatabaseSync(output,{readOnly:true});
  try{
    assert.equal(restored.prepare('SELECT content FROM documents WHERE path=?').get('orders/fixture.json').content,'{"amount":"1.00","status":"PAID"}\n');
    assert.equal(restored.prepare('SELECT content FROM documents WHERE path=?').get('events/fixture.json').content,'{"attempts":0,"deliveredAt":null}\n');
    assert.equal(restored.prepare('SELECT value FROM runtime_config WHERE key=?').get('CHECKOUT_SECRET').value,fixtureSecret);
    assert.deepEqual(Buffer.from(restored.prepare('SELECT content FROM source_archives').get().content),Buffer.from([0,255,1,128]));
    assert.equal(restored.prepare('SELECT value FROM store_meta').get().value,'fixture-revision');
    assert.equal(restored.prepare('SELECT count(*) AS count FROM documents').get().count,2);
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{restored.close();}
  assert.deepEqual(await readdir(backups),['snapshot.sqlite']);
  assert.equal(db.prepare('SELECT count(*) AS count FROM documents').get().count,2);
}));

test('refuses overwrite and preserves all older backups',async()=>withDatabase(async({database,backups})=>{
  const output=join(backups,'existing.sqlite');await writeFile(output,'older-backup',{mode:0o600});
  await writeFile(join(backups,'another.sqlite'),'another-backup',{mode:0o600});
  const result=await run(database,output);
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr).error,'OUTPUT_ALREADY_EXISTS');
  assert.equal(await readFile(output,'utf8'),'older-backup');assert.equal(await readFile(join(backups,'another.sqlite'),'utf8'),'another-backup');
  assert.deepEqual((await readdir(backups)).sort(),['another.sqlite','existing.sqlite']);
}));

test('refuses source, destination and parent symlinks without following them',async()=>withDatabase(async({directory,database,backups})=>{
  const sourceLink=join(directory,'linked.sqlite'),output=join(backups,'copy.sqlite');await symlink(database,sourceLink);
  assert.equal(JSON.parse((await run(sourceLink,output)).stderr).error,'SYMLINK_PATH_REJECTED');
  const victim=join(directory,'victim.txt');await writeFile(victim,'unchanged');await symlink(victim,output);
  assert.equal(JSON.parse((await run(database,output)).stderr).error,'SYMLINK_PATH_REJECTED');
  assert.equal(await readFile(victim,'utf8'),'unchanged');
  const linkedDirectory=join(directory,'linked-backups');await symlink(backups,linkedDirectory);
  assert.equal(JSON.parse((await run(database,join(linkedDirectory,'new.sqlite'))).stderr).error,'SYMLINK_PATH_REJECTED');
}));

test('publishes only one complete backup when two processes target the same new path',async()=>withDatabase(async({database,backups})=>{
  const output=join(backups,'same.sqlite');
  const results=await Promise.all([run(database,output),run(database,output)]);
  assert.deepEqual(results.map(value=>value.status).sort(),[0,1]);
  assert.equal(JSON.parse(results.find(value=>value.status===1).stderr).error,'OUTPUT_ALREADY_EXISTS');
  const restored=new DatabaseSync(output,{readOnly:true});
  try{assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{restored.close();}
  assert.deepEqual(await readdir(backups),['same.sqlite']);
}));

test('rejects non-private directories and removes unpublished temporary files after corrupt input',async()=>withDatabase(async({directory,database,backups})=>{
  await chmod(backups,0o755);
  assert.equal(JSON.parse((await run(database,join(backups,'unsafe.sqlite'))).stderr).error,'OUTPUT_DIRECTORY_MUST_BE_PRIVATE');
  await chmod(backups,0o700);
  const corrupt=join(directory,'invalid.sqlite');await writeFile(corrupt,fixtureSecret);
  const result=await run(corrupt,join(backups,'invalid.sqlite'));
  assert.equal(result.status,1);assert.equal(result.stdout.includes(fixtureSecret)||result.stderr.includes(fixtureSecret),false);
  assert.deepEqual(await readdir(backups),[]);
}));
