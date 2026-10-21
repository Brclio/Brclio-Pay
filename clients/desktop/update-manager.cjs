'use strict';
const { createHash, verify, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const run = promisify(execFile);
const MAX_MANIFEST = 256 * 1024, MAX_PACKAGE = 2 * 1024 ** 3;
const fail = (message) => { throw new Error(message); };
function compareVersions(a, b) {
  const parse = (v) => { if (!/^\d+\.\d+\.\d+$/.test(v)) fail('版本格式无效'); const parts=v.split('.').map(Number);if(parts.some(n=>!Number.isSafeInteger(n)||n>2147483647))fail('版本格式无效');return parts; };
  const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1; return 0;
}
function assetUrl(value, settings, version) {
  try {
    const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash
      && u.hostname === 'github.com' && u.pathname.startsWith(`/${settings.repository}/releases/download/${settings.releaseTagPrefix}${version}/`)
      && u.pathname.split('/').length === 7 && !/%2f|%5c|%00/i.test(u.pathname);
  } catch { return false; }
}
function validateManifestEnvelope(bytes, key, settings) {
  const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  const keys=['darwin-arm64','darwin-x64','win32-x64','android-universal'];
  const decode=(value,max)=>{if(typeof value!=='string'||!value.length||value.length>Math.ceil(max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('更新签名格式无效');const data=Buffer.from(value,'base64');if(data.toString('base64')!==value)fail('更新签名格式无效');return data;};
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MANIFEST) fail('更新描述过大');
  let envelope; try { envelope = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { fail('更新描述无效'); }
  if (!exact(envelope,['schema','algorithm','payload','signature']) || envelope.schema !== 1 || envelope.algorithm !== 'RSA-SHA256') fail('更新签名格式无效');
  const payload = decode(envelope.payload,96000),signature=decode(envelope.signature,1024);
  if (!verify('RSA-SHA256', payload, key, signature)) fail('更新签名核验失败');
  let m; try { m = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payload)); } catch { fail('更新内容无效'); }
  if (!exact(m,['schema','product','applicationId','version','versionCode','publishedAt','releaseUrl','notes','platforms']) || m.schema !== 1 || m.product !== settings.productName || m.applicationId !== settings.applicationId
    || typeof m.version!=='string'||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(m.version)) fail('更新身份或格式不符');
  const parts=m.version.split('.').map(Number);
  if(parts.some((n,i)=>String(n)!==m.version.split('.')[i])||m.versionCode!==parts[0]*1000000+parts[1]*1000+parts[2]||m.versionCode<1)fail('更新版本格式不符');
  const time=Date.parse(m.publishedAt);
  if(typeof m.publishedAt!=='string'||!Number.isFinite(time)||new Date(time).toISOString()!==m.publishedAt||time>Date.now()+86400000||time<Date.UTC(2026,0,1))fail('更新发布时间无效');
  if(typeof m.notes!=='string'||m.notes.length<1||m.notes.length>12000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(m.notes))fail('更新说明无效');
  if (m.releaseUrl !== `https://github.com/${settings.repository}/releases/tag/${settings.releaseTagPrefix}${m.version}`) fail('发布来源不符');
  if(!exact(m.platforms,keys))fail('更新平台不完整');
  for (const platform of keys) {
    const files=m.platforms[platform];if(!exact(files,['update','installer']))fail('安装包描述无效');
    for (const role of ['update','installer']) {
      const type=platform.startsWith('darwin')?(role==='update'?'zip':'dmg'):(platform==='win32-x64'?'exe':'apk');
      const suffix=platform.startsWith('darwin')?`mac-${platform.slice(7)}.${type}`:(platform==='win32-x64'?'windows-x64-setup.exe':'android-universal.apk');
      const name=`Brclio-Pay-${m.version}-${suffix}`,file=files[role];
      if (!exact(file,['name','url','bytes','sha256','type']) || file.type !== type || file.name !== name
        || file.url!==`https://github.com/${settings.repository}/releases/download/${settings.releaseTagPrefix}${m.version}/${name}`
        || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_PACKAGE || typeof file.sha256!=='string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('安装包描述无效');
    }
    if((platform==='win32-x64'||platform==='android-universal')&&JSON.stringify(files.update)!==JSON.stringify(files.installer))fail('更新与安装包不一致');
  }
  return m;
}
function redirectAllowed(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port
    && ['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname); } catch { return false; }
}
async function request(value, { maximum, onChunk, redirects = 0, initial = true } = {}) {
  if (!initial && !redirectAllowed(value)) fail('更新下载跳转来源不允许');
  if (redirects > 5) fail('更新下载跳转过多');
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = https.get(value, { headers: { 'User-Agent':'Brclio-Pay-Client', Accept:'application/octet-stream', 'Cache-Control':'no-cache' }, timeout:30000 }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.resume();
        let target;try{if(typeof res.headers.location!=='string'||!res.headers.location)throw Error('missing redirect');target=new URL(res.headers.location,value).href;}catch{reject(new Error('更新下载跳转地址无效'));return;}
        request(target, { maximum, onChunk, redirects:redirects+1, initial:false }).then(resolve,reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`更新服务返回 HTTP ${res.statusCode}`)); return; }
      const length = Number(res.headers['content-length']);
      if (length > maximum) { res.destroy(); reject(new Error('下载超出大小限制')); return; }
      let received = 0; const chunks = [];
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > maximum) { res.destroy(new Error('下载超出大小限制')); return; }
        if (onChunk) { try { onChunk(chunk, received); } catch (e) { res.destroy(e); } } else chunks.push(chunk);
      });
      res.on('end', () => { settled = true; resolve(onChunk ? received : Buffer.concat(chunks)); });
      res.on('error', reject); res.on('aborted', () => { if (!settled) reject(new Error('下载连接中断')); });
    });
    req.on('timeout', () => req.destroy(new Error('下载连接超时'))); req.on('error',reject);
  });
}
async function downloadVerified(file, destination, onProgress = () => {}) {
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.part`;
  await fs.mkdir(path.dirname(destination), { recursive:true, mode:0o700 });
  const handle = await fs.open(temporary, 'wx', 0o600); const hash = createHash('sha256');
  try {
    const bytes = await request(file.url, { maximum:Math.min(file.bytes, MAX_PACKAGE), onChunk(chunk, received) {
      // Synchronous writes keep the network stream bounded without retaining a package in RAM.
      let offset=0;while(offset<chunk.length)offset+=require('node:fs').writeSync(handle.fd,chunk,offset,chunk.length-offset);hash.update(chunk); onProgress(received,file.bytes);
    }});
    await handle.sync(); await handle.close();
    if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) fail('安装包大小或 SHA-256 核验失败');
    await fs.rename(temporary,destination); return destination;
  } catch (error) { await handle.close().catch(()=>{}); await fs.rm(temporary,{force:true}); throw error; }
}
async function readBundle(bundle, settings, version, arch) {
  const stat = await fs.lstat(bundle); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('应用目录无效');
  const info = JSON.parse((await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(bundle,'Contents/Info.plist')],{timeout:30000})).stdout);
  if (info.CFBundleIdentifier !== settings.applicationId || info.CFBundleShortVersionString !== version || info.CFBundlePackageType !== 'APPL'
    || typeof info.CFBundleExecutable !== 'string' || !/^[^/\\\0\r\n]+$/.test(info.CFBundleExecutable)) fail('新应用身份或版本不符');
  const executable = path.join(bundle,'Contents/MacOS',info.CFBundleExecutable);
  if (!(await fs.lstat(executable)).isFile()) fail('应用执行文件无效');
  const architectures = (await run('/usr/bin/lipo',['-archs',executable],{timeout:30000})).stdout.trim().split(/\s+/);
  if (!architectures.includes(arch === 'arm64' ? 'arm64' : 'x86_64')) fail('新应用架构不符');
  await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{timeout:120000}); return info;
}
async function stageMac(archive, currentApp, settings, version, arch, work) {
  if (!currentApp.endsWith('.app') || (await fs.lstat(currentApp)).isSymbolicLink()) fail('当前安装目录不支持自动替换，请使用 DMG 安装');
  await fs.access(path.dirname(currentApp), require('node:fs').constants.W_OK);
  const listed = (await run('/usr/bin/unzip',['-Z1',archive],{timeout:30000,maxBuffer:8*1024*1024})).stdout.split('\n').filter(Boolean);
  if (!listed.length || listed.some(x => x.startsWith('/') || x.includes('\\') || x.split('/').includes('..'))) fail('ZIP 目录无效');
  await fs.mkdir(work,{recursive:true,mode:0o700});
  const staging = await fs.mkdtemp(path.join(path.dirname(currentApp),'.brclio-pay-update-')); await fs.chmod(staging,0o700);
  try {
    await run('/usr/bin/ditto',['-x','-k',archive,staging],{timeout:180000,maxBuffer:1024*1024});
    const entries = (await fs.readdir(staging)).filter(name => name !== '__MACOSX');
    if (entries.length !== 1 || !entries[0].endsWith('.app')) fail('ZIP 应用结构不符');
    const staged = path.join(staging,entries[0]); await readBundle(staged,settings,version,arch);
    const digest=await require('./mac-update-helper.cjs').bundleDigest(staged);
    const [a,b] = await Promise.all([fs.lstat(currentApp), fs.lstat(staged)]);
    return {current:currentApp, staged, staging, digest, currentInode:`${a.dev}:${a.ino}`, stagedInode:`${b.dev}:${b.ino}`, settings:{applicationId:settings.applicationId},version,arch,work};
  } catch(error) { await fs.rm(staging,{recursive:true,force:true}); throw error; }
}
class UpdateManager {
  constructor({ app, settings, key, publish, platform = process.platform, arch = process.arch }) {
    this.app=app; this.settings=settings; this.key=key; this.publish=publish; this.platform=platform; this.arch=arch;
    this.state={phase:'idle',currentVersion:app.getVersion(),message:'启动后自动检查新版本'}; this.busy=false;
  }
  set(value) { this.state={...this.state,...value}; this.publish(this.state); return this.state; }
  async check() {
    if(this.busy) return this.state; this.busy=true; this.set({phase:'checking',message:'正在核验更新描述的签名…',progress:0});
    try {
      let m, last;
      for(const url of [this.settings.updatesUrl,this.settings.fallbackUpdatesUrl]) {
        try { m=validateManifestEnvelope(await request(url,{maximum:MAX_MANIFEST}),this.key,this.settings); break; } catch(e) { last=e; }
      }
      if(!m) throw last;
      const entry=m.platforms[`${this.platform}-${this.arch}`]; if(!entry) fail('此架构暂无可用安装包');
      this.manifest=m; this.entry=entry;
      return this.set(compareVersions(m.version,this.app.getVersion())>0 ? {phase:'available',version:m.version,notes:m.notes,message:`发现新版本 ${m.version}`} : {phase:'latest',version:m.version,message:'已核验：当前已是最新版本'});
    }catch(e){ return this.set({phase:'error',message:`无法检查更新：${e.message}`}); }finally{this.busy=false;}
  }
  async download(installer=false) {
    if(this.busy || !this.entry || !this.manifest || compareVersions(this.manifest.version,this.app.getVersion())<=0) return this.state;
    this.busy=true; const file=installer ? this.entry.installer : this.entry.update;
    this.set({phase:'downloading',message:`正在下载 ${file.name}`,progress:0});
    try {
      const work=path.join(this.app.getPath('userData'),'updates',this.manifest.version);
      const target=await downloadVerified(file,path.join(work,file.name),(received,total)=>this.set({progress:Math.floor(received/total*100)}));
      this.downloaded={path:target,type:file.type,sha256:file.sha256,bytes:file.bytes};
      if(this.platform==='darwin' && file.type==='zip') {
        try {
          this.prepared=await stageMac(target,path.resolve(process.resourcesPath,'../..'),this.settings,this.manifest.version,this.arch,work);
          return this.set({phase:'ready',message:'签名与安装包已核验。退出后替换应用并重新打开。',progress:100});
        }catch(e){ this.prepared=null; return this.set({phase:'manual',message:`自动替换不可用：${e.message}。可下载已核验 DMG 手动安装。`,progress:100}); }
      }
      return this.set({phase:'ready',message:file.type==='dmg'?'DMG 已核验，可打开后拖入“应用程序”安装。':'安装包已核验。确认后退出并打开安装程序。',progress:100});
    }catch(e){ return this.set({phase:'error',message:`更新下载失败：${e.message}`}); }finally{this.busy=false;}
  }
  async verifyDownloaded() {
    if(!this.downloaded)fail('没有已核验的更新可安装');
    const stat=await fs.lstat(this.downloaded.path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==this.downloaded.bytes) fail('安装包在下载后发生改变');
    const h=createHash('sha256'), stream=require('node:fs').createReadStream(this.downloaded.path); for await(const chunk of stream)h.update(chunk);
    if(h.digest('hex')!==this.downloaded.sha256)fail('安装包在下载后发生改变');
  }
  async install() {
    if(this.busy || this.state.phase!=='ready' || !this.downloaded) fail('没有已核验的更新可安装');
    await this.verifyDownloaded();
    if(this.platform==='win32') {
      const child=spawn(this.downloaded.path,[],{detached:true,stdio:'ignore',windowsHide:false});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);}); child.unref(); this.app.quit(); return;
    }
    if(this.platform==='darwin' && this.prepared) {
      const work=this.prepared.work, helper=path.join(work,'install-helper.cjs'), config=path.join(work,'install.json');
      await fs.copyFile(path.join(__dirname,'mac-update-helper.cjs'),helper); await fs.chmod(helper,0o600);
      const plan={...this.prepared,parentPid:process.pid,currentVersion:this.app.getVersion(),executable:process.execPath};
      await fs.rm(path.join(work,'startup-confirmed.json'),{force:true});
      await fs.rm(path.join(work,'install-result.json'),{force:true});
      await fs.writeFile(config,JSON.stringify(plan),{mode:0o600});
      const child=spawn(process.execPath,[helper,config],{detached:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);}); child.unref();
      const deadline=Date.now()+10000;let ready=false;while(Date.now()<deadline){try{const r=JSON.parse(await fs.readFile(path.join(work,'install-result.json'),'utf8'));if(r.state==='waiting-for-exit'&&r.version===this.manifest.version){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
      if(!ready){try{child.kill();}catch{}fail('安装助手未就绪，未退出当前客户端');}
      this.app.quit(); return;
    }
    fail('请打开已核验的 DMG 完成安装');
  }
}
module.exports={MAX_MANIFEST,MAX_PACKAGE,compareVersions,assetUrl,validateManifestEnvelope,redirectAllowed,request,downloadVerified,stageMac,readBundle,UpdateManager};
