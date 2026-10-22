'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{execFile,spawn}=require('node:child_process'),{promisify}=require('node:util'),{randomBytes,createHash}=require('node:crypto');
const run=promisify(execFile);
async function privateSecurity(args,options={}){try{return await run('/usr/bin/security',args,options);}catch{throw Error('Mac private keychain operation failed; sensitive arguments were redacted');}}
const ROOT=path.resolve(__dirname,'../../..'),DIRECTORY=path.join(ROOT,'secrets/mac-code-signing');
async function exists(p){try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function protectedFile(p){const s=await fs.lstat(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw Error('Mac signing private file must be regular mode 0600');}
async function passwordInput(command,args,password){const child=spawn(command,args,{stdio:['pipe','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);child.stdin.end(password+'\n');const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});if(exit!==0)throw Error('Mac signing certificate preparation failed');}
async function prepareSigning(){
 if(process.platform!=='darwin')throw Error('Mac signing must run on macOS');await fs.mkdir(DIRECTORY,{recursive:true,mode:0o700});await fs.chmod(DIRECTORY,0o700);
 const statePath=path.join(DIRECTORY,'state.json'),privateKey=path.join(DIRECTORY,'code-signing-private-key.pem'),certificate=path.join(DIRECTORY,'code-signing-certificate.pem'),p12=path.join(DIRECTORY,'code-signing.p12'),keychain=path.join(DIRECTORY,'build.keychain-db');let state;
 if(await exists(statePath)){await protectedFile(statePath);const encoded=await fs.readFile(statePath,'utf8');try{state=JSON.parse(encoded);}catch{throw Error('Mac signing private state cannot be parsed; content was redacted');}if(state.schema!==1||state.keychain!==keychain||typeof state.password!=='string')throw Error('Mac signing state is invalid');for(const filename of [privateKey,p12])await protectedFile(filename);}
 else{
  if(await exists(privateKey)||await exists(certificate)||await exists(p12)||await exists(keychain))throw Error('Incomplete Mac signing state; retain existing files and repair explicitly');
  const password=randomBytes(32).toString('hex');
  await run('/usr/bin/openssl',['req','-x509','-newkey','rsa:3072','-sha256','-nodes','-days','3650','-keyout',privateKey,'-out',certificate,'-subj','/CN=Brclio Pay Local Code Signing/O=Brclio/C=CN','-addext','basicConstraints=critical,CA:FALSE','-addext','keyUsage=critical,digitalSignature','-addext','extendedKeyUsage=critical,codeSigning'],{timeout:60000});
  await fs.chmod(privateKey,0o600);await fs.chmod(certificate,0o644);
  await passwordInput('/usr/bin/openssl',['pkcs12','-export','-inkey',privateKey,'-in',certificate,'-out',p12,'-name','Brclio Pay Local Code Signing','-passout','stdin'],password);await fs.chmod(p12,0o600);
  const originalSearch=(await run('/usr/bin/security',['list-keychains','-d','user'])).stdout.split('\n').map(s=>s.trim().replace(/^"|"$/g,'')).filter(Boolean);
  try{
   await privateSecurity(['create-keychain','-p',password,keychain]);
   await privateSecurity(['unlock-keychain','-p',password,keychain]);
   await privateSecurity(['import',p12,'-k',keychain,'-P',password,'-T','/usr/bin/codesign','-T','/usr/bin/security'],{timeout:30000});
   await privateSecurity(['set-key-partition-list','-S','apple-tool:,apple:,codesign:','-s','-k',password,keychain],{timeout:30000});
  }finally{
   const current=(await run('/usr/bin/security',['list-keychains','-d','user'])).stdout.split('\n').map(s=>s.trim().replace(/^"|"$/g,'')).filter(Boolean);
   if(JSON.stringify(current)!==JSON.stringify(originalSearch))await run('/usr/bin/security',['list-keychains','-d','user','-s',...originalSearch]);
  }
  state={schema:1,password,keychain,certificate};await fs.writeFile(statePath,JSON.stringify(state),{mode:0o600,flag:'wx'});
 }
 await privateSecurity(['unlock-keychain','-p',state.password,state.keychain]);
 const der=(await run('/usr/bin/openssl',['x509','-in',certificate,'-outform','DER'],{encoding:'buffer'})).stdout;
 state.certificateSha1=createHash('sha1').update(der).digest('hex').toUpperCase();state.certificateSha256=createHash('sha256').update(der).digest('hex');
 return{...state,statePath,directory:DIRECTORY};
}
module.exports={prepareSigning,ROOT};
if(require.main===module)prepareSigning().then(state=>console.log(JSON.stringify({certificateSha256:state.certificateSha256,certificateSha1:state.certificateSha1,privateStatePrepared:true,systemTrustChanged:false}))).catch(()=>{console.error('Mac private signing preparation failed; inspect ignored signing directory without exposing its values.');process.exitCode=1;});
