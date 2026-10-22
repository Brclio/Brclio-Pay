const test = process.env.VITEST ? (await import('vitest')).test : (await import('node:test')).default;
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {generateKeyPairSync,sign} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assetDefinitions,assetUrl as publishedAssetUrl,versionCode,verifyEnvelope} from '../clients/scripts/release-manifest.mjs';
const require=createRequire(import.meta.url);
const security=require('../clients/desktop/security.cjs');
const {compareVersions,assetUrl,validateManifestEnvelope,redirectAllowed,UpdateManager,MAX_MANIFEST}=require('../clients/desktop/update-manager.cjs');
const settings=JSON.parse(await fs.readFile(new URL('../clients/shared/release-settings.json',import.meta.url),'utf8'));
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
function manifest(version='1.1.0'){
  const platforms={};for(const [platform,definitions]of Object.entries(assetDefinitions(version))){platforms[platform]={};for(const [role,file]of Object.entries(definitions))platforms[platform][role]={name:file.name,url:publishedAssetUrl(settings,version,file.name),bytes:100,sha256:'a'.repeat(64),type:file.type};}
  return {schema:1,product:'Brclio Pay',applicationId:settings.applicationId,version,versionCode:versionCode(version),publishedAt:'2026-10-22T00:00:00.000Z',releaseUrl:`https://github.com/${settings.repository}/releases/tag/client-v${version}`,notes:'版本说明',platforms};
}
function envelope(value,key=privateKey){const payload=Buffer.from(JSON.stringify(value));return Buffer.from(JSON.stringify({schema:1,algorithm:'RSA-SHA256',payload:payload.toString('base64'),signature:sign('RSA-SHA256',payload,key).toString('base64')}));}
test('remote admin accepts only exact HTTPS origin/path and no query credentials or ports',()=>{
  assert.equal(security.remoteAdmin('https://pay.bornforthis.cn/admin#bills'),true);
  for(const u of ['http://pay.bornforthis.cn/admin','https://evil.test/admin','https://pay.bornforthis.cn.evil.test/admin','https://user@pay.bornforthis.cn/admin','https://pay.bornforthis.cn:8443/admin','https://pay.bornforthis.cn/api/admin/session','https://pay.bornforthis.cn/admin?redirect=evil'])assert.equal(security.remoteAdmin(u),false,u);
});
test('remote resource filter permits only own HTTPS and own blob downloads',()=>{
  assert(security.remoteResource('https://pay.bornforthis.cn/admin.js'));
  assert(security.remoteResource('blob:https://pay.bornforthis.cn/identifier'));
  for(const u of ['file:///etc/passwd','javascript:alert(1)','blob:https://evil.test/x','https://github.com/Brclio/Brclio-Pay','data:text/html,foo'])assert.equal(security.remoteResource(u),false);
});
test('IPC authenticates exact local main frame and denies remote or child frame',()=>{
  const shellPath=path.resolve('safe','shell.html'),frame={url:pathToFileURL(shellPath).href},wc={mainFrame:frame,isDestroyed:()=>false};
  assert(security.trustedShell({sender:wc,senderFrame:frame},wc,shellPath));
  assert.equal(security.trustedShell({sender:wc,senderFrame:{...frame}},wc,shellPath),false);
  assert.equal(security.trustedShell({sender:{},senderFrame:frame},wc,shellPath),false);
  frame.url='https://pay.bornforthis.cn/admin';assert.equal(security.trustedShell({sender:wc,senderFrame:frame},wc,shellPath),false);
});
test('valid signed manifest verifies exact identity and bounded package entries',()=>{
  const m=manifest(),signed=envelope(m);assert.deepEqual(verifyEnvelope(JSON.parse(signed.toString()),publicKey,settings),m);assert.deepEqual(validateManifestEnvelope(signed,publicKey,settings),m);
});
test('tampered payload, unsigned metadata and wrong trust key fail',()=>{
  const value=JSON.parse(envelope(manifest()).toString());const changed=manifest();changed.version='99.0.0';value.payload=Buffer.from(JSON.stringify(changed)).toString('base64');
  assert.throws(()=>validateManifestEnvelope(Buffer.from(JSON.stringify(value)),publicKey,settings),/签名核验失败/);
  assert.throws(()=>validateManifestEnvelope(Buffer.from(JSON.stringify(manifest())),publicKey,settings),/签名格式/);
  const other=generateKeyPairSync('rsa',{modulusLength:2048});assert.throws(()=>validateManifestEnvelope(envelope(manifest(),other.privateKey),publicKey,settings),/签名核验失败/);
});
test('signed manifests still reject wrong application, repository, type, hash and excessive size',()=>{
  for(const alter of [m=>m.applicationId='evil',m=>m.releaseUrl='https://evil.test/release',m=>m.platforms['darwin-arm64'].update.url='https://evil.test/app.zip',m=>m.platforms['darwin-arm64'].update.url=m.platforms['darwin-arm64'].update.url.replace('1.1.0/','9.0.0/'),m=>m.platforms['darwin-arm64'].update.type='exe',m=>m.platforms['darwin-arm64'].update.sha256='x'.repeat(64),m=>m.platforms['darwin-arm64'].update.bytes=2*1024**3+1,m=>m.platforms['win32-x64'].installer.name='../bad.exe']){
    const m=manifest();alter(m);assert.throws(()=>validateManifestEnvelope(envelope(m),publicKey,settings));
  }
  assert.throws(()=>validateManifestEnvelope(Buffer.alloc(MAX_MANIFEST+1),publicKey,settings),/过大/);
});
test('only fixed GitHub package URLs and approved asset redirects are accepted',()=>{
  assert(assetUrl(manifest().platforms['darwin-arm64'].update.url,settings,'1.1.0'));
  assert.equal(assetUrl('https://github.com/Other/Repo/releases/download/client-v1.1.0/app.zip',settings,'1.1.0'),false);
  assert.equal(assetUrl('https://github.com/Brclio/Brclio-Pay/releases/download/client-v1.1.0/a%2fb.zip',settings,'1.1.0'),false);
  for(const h of ['https://github.com/x','https://release-assets.githubusercontent.com/x','https://objects.githubusercontent.com/x'])assert(redirectAllowed(h));
  for(const h of ['http://github.com/x','https://github.com.evil.test/x','https://evil.test/x','https://user@github.com/x'])assert.equal(redirectAllowed(h),false);
});
test('semantic versions compare numerically and reject prerelease ambiguity',()=>{
  assert.equal(compareVersions('1.10.0','1.9.9'),1);assert.equal(compareVersions('1.0.0','1.0.0'),0);assert.equal(compareVersions('0.9.9','1.0.0'),-1);assert.throws(()=>compareVersions('1.0.0-beta','1.0.0'));
});
test('update state uses installed app version rather than shared build configuration',()=>{
  const app={getVersion:()=> '0.9.9'};const u=new UpdateManager({app,settings,key:publicKey,publish:()=>{}});assert.equal(u.state.currentVersion,'0.9.9');
});
test('file modified after download cannot be executed',async()=>{
  const work=await fs.mkdtemp(path.join(os.tmpdir(),'brclio-pay-update-test-'));
  try{const filename=path.join(work,'setup.exe');await fs.writeFile(filename,'tampered');
    const u=new UpdateManager({app:{getVersion:()=> '1.0.0'},settings,key:publicKey,publish:()=>{},platform:'win32'});
    u.state.phase='ready';u.downloaded={path:filename,type:'exe',bytes:8,sha256:'a'.repeat(64)};
    await assert.rejects(u.install(),/发生改变/);
  }finally{await fs.rm(work,{recursive:true,force:true});}
});
test('bundle digest detects changed bytes and symlink targets',async()=>{
  const {bundleDigest}=require('../clients/desktop/mac-update-helper.cjs');const work=await fs.mkdtemp(path.join(os.tmpdir(),'brclio-pay-bundle-'));
  try{await fs.writeFile(path.join(work,'file'),'one');const a=await bundleDigest(work);await fs.writeFile(path.join(work,'file'),'two');assert.notEqual(await bundleDigest(work),a);await fs.symlink('file',path.join(work,'link'));const b=await bundleDigest(work);await fs.unlink(path.join(work,'link'));await fs.symlink('other',path.join(work,'link'));assert.notEqual(await bundleDigest(work),b);}finally{await fs.rm(work,{recursive:true,force:true});}
});
test('desktop package includes only app source and public update trust resources',async()=>{
  const pkg=JSON.parse(await fs.readFile(new URL('../clients/desktop/package.json',import.meta.url),'utf8'));
  assert.equal(pkg.build.appId,settings.applicationId);assert.equal(pkg.build.win.signAndEditExecutable,true);assert.equal(pkg.build.win.forceCodeSigning,true);assert.equal(pkg.build.mac.identity,'-');
  assert.deepEqual(pkg.build.extraResources[0].filter,['release-settings.json','update-public-key.pem']);
  assert(!pkg.build.files.some(f=>/secrets|\.env|private-key/i.test(f)));
});
test('malformed HTTPS redirect rejects the request without escaping its promise',async()=>{
  const https=require('node:https'),{EventEmitter}=require('node:events'),original=https.get;
  https.get=(_url,_options,callback)=>{const req=new EventEmitter();process.nextTick(()=>{const res=new EventEmitter();res.statusCode=302;res.headers={location:'https://['};res.resume=()=>{};callback(res);});return req;};
  try{await assert.rejects(require('../clients/desktop/update-manager.cjs').request('https://github.com/Brclio/Brclio-Pay',{maximum:1000}),/跳转地址无效/);}finally{https.get=original;}
});
test('failed post-confirmation cleanup never reverses successful installation',async()=>{
  const {finishConfirmedInstall}=require('../clients/desktop/mac-update-helper.cjs'),attempts=[];
  await assert.doesNotReject(finishConfirmedInstall({staging:'/staging'},'/backup',async()=>{throw Error('journal read-only');},async target=>{attempts.push(target);throw Error('file locked');}));
  assert.deepEqual(attempts,['/backup','/staging']);
});
test('HTTP errors and unknown load status never report a healthy backend connection',()=>{
  assert.equal(security.connectionAfterLoad(200).phase,'ready');assert.equal(security.connectionAfterLoad(204).phase,'ready');
  for(const code of [400,401,404,500,503,null,undefined])assert.equal(security.connectionAfterLoad(code).phase,'error');
});
test('failed Mac validation reopens only the untouched original verified app',async()=>{
  const {recoverUntouched}=require('../clients/desktop/mac-update-helper.cjs');
  const c={current:'/Applications/Brclio Pay.app',currentInode:'1:2',currentVersion:'0.9.9',settings:{applicationId:'cn.bornforthis.brcliopay'}};
  const commands=[],states=[];
  const execute=async(command,args)=>{commands.push(command);return{stdout:command.endsWith('plutil')?JSON.stringify({CFBundleIdentifier:c.settings.applicationId,CFBundleShortVersionString:c.currentVersion}):''};};
  assert.equal(await recoverUntouched(c,async s=>states.push(s),{readInode:async()=>c.currentInode,execute}),true);
  assert.deepEqual(commands,['/usr/bin/plutil','/usr/bin/codesign','/usr/bin/open']);assert(states.includes('validation-failed-original-reopened'));
  commands.length=0;
  assert.equal(await recoverUntouched(c,async()=>{},{readInode:async()=> 'changed:inode',execute}),false);assert.deepEqual(commands,[]);
});
test('Mac installer manifest seals regular bytes, permissions and internal links',async()=>{
 const {makeManifest}=require('../clients/desktop/mac/after-sign.cjs'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'brclio-mac-install-manifest-'));
 try{await fs.mkdir(path.join(dir,'Contents'));await fs.writeFile(path.join(dir,'Contents','payload'),'version-one',{mode:0o644});await fs.symlink('Contents',path.join(dir,'linked'),'dir');
  const before=await makeManifest(dir);assert.match(before,/F\t[0-7]+\t[a-f0-9]{64}\tContents\/payload/);assert.match(before,/L\t[0-7]+\t[a-f0-9]{64}\tlinked/);
  await fs.writeFile(path.join(dir,'Contents','payload'),'version-two');assert.notEqual(await makeManifest(dir),before);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Mac installer manifest refuses outward links and hard-linked content',async()=>{
 const {makeManifest}=require('../clients/desktop/mac/after-sign.cjs'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'brclio-mac-install-paths-'));
 try{await fs.symlink('../outside',path.join(dir,'escape'));await assert.rejects(makeManifest(dir),/Unsafe application symlink/);await fs.unlink(path.join(dir,'escape'));
  await fs.writeFile(path.join(dir,'one'),'test');await fs.link(path.join(dir,'one'),path.join(dir,'two'));await assert.rejects(makeManifest(dir),/hard-linked/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
