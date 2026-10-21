'use strict';
// Executed from a private update directory in Electron's Node mode, after explicit install consent.
const fs = (process.versions.electron ? require('original-fs') : require('node:fs')).promises;
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify}=require('node:util');
const {createHash}=require('node:crypto');
const run=promisify(execFile), delay=ms=>new Promise(r=>setTimeout(r,ms));
function guiEnv() { const e={...process.env}; for(const k of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','ELECTRON_NO_ASAR']) delete e[k]; return e; }
async function inode(p) {const s=await fs.lstat(p); if(!s.isDirectory()||s.isSymbolicLink()) throw Error('invalid bundle'); return `${s.dev}:${s.ino}`;}
async function bundleDigest(root) {
  const hash=createHash('sha256');
  async function walk(dir) { for(const name of (await fs.readdir(dir)).sort()) {
    const p=path.join(dir,name),rel=path.relative(root,p),s=await fs.lstat(p); hash.update(rel+'\0'+(s.mode&0o777)+'\0');
    if(s.isSymbolicLink())hash.update('link\0'+await fs.readlink(p));
    else if(s.isDirectory()) {hash.update('dir\0');await walk(p);}
    else if(s.isFile()) {hash.update('file\0'); const h=await fs.open(p,'r');try {for await(const c of h.createReadStream({autoClose:false})) hash.update(c);}finally{await h.close();}}
    else throw Error('invalid file'); hash.update('\0');
  }}
  await walk(root);return hash.digest('hex');
}
async function finishConfirmedInstall(c,backup,status,remove=fs.rm){
  // Startup confirmation commits the new version. Cleanup must never enter rollback.
  await Promise.resolve().then(()=>status('installed')).catch(()=>{});
  for(const target of [backup,c.staging])await Promise.resolve().then(()=>remove(target,{recursive:true,force:true})).catch(()=>{});
}
async function recoverUntouched(c,status,{readInode=inode,execute=run}={}){
  await Promise.resolve().then(()=>status('validation-failed-original-retained')).catch(()=>{});
  try{
    if(await readInode(c.current)!==c.currentInode)return false;
    const info=JSON.parse((await execute('/usr/bin/plutil',['-convert','json','-o','-',path.join(c.current,'Contents/Info.plist')],{timeout:30000})).stdout);
    if(info.CFBundleIdentifier!==c.settings.applicationId||info.CFBundleShortVersionString!==c.currentVersion)return false;
    await execute('/usr/bin/codesign',['--verify','--deep','--strict',c.current],{timeout:120000});
    await execute('/usr/bin/open',['-n',c.current],{timeout:30000,env:guiEnv()});
    await Promise.resolve().then(()=>status('validation-failed-original-reopened')).catch(()=>{});return true;
  }catch{return false;}
}
async function main(configPath) {
  const c=JSON.parse(await fs.readFile(configPath,'utf8'));
  const backup=c.current+'.brclio-pay-rollback-'+Date.now(),failed=c.current+'.brclio-pay-failed-'+Date.now();
  const status=async state=>fs.writeFile(path.join(c.work,'install-result.json'),JSON.stringify({state,version:c.version,at:new Date().toISOString()}),{mode:0o600});
  const alive=()=>{try{process.kill(c.parentPid,0);return true;}catch{return false;}};
  await status('waiting-for-exit'); const until=Date.now()+120000; while(alive()){if(Date.now()>until)throw Error('parent did not exit');await delay(100);}
  let info;
  try{
    if(await inode(c.current)!==c.currentInode||await inode(c.staged)!==c.stagedInode||await bundleDigest(c.staged)!==c.digest) throw Error('bundle changed');
    info=JSON.parse((await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(c.staged,'Contents/Info.plist')],{timeout:30000})).stdout);
    if(info.CFBundleIdentifier!==c.settings.applicationId||info.CFBundleShortVersionString!==c.version)throw Error('identity changed');
    await run('/usr/bin/codesign',['--verify','--deep','--strict',c.staged],{timeout:120000});
    await status('replacing');await fs.rename(c.current,backup);
  }catch(error){await recoverUntouched(c,status);throw error;}
  let placed=false;
  try{
    await fs.rename(c.staged,c.current);placed=true;
    if(await inode(c.current)!==c.stagedInode)throw Error('replacement changed');
    await run('/usr/bin/open',['-n',c.current],{timeout:30000,env:guiEnv()});
    // The new app acknowledges only after its own local shell is ready.
    const confirmation=path.join(c.work,'startup-confirmed.json'),deadline=Date.now()+60000;let confirmed=false;
    while(Date.now()<deadline){try{const r=JSON.parse(await fs.readFile(confirmation,'utf8'));if(r.version===c.version&&r.applicationId===c.settings.applicationId&&r.currentInode===c.stagedInode){confirmed=true;break;}}catch{}await delay(250);}
    if(!confirmed)throw Error('startup not confirmed');
  }catch(error){
    if(placed){
      // Stop only executables from this exact replaced bundle before rollback.
      const executable=path.join(c.current,'Contents/MacOS',info.CFBundleExecutable);
      const {stdout}=await run('/bin/ps',['-axo','pid=,comm='],{timeout:10000});
      for(const line of stdout.split('\n')) {const m=line.match(/^\s*(\d+)\s+(.+)$/);if(m&&m[2]===executable&&Number(m[1])!==process.pid&&Number(m[1])!==c.parentPid){try{process.kill(Number(m[1]),'SIGTERM');}catch{}}}
      await delay(1500); if(await inode(c.current)!==c.stagedInode)throw Error('rollback blocked');await fs.rename(c.current,failed);
    }
    if(await inode(backup)!==c.currentInode)throw Error('rollback copy changed');await fs.rename(backup,c.current);
    await status('rolled-back');await run('/usr/bin/open',['-n',c.current],{timeout:30000,env:guiEnv()}).catch(()=>{});throw error;
  }
  await finishConfirmedInstall(c,backup,status);
}
if(require.main===module) main(process.argv[2]).catch(()=>{process.exitCode=1;});
module.exports={bundleDigest,finishConfirmedInstall,recoverUntouched};
