// Brclio Pay release trust root. This public key is intentionally distributable.
export const UPDATE_PUBLIC_KEY=`-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAhgieO0Lx1ECx3Lj4s1d8
T36s3QzwLdPlBCjuueyhFY3T1dnByi/nikyJIS+hwjplPcT00aQYz5V4Rcj/Kmnd
j2AYk7X/f1NrPBkFBJp9oYVMPWSLtuF/vXFbqFqvoKAOqCm2+cT+HUEzW5mkk/9r
XWPNNCNVTptnv6SF7LSp6M6L2QfdxuANA1UwaINw/3q1QTYh7BFFB6WNVjGdfhrm
zDYNkFuLKKBMau0YswbfTnZtsYGEzy0vOC+iX3VRJ+1MWgl+lXZAO3pcd9RF0sve
p9SAiEAS7PWbCxAI7Qft6xYfruBdeV3B8xU9+xkt59Jj0afJ3463agyTFzvYTBDm
UgEBUXKKsuKA1rrGKgijP2HnTQhEiXcos7rY6wzAMIzPLeweX4AA7S79blcF6jlN
rTirJ/La4XfjVvz9hNeM5YtQEXHFceUxO7HnBdNHBcf5kj9xQg4ipgrAJ9spgUOd
34fW6HBcgqKvpGXBIj0d8ktG+OJcfSwxiIxtfErkomilAgMBAAE=
-----END PUBLIC KEY-----`;
const platforms=['darwin-arm64','darwin-x64','win32-x64','android-universal'];
const labels={'darwin-arm64':'Mac · Apple 芯片','darwin-x64':'Mac · Intel 芯片','win32-x64':'Windows · 64 位','android-universal':'Android · 通用 APK'};
const fail=message=>{throw Error(message);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function browserVersionCode(version) {if(typeof version!=='string'||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version))fail('版本格式不正确');const parts=version.split('.').map(Number);if(parts.some((n,i)=>String(n)!==version.split('.')[i]))fail('版本格式不正确');return parts[0]*1000000+parts[1]*1000+parts[2];}
function base64(value,max) {if(typeof value!=='string'||!value.length||value.length>Math.ceil(max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('发布签名编码不正确');const decoded=atob(value);if(btoa(decoded)!==value)fail('发布签名编码不正确');return Uint8Array.from(decoded,char=>char.charCodeAt(0));}
export function validateBrowserManifest(value,{minimumVersionCode=1,now=Date.now()}={}) {
  if(!exact(value,['schema','product','applicationId','version','versionCode','publishedAt','releaseUrl','notes','platforms'])||value.schema!==1||value.product!=='Brclio Pay'||value.applicationId!=='cn.bornforthis.brcliopay')fail('发布信息不属于 Brclio Pay');
  const code=browserVersionCode(value.version);if(code!==value.versionCode||code<minimumVersionCode)fail('版本信息不一致或发生回退');
  const time=Date.parse(value.publishedAt);if(typeof value.publishedAt!=='string'||!Number.isFinite(time)||new Date(time).toISOString()!==value.publishedAt||time<Date.UTC(2026,0,1)||time>now+86400000)fail('发布时间不正确');
  if(value.releaseUrl!==`https://github.com/Brclio/Brclio-Pay/releases/tag/client-v${value.version}`||typeof value.notes!=='string'||!value.notes.length||value.notes.length>12000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.notes)||!exact(value.platforms,platforms))fail('发布说明或平台不完整');
  const suffixes={'darwin-arm64':{update:'mac-arm64.zip',installer:'mac-arm64.dmg'},'darwin-x64':{update:'mac-x64.zip',installer:'mac-x64.dmg'},'win32-x64':{update:'windows-x64-setup.exe',installer:'windows-x64-setup.exe'},'android-universal':{update:'android-universal.apk',installer:'android-universal.apk'}};
  for(const platform of platforms) {
    if(!exact(value.platforms[platform],['update','installer']))fail('安装包信息不完整');
    for(const purpose of ['update','installer']) {
      const asset=value.platforms[platform][purpose],name=`Brclio-Pay-${value.version}-${suffixes[platform][purpose]}`;
      if(!exact(asset,['name','url','bytes','sha256','type'])||asset.name!==name||asset.url!==`https://github.com/Brclio/Brclio-Pay/releases/download/client-v${value.version}/${name}`||asset.type!==name.split('.').pop()||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>2147483648||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256))fail('下载地址或文件校验信息不正确');
    }
  }
  for(const platform of ['win32-x64','android-universal'])if(JSON.stringify(value.platforms[platform].update)!==JSON.stringify(value.platforms[platform].installer))fail('安装包与更新文件不一致');
  return value;
}
export function validateBrowserInstallation(value,{expectedVersion}={}) {
  if(!exact(value,['schema','product','applicationId','version','releaseUrl','windows','assets'])||value.schema!==1||value.product!=='Brclio Pay'||value.applicationId!=='cn.bornforthis.brcliopay')fail('安装说明不属于 Brclio Pay');
  if(browserVersionCode(value.version)<1000001||value.version!==expectedVersion||value.releaseUrl!==`https://github.com/Brclio/Brclio-Pay/releases/tag/client-v${value.version}`)fail('安装说明版本不一致');
  const cert=value.windows;
  if(!exact(cert,['schema','publisher','subject','certificateAssetName','certificateSha256','certificateThumbprintSha1','notBefore','notAfter','selfSigned','keyAlgorithm','keyBits','usage'])||cert.schema!==1||cert.publisher!=='Brclio Pay'||typeof cert.subject!=='string'||!cert.subject.length||cert.subject.length>300||/[\u0000-\u0009\u000b-\u001f]/.test(cert.subject)||cert.certificateAssetName!=='Brclio-Pay-Windows-Code-Signing.cer'||!/^[a-f0-9]{64}$/.test(cert.certificateSha256)||!/^[A-F0-9]{40}$/.test(cert.certificateThumbprintSha1)||cert.selfSigned!==true||cert.keyAlgorithm!=='RSA'||cert.keyBits!==3072||cert.usage!=='codeSigning')fail('Windows 证书信息不正确');
  for(const name of ['notBefore','notAfter'])if(typeof cert[name]!=='string'||!Number.isFinite(Date.parse(cert[name]))||new Date(cert[name]).toISOString()!==cert[name])fail('证书有效期不正确');
  if(Date.parse(cert.notAfter)<=Date.parse(cert.notBefore)||!exact(value.assets,['certificate','guide']))fail('证书或安装说明不完整');
  const names={certificate:['Brclio-Pay-Windows-Code-Signing.cer','cer'],guide:['Brclio-Pay-Windows-Signing.md','md']};
  for(const [purpose,[name,type]]of Object.entries(names)) {const asset=value.assets[purpose];if(!exact(asset,['name','type','url','bytes','sha256'])||asset.name!==name||asset.type!==type||asset.url!==`https://github.com/Brclio/Brclio-Pay/releases/download/client-v${value.version}/${name}`||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>1024*1024||!/^[a-f0-9]{64}$/.test(asset.sha256))fail('安装支持文件地址或摘要不正确');}
  if(value.assets.certificate.sha256!==cert.certificateSha256)fail('证书摘要不一致');
  return value;
}
async function verifyBrowserSignedPayload(envelope,{publicKey=UPDATE_PUBLIC_KEY,cryptoApi=globalThis.crypto}={},validate) {
  if(!exact(envelope,['schema','algorithm','payload','signature'])||envelope.schema!==1||envelope.algorithm!=='RSA-SHA256')fail('发布信息缺少有效签名');
  const payload=base64(envelope.payload,96000),signature=base64(envelope.signature,1024);
  const keyBytes=base64(publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,''),4096);
  const key=await cryptoApi.subtle.importKey('spki',keyBytes,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  if(!await cryptoApi.subtle.verify('RSASSA-PKCS1-v1_5',key,signature,payload))fail('发布信息的签名验证失败');
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payload));}catch{fail('发布信息无法读取');}
  return validate(value);
}
export async function verifyBrowserEnvelope(envelope,options={}) {return verifyBrowserSignedPayload(envelope,options,value=>validateBrowserManifest(value,options));}
export async function verifyBrowserInstallationEnvelope(envelope,options={}) {return verifyBrowserSignedPayload(envelope,options,value=>validateBrowserInstallation(value,options));}
function disableInstallation() {for(const id of ['windowsCertificate','windowsSigningGuide']){const link=document.getElementById(id);link.removeAttribute('href');link.setAttribute('aria-disabled','true');}document.getElementById('windowsSigningIdentity').replaceChildren();document.getElementById('installationState').textContent='先核验本版发布信息，再显示证书下载。';}
function disableDownloads() {for(const link of document.querySelectorAll('.download-link')){link.removeAttribute('href');link.setAttribute('aria-disabled','true');link.textContent=`${labels[link.dataset.platform]} · 等待发布`;}document.getElementById('releaseDetails').hidden=true;disableInstallation();}
async function checkInstallationSupport(release) {
  disableInstallation();const state=document.getElementById('installationState');
  if(release.versionCode<1000001){state.textContent='Windows 自签证书与辅助安装说明从 1.0.1 起提供。';return;}
  state.textContent='正在核验本版证书与安装说明…';
  try {
    const response=await fetch('/client-installation.json',{cache:'no-store',credentials:'omit',redirect:'error'});
    if(!response.ok||!(response.headers.get('content-type')||'').includes('json'))fail('暂时无法读取本版安装支持文件');
    const text=await response.text();if(text.length>140000)fail('安装支持信息过大');
    const support=await verifyBrowserInstallationEnvelope(JSON.parse(text),{expectedVersion:release.version});
    for(const [id,purpose]of [['windowsCertificate','certificate'],['windowsSigningGuide','guide']]){const link=document.getElementById(id);link.href=support.assets[purpose].url;link.setAttribute('aria-disabled','false');link.rel='noreferrer';}
    const identity=document.getElementById('windowsSigningIdentity');
    for(const [label,value]of [['公钥证书 SHA-256',support.windows.certificateSha256],['证书 SHA-1 指纹（仅定位）',support.windows.certificateThumbprintSha1]]) {
      const p=document.createElement('p'),strong=document.createElement('strong'),code=document.createElement('code'),copy=document.createElement('button');strong.textContent=label;code.textContent=`${value.slice(0,16)}…${value.slice(-12)}`;code.title=value;code.setAttribute('aria-label',value);
      copy.className='copy-fingerprint';copy.type='button';copy.textContent='复制完整指纹';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(value);state.textContent=`已复制${label}的完整指纹`;}catch{code.textContent=value;state.textContent='未能自动复制，已展开完整指纹，可手动选择复制。';}});p.append(strong,code,copy);identity.append(p);
    }
    state.textContent=`${support.version} 安装支持签名已核验 · 自签证书需要你主动建立信任`;
  } catch(error) {disableInstallation();state.textContent=`${error.message||'安装支持核验失败'}。证书下载暂不可用，请重新检查版本。`;}
}
async function checkRelease() {
  const state=document.getElementById('releaseState'),button=document.getElementById('checkRelease');button.disabled=true;state.textContent='正在验证发布信息…';
  try {
    const response=await fetch('/client-update.json',{cache:'no-store',credentials:'omit',redirect:'error'});
    if(response.status===404){disableDownloads();state.textContent='尚无可用发布。请稍后重新检查，或先使用网页管理。';return;}
    if(!response.ok||!(response.headers.get('content-type')||'').includes('json'))fail('暂时无法读取发布信息');
    const text=await response.text();if(text.length>140000)fail('发布信息大小不正确');
    let minimum=1;try{const saved=Number(localStorage.getItem('brcliopay:lastVerifiedClientVersion'));if(Number.isSafeInteger(saved)&&saved>0)minimum=saved;}catch{}
    const value=await verifyBrowserEnvelope(JSON.parse(text),{minimumVersionCode:minimum});
    try{localStorage.setItem('brcliopay:lastVerifiedClientVersion',String(value.versionCode));}catch{}
    state.textContent=`版本 ${value.version} · ${new Date(value.publishedAt).toLocaleDateString('zh-CN')} · 发布签名已核验`;
    for(const link of document.querySelectorAll('.download-link')) {const asset=value.platforms[link.dataset.platform].installer;link.href=asset.url;link.setAttribute('aria-disabled','false');link.rel='noreferrer';link.textContent=`${labels[link.dataset.platform]} ↓`;}
    document.getElementById('releaseNotes').textContent=value.notes;
    const hashes=document.getElementById('releaseHashes');hashes.replaceChildren();
    for(const platform of platforms) {const asset=value.platforms[platform].installer,p=document.createElement('p'),label=document.createElement('strong'),digest=document.createElement('code');label.textContent=`${asset.name} · ${(asset.bytes/1024/1024).toFixed(1)} MB`;digest.textContent=`SHA-256 ${asset.sha256}`;p.append(label,digest);hashes.append(p);}
    const release=document.getElementById('releaseLink');release.href=value.releaseUrl;document.getElementById('releaseDetails').hidden=false;
    await checkInstallationSupport(value);
  } catch(error) {disableDownloads();state.textContent=`${error.message||'版本检查失败'}。请稍后重试。`;}
  finally {button.disabled=false;}
}
if(typeof document!=='undefined') {document.getElementById('checkRelease')?.addEventListener('click',checkRelease);checkRelease();}
