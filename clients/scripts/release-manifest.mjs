import {createHash,createPrivateKey,createPublicKey,sign,verify,X509Certificate} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';

export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const PLATFORM_KEYS=['darwin-arm64','darwin-x64','win32-x64','android-universal'];
export const INSTALLATION_ASSETS={certificate:{name:'Brclio-Pay-Windows-Code-Signing.cer',type:'cer'},guide:{name:'Brclio-Pay-Windows-Signing.md',type:'md'}};
export const SIGNING_IDENTITY_KEYS=['publisher','subject','certificateAssetName','certificateSha256','certificateThumbprintSha1','notBefore','notAfter','selfSigned','keyAlgorithm','keyBits','usage'];
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>{throw Error(message);};
const exactKeys=(object,keys)=>plain(object)&&Object.keys(object).length===keys.length&&keys.every(key=>Object.hasOwn(object,key));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function versionParts(version) {
  if(typeof version!=='string'||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version))fail('Invalid client version');
  const values=version.split('.').map(Number);
  if(values.some((value,index)=>String(value)!==version.split('.')[index]))fail('Noncanonical client version');
  return values;
}
export function versionCode(version) {const [major,minor,patch]=versionParts(version);return major*1000000+minor*1000+patch;}
export function compareVersions(left,right) {const a=versionParts(left),b=versionParts(right);for(let i=0;i<3;i++)if(a[i]!==b[i])return Math.sign(a[i]-b[i]);return 0;}
export function assetDefinitions(version) {
  versionParts(version);
  const name=(suffix)=>`Brclio-Pay-${version}-${suffix}`;
  return {
    'darwin-arm64':{update:{name:name('mac-arm64.zip'),type:'zip'},installer:{name:name('mac-arm64.dmg'),type:'dmg'}},
    'darwin-x64':{update:{name:name('mac-x64.zip'),type:'zip'},installer:{name:name('mac-x64.dmg'),type:'dmg'}},
    'win32-x64':{update:{name:name('windows-x64-setup.exe'),type:'exe'},installer:{name:name('windows-x64-setup.exe'),type:'exe'}},
    'android-universal':{update:{name:name('android-universal.apk'),type:'apk'},installer:{name:name('android-universal.apk'),type:'apk'}}
  };
}
export function releaseUrl(settings,version=settings.version) {return `https://github.com/${settings.repository}/releases/tag/${settings.releaseTagPrefix}${version}`;}
export function assetUrl(settings,version,name) {return `https://github.com/${settings.repository}/releases/download/${settings.releaseTagPrefix}${version}/${name}`;}
export function requiresInstallationSupport(version) {return compareVersions(version,'1.0.1')>=0;}
export function validateSigningIdentity(identity) {
  if(!exactKeys(identity,['schema',...SIGNING_IDENTITY_KEYS])||identity.schema!==1||identity.publisher!=='Brclio Pay'||typeof identity.subject!=='string'||identity.subject.length<1||identity.subject.length>300||/[\u0000-\u0009\u000b-\u001f]/.test(identity.subject))fail('Invalid Windows signing identity');
  if(identity.certificateAssetName!==INSTALLATION_ASSETS.certificate.name||!/^[a-f0-9]{64}$/.test(identity.certificateSha256)||!/^[A-F0-9]{40}$/.test(identity.certificateThumbprintSha1)||identity.selfSigned!==true||identity.keyAlgorithm!=='RSA'||identity.keyBits!==3072||identity.usage!=='codeSigning')fail('Invalid Windows self-signed certificate identity');
  for(const field of ['notBefore','notAfter'])if(typeof identity[field]!=='string'||!Number.isFinite(Date.parse(identity[field]))||new Date(identity[field]).toISOString()!==identity[field])fail('Invalid signing certificate validity');
  if(Date.parse(identity.notAfter)<=Date.parse(identity.notBefore))fail('Invalid signing certificate lifetime');
  return identity;
}
export function validateInstallationManifest(manifest,settings,{expectedVersion}={}) {
  if(!exactKeys(manifest,['schema','product','applicationId','version','releaseUrl','windows','assets'])||manifest.schema!==1||manifest.product!==settings.productName||manifest.applicationId!==settings.applicationId)fail('Invalid installation support identity');
  versionParts(manifest.version);if(!requiresInstallationSupport(manifest.version)||(expectedVersion&&manifest.version!==expectedVersion)||manifest.releaseUrl!==releaseUrl(settings,manifest.version))fail('Installation support release mismatch');
  validateSigningIdentity(manifest.windows);
  if(!exactKeys(manifest.assets,Object.keys(INSTALLATION_ASSETS)))fail('Incomplete installation support assets');
  for(const [purpose,definition]of Object.entries(INSTALLATION_ASSETS)) {
    const asset=manifest.assets[purpose];
    if(!exactKeys(asset,['name','type','url','bytes','sha256'])||asset.name!==definition.name||asset.type!==definition.type||asset.url!==assetUrl(settings,manifest.version,definition.name)||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>1024*1024||!/^[a-f0-9]{64}$/.test(asset.sha256))fail('Invalid installation support asset');
  }
  if(manifest.assets.certificate.sha256!==manifest.windows.certificateSha256)fail('Installation certificate digest mismatch');
  return manifest;
}
export async function stageInstallationAssets({directory,root=ROOT,settings,write=false}) {
  if(!requiresInstallationSupport(settings.version))return null;
  let certificate,identity,template;
  try {certificate=await readFile(resolve(root,'clients/shared/windows-signing-certificate.cer'));identity=validateSigningIdentity(JSON.parse(await readFile(resolve(root,'clients/shared/windows-signing-identity.json'),'utf8')));template=await readFile(resolve(root,'docs/clients-windows-signing.md'),'utf8');}catch(error){if(error.code==='ENOENT')fail('Missing reviewed Windows certificate, identity or installation guide');throw error;}
  const cert=new X509Certificate(certificate),publicKey=cert.publicKey;
  if(cert.raw.length!==certificate.length||sha(certificate)!==identity.certificateSha256||cert.fingerprint.replaceAll(':','')!==identity.certificateThumbprintSha1||cert.subject!==identity.subject||cert.issuer!==cert.subject||!cert.verify(publicKey)||cert.ca||publicKey.asymmetricKeyType!=='rsa'||publicKey.asymmetricKeyDetails?.modulusLength!==identity.keyBits||!cert.keyUsage?.includes('1.3.6.1.5.5.7.3.3')||new Date(cert.validFrom).toISOString()!==identity.notBefore||new Date(cert.validTo).toISOString()!==identity.notAfter)fail('Windows public certificate does not match the reviewed signing identity');
  const guide=template.replaceAll('@@CERT_SHA256@@',identity.certificateSha256).replaceAll('@@CERT_SHA1@@',identity.certificateThumbprintSha1).replaceAll('@@VERSION@@',settings.version).replaceAll('@@SUBJECT@@',identity.subject);
  if(/@@[A-Z0-9_]+@@/.test(guide))fail('Unresolved installation guide placeholder');
  const contents={[INSTALLATION_ASSETS.certificate.name]:certificate,[INSTALLATION_ASSETS.guide.name]:Buffer.from(guide)};
  if(write)await mkdir(directory,{recursive:true});
  for(const [name,bytes]of Object.entries(contents)) {
    if(write)await writeFile(resolve(directory,name),bytes);
    else {let actual;try{actual=await readFile(resolve(directory,name));}catch{fail(`Missing staged installation support asset: ${name}`);}if(!actual.equals(bytes))fail(`Installation support asset differs from reviewed source: ${name}`);}
  }
  return {identity,contents};
}
export function validateManifest(manifest,settings,{currentVersion,expectedVersion,now=Date.now()}={}) {
  if(!exactKeys(manifest,['schema','product','applicationId','version','versionCode','publishedAt','releaseUrl','notes','platforms']))fail('Invalid release manifest shape');
  if(manifest.schema!==1||manifest.product!==settings.productName||manifest.applicationId!==settings.applicationId)fail('Release product identity mismatch');
  versionParts(manifest.version);
  if(expectedVersion&&manifest.version!==expectedVersion)fail('Release version mismatch');
  if(currentVersion&&compareVersions(manifest.version,currentVersion)<0)fail('Release rollback rejected');
  if(manifest.versionCode!==versionCode(manifest.version)||manifest.versionCode<1)fail('Release version code mismatch');
  const time=Date.parse(manifest.publishedAt);
  if(typeof manifest.publishedAt!=='string'||!Number.isFinite(time)||new Date(time).toISOString()!==manifest.publishedAt||time>now+86400000||time<Date.UTC(2026,0,1))fail('Invalid release publication time');
  if(manifest.releaseUrl!==releaseUrl(settings,manifest.version))fail('Release URL mismatch');
  if(typeof manifest.notes!=='string'||manifest.notes.length<1||manifest.notes.length>12000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(manifest.notes))fail('Invalid release notes');
  if(!exactKeys(manifest.platforms,PLATFORM_KEYS))fail('Incomplete release platform set');
  const definitions=assetDefinitions(manifest.version);
  for(const platform of PLATFORM_KEYS) {
    if(!exactKeys(manifest.platforms[platform],['update','installer']))fail('Invalid platform assets');
    for(const purpose of ['update','installer']) {
      const asset=manifest.platforms[platform][purpose],expected=definitions[platform][purpose];
      if(!exactKeys(asset,['name','url','bytes','sha256','type'])||asset.name!==expected.name||asset.type!==expected.type)fail('Release asset identity mismatch');
      if(asset.url!==assetUrl(settings,manifest.version,expected.name))fail('Untrusted release asset URL');
      if(!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>2147483648||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256))fail('Invalid release asset integrity');
    }
  }
  for(const platform of ['win32-x64','android-universal'])if(JSON.stringify(manifest.platforms[platform].update)!==JSON.stringify(manifest.platforms[platform].installer))fail('Platform installer/update mismatch');
  return manifest;
}
function decodeBase64(value,maxBytes) {
  if(typeof value!=='string'||value.length===0||value.length>Math.ceil(maxBytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('Invalid signed release encoding');
  const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)fail('Noncanonical signed release encoding');return bytes;
}
function verifySignedPayload(envelope,publicKey,validate) {
  if(!exactKeys(envelope,['schema','algorithm','payload','signature'])||envelope.schema!==1||envelope.algorithm!=='RSA-SHA256')fail('Invalid signed release envelope');
  const payload=decodeBase64(envelope.payload,96000),signature=decodeBase64(envelope.signature,1024);
  if(!verify('RSA-SHA256',payload,publicKey,signature))fail('Release signature verification failed');
  let manifest;try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payload));}catch{fail('Invalid signed release JSON');}
  return validate(manifest);
}
export function verifyEnvelope(envelope,publicKey,settings,options={}) {return verifySignedPayload(envelope,publicKey,value=>validateManifest(value,settings,options));}
export function verifyInstallationEnvelope(envelope,publicKey,settings,options={}) {return verifySignedPayload(envelope,publicKey,value=>validateInstallationManifest(value,settings,options));}
function signPayload(manifest,privateKey,publicKey,validate) {
  validate(manifest);
  const privateObject=createPrivateKey(privateKey),publicObject=createPublicKey(privateObject);
  if(publicObject.asymmetricKeyType!=='rsa'||(publicObject.asymmetricKeyDetails?.modulusLength||0)<3072||publicObject.export({type:'spki',format:'pem'})!==createPublicKey(publicKey).export({type:'spki',format:'pem'}))fail('Release signing key mismatch');
  const bytes=Buffer.from(JSON.stringify(manifest));
  const envelope={schema:1,algorithm:'RSA-SHA256',payload:bytes.toString('base64'),signature:sign('RSA-SHA256',bytes,privateObject).toString('base64')};
  verifySignedPayload(envelope,publicKey,validate);return envelope;
}
export function signManifest(manifest,privateKey,publicKey,settings,options={}) {return signPayload(manifest,privateKey,publicKey,value=>validateManifest(value,settings,options));}
export function signInstallationManifest(manifest,privateKey,publicKey,settings,options={}) {return signPayload(manifest,privateKey,publicKey,value=>validateInstallationManifest(value,settings,options));}
export async function inspectAssets(directory,settings) {
  const definitions=assetDefinitions(settings.version),names=[...new Set(Object.values(definitions).flatMap(p=>Object.values(p).map(a=>a.name))),...(requiresInstallationSupport(settings.version)?Object.values(INSTALLATION_ASSETS).map(a=>a.name):[])],assets={};
  for(const name of names) {
    const path=resolve(directory,name);let stat;try{stat=await lstat(path);}catch{fail(`Missing release asset: ${name}`);}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>2147483648)fail(`Invalid release asset: ${name}`);
    const bytes=await readFile(path);assets[name]={bytes:bytes.length,sha256:sha(bytes)};
    if(/\.(zip|apk)$/.test(name)) {
      const listing=spawnSync('unzip',['-Z1',path],{encoding:'utf8',maxBuffer:8*1024*1024});
      if(listing.status!==0)fail(`Invalid ZIP/APK container: ${name}`);
      const entries=listing.stdout.trim().split('\n');
      if(entries.some(entry=>entry.startsWith('/')||entry.split('/').includes('..')||/(^|\/)(secrets|\.git|\.env(?:\.[^/]+)?|runtime-vars\.json|[^/]*private-key[^/]*\.pem|[^/]+\.(?:pfx|p12|jks|keystore))(\/|$)/i.test(entry)))fail(`Forbidden archive entry: ${name}`);
    }
  }
  return assets;
}
export async function auditSource(root=ROOT) {
  const git=(args)=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});if(result.status!==0)fail('Source Git audit failed');return result.stdout;};
  if(git(['status','--porcelain','--untracked-files=all']).trim())fail('Release requires a clean committed source tree');
  const revision=git(['rev-parse','HEAD']).trim();if(!/^[a-f0-9]{40}$/.test(revision))fail('Invalid source revision');
  const files=git(['ls-files','-z']).split('\0').filter(Boolean);
  if(files.some(path=>/(^|\/)(secrets|\.env(?:\.[^/]+)?|runtime-vars\.json|[^/]*private-key[^/]*\.pem|[^/]+\.(?:pfx|p12|jks|keystore))(\/|$)/i.test(path)))fail('Forbidden tracked source file');
  const values=[];
  try {
    const runtime=JSON.parse(await readFile(resolve(root,'secrets/runtime-vars.json'),'utf8'));
    const walk=(value,key='')=>{if(typeof value==='string'&&value.length>=16&&/(secret|private|token|password|session|api.?v3.?key)/i.test(key))values.push(value);else if(plain(value))for(const [name,entry]of Object.entries(value))walk(entry,name);};walk(runtime);
  }catch(error){if(error.code!=='ENOENT')fail('Local credential audit input is invalid');}
  for(const path of files) {
    const content=await readFile(resolve(root,path));
    if(values.some(value=>content.includes(Buffer.from(value))))fail('Runtime credential detected in tracked source');
    if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content.toString('utf8')))fail('Private key detected in tracked source');
  }
  return {revision,trackedFiles:files.length,credentialComparisonCount:values.length};
}
export async function auditAssetCredentials(directory,assets,root=ROOT) {
  let runtime;try{runtime=JSON.parse(await readFile(resolve(root,'secrets/runtime-vars.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')fail('Local credential audit input is invalid');}
  const values=[];
  const walk=(value,key='')=>{if(typeof value==='string'&&value.length>=16&&/(secret|private|token|password|session|api.?v3.?key)/i.test(key)) {
    values.push(Buffer.from(value),Buffer.from(JSON.stringify(value).slice(1,-1)));
    if(value.includes('PRIVATE KEY')) {const body=value.replace(/-----[^-]+-----|\s/g,'');if(body.length>=64)values.push(Buffer.from(body));}
  }else if(plain(value))for(const [name,entry]of Object.entries(value))walk(entry,name);};walk(runtime);
  const longest=Math.max(16384,...values.map(value=>value.length));
  async function scan(stream) {
    let tail=Buffer.alloc(0),expanded=0;
    for await(const chunk of stream) {
      expanded+=chunk.length;if(expanded>8*1024*1024*1024)fail('Release asset expanded-size limit exceeded');
      const bytes=Buffer.concat([tail,chunk]);
      if(values.some(value=>bytes.includes(value))||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString('latin1')))fail('Private runtime credential detected in release asset');
      tail=bytes.subarray(Math.max(0,bytes.length-longest));
    }
  }
  for(const name of Object.keys(assets)) {
    const path=resolve(directory,name);await scan(createReadStream(path));
    if(/\.(zip|apk)$/.test(name)) {
      const process=spawn('unzip',['-p',path],{stdio:['ignore','pipe','ignore']});
      const closed=new Promise((resolve,reject)=>{process.once('error',reject);process.once('close',code=>code===0?resolve():reject(Error('Unable to audit compressed release content')));});
      closed.catch(()=>{});
      try {await scan(process.stdout);await closed;}catch(error){process.kill();await closed.catch(()=>{});throw error;}
    }
  }
  return {credentialComparisonCount:values.length,scope:'tracked-source,raw-installers,expanded-zip-and-apk'};
}
export const NATIVE_CHECKS={
  'mac-arm64-packaged':{environments:['macos-arm64'],scope:'packaged-login-smoke',details:['isPackaged','loginFormReady','remoteNodeIsolated','remoteNativeBridgeAbsent','nativeShellReady']},
  'mac-x64-packaged':{environments:['macos-arm64-rosetta','macos-x64'],scope:'packaged-login-smoke',details:['isPackaged','loginFormReady','remoteNodeIsolated','remoteNativeBridgeAbsent','nativeShellReady']},
  'mac-update-helper':{environments:['macos-arm64'],scope:'production-helper-resigned-fixtures',details:['successVerified','rollbackVerified','profilePreserved']},
  'android-install-upgrade':{environments:['android-emulator','android-device'],scope:'signed-apk-system-install-upgrade',details:['installationVerified','upgradeVerified','profilePreserved','signatureVerified']},
  'windows-install-upgrade':{environments:['windows-x64-runner','windows-x64'],scope:'nsis-install-upgrade',details:['installationVerified','upgradeVerified','profilePreserved','liveLoginVerified','remoteIsolationVerified']}
};
export const INSTALLATION_NATIVE_CHECKS={
  'mac-manual-install':{environments:['macos-arm64'],scope:'quarantined-app-user-confirmed-install',details:['sourceVerified','confirmationRequired','quarantineScoped','installedAppLaunched','globalGatekeeperUnchanged']},
  'windows-authenticode':{environments:['windows-x64-runner','windows-x64'],scope:'self-signed-authenticode-current-user-trust',details:['beforeTrustRejected','afterCurrentUserTrustValid','launcherSigned','installerSigned','uninstallerSigned','certificateIdentityMatched']}
};
export function requiredNativeChecks(settings) {return requiresInstallationSupport(settings.version)?{...NATIVE_CHECKS,...INSTALLATION_NATIVE_CHECKS}:NATIVE_CHECKS;}
export function validateNativeEvidence(evidence,settings,assets,sourceRevision,{now=Date.now()}={}) {
  if(!exactKeys(evidence,['schema','product','version','sourceRevision','artifacts','checks'])||evidence.schema!==1||evidence.product!==settings.productName||evidence.version!==settings.version)fail('Invalid native verification evidence identity');
  if(!/^[a-f0-9]{40}$/.test(evidence.sourceRevision)||evidence.sourceRevision!==sourceRevision)fail('Native evidence source revision mismatch');
  if(!exactKeys(evidence.artifacts,Object.keys(assets)))fail('Native evidence must cover every release asset');
  for(const [name,asset]of Object.entries(assets)) {
    const proof=evidence.artifacts[name];
    if(!exactKeys(proof,['bytes','sha256','sourceRevision'])||proof.bytes!==asset.bytes||proof.sha256!==asset.sha256||proof.sourceRevision!==sourceRevision)fail('Native evidence asset integrity or source revision mismatch');
  }
  const definitions=requiredNativeChecks(settings);
  if(!Array.isArray(evidence.checks)||evidence.checks.length!==Object.keys(definitions).length||new Set(evidence.checks.map(check=>check?.id)).size!==evidence.checks.length)fail('Incomplete native verification check set');
  const checks=[];
  for(const [id,definition]of Object.entries(definitions)) {
    const check=evidence.checks.find(value=>value?.id===id);
    if(!exactKeys(check,['id','environment','scope','sourceRevision','verifiedAt','evidenceSha256','passed','details'])||!definition.environments.includes(check.environment)||check.scope!==definition.scope||check.sourceRevision!==sourceRevision||check.passed!==true)fail('Native verification scope, environment or revision mismatch');
    const time=Date.parse(check.verifiedAt);
    if(typeof check.verifiedAt!=='string'||!Number.isFinite(time)||time<Date.UTC(2026,0,1)||time>now+86400000||typeof check.evidenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(check.evidenceSha256))fail('Invalid native verification timestamp or report digest');
    if(!exactKeys(check.details,definition.details)||definition.details.some(field=>check.details[field]!==true))fail('Native installation, upgrade or isolation verification did not pass');
    checks.push({id,environment:check.environment,scope:check.scope,sourceRevision:check.sourceRevision,verifiedAt:check.verifiedAt,evidenceSha256:check.evidenceSha256,passed:true,details:check.details});
  }
  return {verified:true,sourceRevision,sha256:sha(JSON.stringify(evidence)),checks};
}
export async function prepareRelease({directory=resolve(ROOT,'dist-clients'),notesFile,privateKeyPath=resolve(ROOT,'secrets/client-release-signing-key.pem'),prepare=false,copyPublic=false,evidenceFile,root=ROOT,publishedAt=new Date().toISOString()}={}) {
  if(copyPublic&&prepare)fail('--copy-public copies existing verified metadata; do not combine it with --prepare');
  const settings=JSON.parse(await readFile(resolve(root,'clients/shared/release-settings.json'),'utf8'));
  const source=await auditSource(root),installation=await stageInstallationAssets({directory,root,settings,write:prepare}),assets=await inspectAssets(directory,settings),credentials=await auditAssetCredentials(directory,assets,root);
  if((prepare||copyPublic)&&!evidenceFile)fail('Release preparation and publication require --evidence with reviewed native verification');
  let nativeVerification={verified:false};
  if(evidenceFile) {let evidence;try{evidence=JSON.parse(await readFile(resolve(evidenceFile),'utf8'));}catch{fail('Unable to read native verification evidence');}nativeVerification=validateNativeEvidence(evidence,settings,assets,source.revision);}
  const report={schema:1,product:settings.productName,version:settings.version,tag:`${settings.releaseTagPrefix}${settings.version}`,sourceRevision:source.revision,sourceClean:true,trackedFiles:source.trackedFiles,assetCount:Object.keys(assets).length,credentialComparisons:Math.max(source.credentialComparisonCount,credentials.credentialComparisonCount),credentialAuditScope:credentials.scope,nativeVerification,assets};
  if(copyPublic) {
    const publicKey=await readFile(resolve(root,'clients/shared/update-public-key.pem'),'utf8');
    const envelopeText=await readFile(resolve(directory,'client-update.json'),'utf8');
    const manifest=verifyEnvelope(JSON.parse(envelopeText),publicKey,settings,{expectedVersion:settings.version});
    for(const platform of PLATFORM_KEYS)for(const purpose of ['update','installer']) {const asset=manifest.platforms[platform][purpose],local=assets[asset.name];if(local.sha256!==asset.sha256||local.bytes!==asset.bytes)fail('Prepared asset integrity mismatch');}
    let preparedAudit;try{preparedAudit=JSON.parse(await readFile(resolve(directory,'release-audit.json'),'utf8'));}catch{fail('Missing prepared release audit');}
    if(preparedAudit.sourceRevision!==source.revision||preparedAudit.nativeVerification?.verified!==true||preparedAudit.nativeVerification.sha256!==nativeVerification.sha256)fail('Prepared native verification audit does not match the reviewed source and evidence');
    let installationText;
    if(installation) {
      installationText=await readFile(resolve(directory,'client-installation.json'),'utf8');
      const support=verifyInstallationEnvelope(JSON.parse(installationText),publicKey,settings,{expectedVersion:settings.version});
      if(JSON.stringify(support.windows)!==JSON.stringify(installation.identity))fail('Prepared installation signing identity changed');
      for(const asset of Object.values(support.assets)){const local=assets[asset.name];if(local.sha256!==asset.sha256||local.bytes!==asset.bytes)fail('Prepared installation support integrity mismatch');}
    }
    await copyPublishedManifest({root,directory,settings,assets,envelopeText,installationText});
    return {...report,prepared:true,publicManifestCopied:true};
  }
  if(!prepare)return {...report,prepared:false};
  if(!notesFile)fail('--prepare requires a reviewed --notes file');
  const notes=await readFile(resolve(notesFile),'utf8'),definitions=assetDefinitions(settings.version),platforms={};
  for(const platform of PLATFORM_KEYS) {
    platforms[platform]={};for(const purpose of ['update','installer']) {const asset=definitions[platform][purpose];platforms[platform][purpose]={name:asset.name,url:assetUrl(settings,settings.version,asset.name),...assets[asset.name],type:asset.type};}
  }
  const manifest={schema:1,product:settings.productName,applicationId:settings.applicationId,version:settings.version,versionCode:versionCode(settings.version),publishedAt,releaseUrl:releaseUrl(settings),notes,platforms};
  const privateStat=await lstat(privateKeyPath);if(!privateStat.isFile()||privateStat.isSymbolicLink()||(privateStat.mode&0o077)!==0)fail('Release signing key must be a private mode-0600 file');
  const publicKey=await readFile(resolve(root,'clients/shared/update-public-key.pem'),'utf8'),privateKey=await readFile(privateKeyPath,'utf8'),envelope=signManifest(manifest,privateKey,publicKey,settings,{expectedVersion:settings.version});
  const envelopeText=JSON.stringify(envelope,null,2)+'\n',checksums=Object.keys(assets).sort().map(name=>`${assets[name].sha256}  ${name}`).join('\n')+'\n';
  await mkdir(directory,{recursive:true});
  await writeFile(resolve(directory,'client-update.json'),envelopeText);await writeFile(resolve(directory,'SHA256SUMS'),checksums);await writeFile(resolve(directory,'release-audit.json'),JSON.stringify(report,null,2)+'\n');
  if(installation) {
    const supportAssets=Object.fromEntries(Object.entries(INSTALLATION_ASSETS).map(([purpose,asset])=>[purpose,{...asset,url:assetUrl(settings,settings.version,asset.name),...assets[asset.name]}]));
    const support={schema:1,product:settings.productName,applicationId:settings.applicationId,version:settings.version,releaseUrl:releaseUrl(settings),windows:installation.identity,assets:supportAssets};
    await writeFile(resolve(directory,'client-installation.json'),JSON.stringify(signInstallationManifest(support,privateKey,publicKey,settings,{expectedVersion:settings.version}),null,2)+'\n');
  }
  return {...report,prepared:true,publicManifestCopied:copyPublic};
}
export function verifyPublishedRelease(release,settings,assets,metadata) {
  if(!plain(release)||release.draft!==false||release.prerelease===true||release.tag_name!==`${settings.releaseTagPrefix}${settings.version}`||!Array.isArray(release.assets))fail('GitHub Release must already be published');
  const binaryNames=[...new Set(Object.values(assetDefinitions(settings.version)).flatMap(platform=>Object.values(platform).map(asset=>asset.name))),...(requiresInstallationSupport(settings.version)?Object.values(INSTALLATION_ASSETS).map(asset=>asset.name):[])];
  const metadataNames=['client-update.json','SHA256SUMS','release-audit.json',...(requiresInstallationSupport(settings.version)?['client-installation.json']:[])];
  if(!exactKeys(assets,binaryNames)||!exactKeys(metadata,metadataNames))fail('Published release input asset set mismatch');
  const expected={...assets,...Object.fromEntries(Object.entries(metadata).map(([name,bytes])=>[name,{bytes:Buffer.byteLength(bytes),sha256:sha(bytes)}]))};
  if(release.assets.length!==Object.keys(expected).length||new Set(release.assets.map(asset=>asset.name)).size!==release.assets.length)fail('Published GitHub asset set mismatch');
  for(const [name,asset]of Object.entries(expected)) {const remote=release.assets.find(value=>value.name===name);if(!remote||remote.size!==asset.bytes||remote.digest!==`sha256:${asset.sha256}`)fail('Published GitHub asset integrity mismatch');}
  return true;
}
async function copyPublishedManifest({root,directory,settings,assets,envelopeText,installationText}) {
  const verification=spawnSync('gh',['api',`repos/${settings.repository}/releases/tags/${settings.releaseTagPrefix}${settings.version}`],{encoding:'utf8',maxBuffer:2*1024*1024});
  if(verification.status!==0)fail('Unable to verify published GitHub Release');
  let release;try{release=JSON.parse(verification.stdout);}catch{fail('Invalid GitHub Release response');}
  const metadata={'client-update.json':envelopeText,SHA256SUMS:await readFile(resolve(directory,'SHA256SUMS')),'release-audit.json':await readFile(resolve(directory,'release-audit.json'))};
  if(installationText)metadata['client-installation.json']=installationText;
  verifyPublishedRelease(release,settings,assets,metadata);
  await writeFile(resolve(root,'public/client-update.json'),envelopeText);
  if(installationText)await writeFile(resolve(root,'public/client-installation.json'),installationText);
}
async function main() {
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++) {const arg=args[i];if(arg==='--prepare')options.prepare=true;else if(arg==='--copy-public')options.copyPublic=true;else if(arg==='--directory')options.directory=resolve(args[++i]||fail('Missing directory'));else if(arg==='--notes')options.notesFile=resolve(args[++i]||fail('Missing notes'));else if(arg==='--evidence')options.evidenceFile=resolve(args[++i]||fail('Missing native verification evidence'));else if(arg==='--published-at')options.publishedAt=args[++i]||fail('Missing publication time');else fail('Unknown release preparation argument');}
  const report=await prepareRelease(options);console.log(JSON.stringify(report,null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
