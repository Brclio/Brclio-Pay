#!/usr/bin/env node
/** Offline first-install/configuration tools for an independent SQLite server. */
import {createHash,createHmac,createPrivateKey,createPublicKey,pbkdf2Sync,randomBytes} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {validateEnvironmentGuide} from './sync-environment-guide.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const GUIDE_PATH='maintenance/environment/guide.json';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw new Error(code);};
const secret=()=>randomBytes(32).toString('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const allowedUpdates=new Set(['PAY_BASE_URL','PAYMENT_MODE','PAYMENT_ENABLED','ALIPAY_CHANNELS','ALIPAY_APP_ID','ALIPAY_PRIVATE_KEY','ALIPAY_PUBLIC_KEY','ALIPAY_SELLER_ID','ALIPAY_GATEWAY','WECHAT_CHANNELS','WECHAT_MCH_ID','WECHAT_APP_ID','WECHAT_SERIAL_NO','WECHAT_PRIVATE_KEY','WECHAT_API_V3_KEY','WECHAT_PUBLIC_KEYS_JSON','WECHAT_PUBLIC_KEY_ID','CHECKOUT_SECRET','CLIENTS_JSON','REGISTRY_STORAGE_MODE','REGISTRY_ENCRYPTION_KEY','ADMIN_EMAIL','ADMIN_PASSWORD_HASH','ADMIN_PASSWORD_PEPPER','ADMIN_SESSION_SECRET','LEGACY_WECHAT_CHECKOUT_SECRET','LEGACY_WECHAT_BASE_URL']);
function keys(value,allowed,required=allowed){if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))fail('INVALID_SETUP_FIELDS');}
function match(value,pattern,code){if(typeof value!=='string'||!pattern.test(value))fail(code);return value;}
function baseUrl(value){let url;try{url=new URL(value);}catch{fail('INVALID_PAY_BASE_URL');}if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port)fail('INVALID_PAY_BASE_URL');return url.origin;}
function channels(value){const result=typeof value==='string'?value.split(','):value;if(!Array.isArray(result)||!result.length||result.some(item=>!['page','wap'].includes(item))||new Set(result).size!==result.length)fail('INVALID_ALIPAY_CHANNELS');return result.join(',');}
function rsaKey(value,privateKey){try{const text=!privateKey&&!value.includes('-----BEGIN')?'-----BEGIN PUBLIC KEY-----\n'+value.replace(/\s/g,'')+'\n-----END PUBLIC KEY-----\n':value;const key=privateKey?createPrivateKey(text):createPublicKey(text);if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength||0)<2048)fail('INVALID_RSA_KEY');return key.export({format:'pem',type:privateKey?'pkcs8':'spki'}).toString();}catch{fail(privateKey?'INVALID_RSA_PRIVATE_KEY_FILE':'INVALID_RSA_PUBLIC_KEY_FILE');}}
async function fileText(filename){try{const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)fail('INVALID_INPUT_FILE');return await readFile(filename,'utf8');}catch{fail('INPUT_FILE_UNAVAILABLE');}}

export function validateServerInput(input){
  keys(input,['providerMode','baseUrl','admin','alipay','wechat'],['providerMode','baseUrl','admin']);
  if(!['dual','alipay','wechat'].includes(input.providerMode))fail('INVALID_PROVIDER_MODE');baseUrl(input.baseUrl);
  keys(input.admin,['email','passwordFile'],['email']);match(input.admin.email,/^[^\s@]+@[^\s@]+\.[^\s@]+$/,'INVALID_ADMIN_EMAIL');
  if(input.providerMode!=='wechat'){
    keys(input.alipay,['appId','sellerId','privateKeyFile','publicKeyFile','gateway','channels'],['appId','sellerId','privateKeyFile','publicKeyFile']);
    match(input.alipay.appId,/^20\d{14}$/,'INVALID_ALIPAY_APP_ID');match(input.alipay.sellerId,/^2088\d{12}$/,'INVALID_ALIPAY_SELLER_ID');
    if(input.alipay.gateway!==undefined&&input.alipay.gateway!=='https://openapi.alipay.com/gateway.do')fail('ONLY_LIVE_ALIPAY_GATEWAY_SUPPORTED');
    if(input.alipay.channels!==undefined)channels(input.alipay.channels);
  }else if(input.alipay!==undefined)fail('UNSELECTED_ALIPAY_INPUT');
  if(input.providerMode!=='alipay'){
    keys(input.wechat,['merchantId','appId','serialNo','privateKeyFile','apiV3KeyFile','publicKeyId','publicKeyFile']);
    match(input.wechat.merchantId,/^\d{6,20}$/,'INVALID_WECHAT_MERCHANT_ID');match(input.wechat.appId,/^wx[A-Za-z0-9]{16}$/,'INVALID_WECHAT_APP_ID');match(input.wechat.serialNo,/^[A-Fa-f0-9]{16,64}$/,'INVALID_WECHAT_SERIAL');match(input.wechat.publicKeyId,/^PUB_KEY_ID_[A-Za-z0-9_]+$/,'INVALID_WECHAT_PUBLIC_KEY_ID');
  }else if(input.wechat!==undefined)fail('UNSELECTED_WECHAT_INPUT');
  for(const path of [input.admin.passwordFile,input.alipay?.privateKeyFile,input.alipay?.publicKeyFile,input.wechat?.privateKeyFile,input.wechat?.apiV3KeyFile,input.wechat?.publicKeyFile].filter(value=>value!==undefined))if(typeof path!=='string'||!path||path.length>4096||/[\r\n\0]/.test(path))fail('INVALID_INPUT_FILE_PATH');
  return input;
}

let modulePromise;
async function sqliteModule(){
  modulePromise??=(async()=>{const directory=await mkdtemp(join(tmpdir(),'brclio-setup-sqlite-')),filename=join(directory,'store.mjs');try{await build({stdin:{contents:'export { SQLiteStore } from "./server/sqlite-store.ts"; export { clients } from "./src/config.ts";',resolveDir:ROOT,loader:'ts'},outfile:filename,platform:'node',target:'node22.13',format:'esm',bundle:true,logLevel:'silent'});return await import(pathToFileURL(filename).href);}finally{await rm(directory,{recursive:true,force:true});}})();return modulePromise;
}
function isUnder(parent,path){const sub=relative(parent,path);return sub!==''&&sub!=='..'&&!sub.startsWith('..'+sep)&&!isAbsolute(sub);}
async function newPrivateDirectory(output,root){
  root=await realpath(root);const target=resolve(root,output);
  if(!isAbsolute(output)&&!isUnder(resolve(root,'secrets'),target))fail('OUTPUT_MUST_BE_UNDER_SECRETS_OR_ABSOLUTE_EXTERNAL');
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const canonical=resolve(await realpath(dirname(target)),basename(target));
  if((canonical===root||isUnder(root,canonical))&&!isUnder(resolve(root,'secrets'),canonical))fail('OUTPUT_MUST_BE_UNDER_SECRETS_OR_ABSOLUTE_EXTERNAL');
  try{await mkdir(canonical,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('SETUP_OUTPUT_ALREADY_EXISTS_NO_OVERWRITE');throw error;}
  await chmod(canonical,0o700);return canonical;
}

function serverGuide(seed){
  const guide=structuredClone(seed);guide.updatedAt=new Date().toISOString();
  guide.intro=['本服务运行在自己的服务器，业务记录、部署配置与本说明保存在本地 SQLite；不依赖 Cloudflare 或 GitHub 运行。','公开配置在管理员登录后显示；私密值默认隐藏，单项查看需要管理员会话、同源和 CSRF 校验。实际值不写入本说明或公开资源。','首次初始化保持 PAYMENT_ENABLED=false。完成商户、存储、签名和产品幂等交付验证后再启用收款。'];
  guide.groups=guide.groups.map(group=>({...group,variables:group.variables.filter(variable=>!variable.name.startsWith('GITHUB_'))})).filter(group=>group.variables.length);
  const bindings=new Set(['ASSETS','STORAGE','ADMIN_LOGIN_LIMITER','INTEGRATION_LIMITER','PAYMENT_API_LIMITER']);
  for(const group of guide.groups)for(const variable of group.variables){
    variable.location=bindings.has(variable.name)?'服务器启动程序提供的资源绑定，不是数据库文本值。':'服务器本地 SQLite 的 runtime_config 表；通过受保护配置文件与 setup:server 更新命令维护。';
    variable.changeNotes=bindings.has(variable.name)?'资源绑定由服务器代码创建，更新后重启服务。':'备份 SQLite 后，通过带预期修订号的配置更新命令写入；重启服务后生效。保留已有商户、签名和管理员凭据。';
    variable.maintenance=bindings.has(variable.name)?'保持服务器资源绑定，不得用字符串替代。':'配置保存在服务器数据库，避免公开页面、源码仓库、命令行和日志泄露；按需查看仅限管理员。';
    variable.generation=variable.generation?.replaceAll('setup-deployment.mjs','setup-server.mjs').replaceAll('Worker','支付服务');
    if(['ASSETS','ADMIN_LOGIN_LIMITER','INTEGRATION_LIMITER','PAYMENT_API_LIMITER'].includes(variable.name))variable.generation='服务器启动程序创建，静态资源来自发布目录；限流器分别每分钟允许 5 / 30 / 120 次请求。';
  }
  guide.notes=['SQLite 文件与备份必须位于静态网站之外的受保护目录；数据库含商户密钥和真实业务数据，不能提交到源码仓库。','说明仅保存名称、用途与占位示例；真实配置在 SQLite runtime_config 表中，与公开文档分离。','代码发布不重新生成配置。更新密钥前核对在途交易与旧签名链接，保留原始订单身份、金额和时间。','配置修改需要重启服务；域名、HTTPS、真实支付到账与产品权益交付应分别验证。'];
  validateEnvironmentGuide(guide,{requireComplete:false});return guide;
}

/** Creates a new database only; never overwrites an existing installation or contacts a service. */
export async function prepareServer(input,options={}){
  validateServerInput(input);const root=await realpath(resolve(options.root||ROOT)),inputDirectory=resolve(options.inputDirectory||root),read=path=>fileText(resolve(inputDirectory,path));
  const password=input.admin.passwordFile?(await read(input.admin.passwordFile)).replace(/\r?\n$/,''):randomBytes(24).toString('base64url');
  if(password.length<12||password.length>1024)fail('ADMIN_PASSWORD_MUST_BE_12_TO_1024_CHARACTERS');
  const pepper=secret(),salt=secret();
  const config={STORAGE_BACKEND:'sqlite',PAY_BASE_URL:baseUrl(input.baseUrl),PAYMENT_MODE:'live',PAYMENT_ENABLED:'false',ALIPAY_CHANNELS:input.alipay?channels(input.alipay.channels||['page','wap']):'',WECHAT_CHANNELS:input.wechat?'native':'',REGISTRY_STORAGE_MODE:'plain',CLIENTS_JSON:'[]',CHECKOUT_SECRET:secret(),ADMIN_EMAIL:input.admin.email.toLowerCase(),ADMIN_PASSWORD_HASH:`pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(createHmac('sha256',pepper).update(password).digest('hex'),Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')}`,ADMIN_PASSWORD_PEPPER:pepper,ADMIN_SESSION_SECRET:secret()};
  if(input.alipay)Object.assign(config,{ALIPAY_APP_ID:input.alipay.appId,ALIPAY_SELLER_ID:input.alipay.sellerId,ALIPAY_PRIVATE_KEY:rsaKey(await read(input.alipay.privateKeyFile),true),ALIPAY_PUBLIC_KEY:rsaKey(await read(input.alipay.publicKeyFile),false),...(input.alipay.gateway?{ALIPAY_GATEWAY:input.alipay.gateway}:{})});
  if(input.wechat){const apiKey=(await read(input.wechat.apiV3KeyFile)).trim();if(Buffer.byteLength(apiKey)!==32)fail('WECHAT_API_V3_KEY_MUST_BE_32_BYTES');Object.assign(config,{WECHAT_MCH_ID:input.wechat.merchantId,WECHAT_APP_ID:input.wechat.appId,WECHAT_SERIAL_NO:input.wechat.serialNo,WECHAT_PRIVATE_KEY:rsaKey(await read(input.wechat.privateKeyFile),true),WECHAT_API_V3_KEY:apiKey,WECHAT_PUBLIC_KEY_ID:input.wechat.publicKeyId,WECHAT_PUBLIC_KEYS_JSON:JSON.stringify({[input.wechat.publicKeyId]:rsaKey(await read(input.wechat.publicKeyFile),false)})});}
  const guide=serverGuide(JSON.parse(await fileText(resolve(ROOT,'resources/environment-guide.json')))),{SQLiteStore}=await sqliteModule();
  const output=await newPrivateDirectory(options.output||'secrets/server-generated',root),database=resolve(output,'brclio-pay.sqlite');let store;
  try{
    store=new SQLiteStore(database);store.importDocuments([{path:GUIDE_PATH,content:json(guide)}],{sourceRevision:'first-install:'+Date.now(),runtimeConfig:config,sourceMetadata:{kind:'independent-server-first-install',providerMode:input.providerMode}});
    const snapshot=store.exportSnapshot();store.close();store=undefined;
    const admin={email:config.ADMIN_EMAIL,...(input.admin.passwordFile?{passwordSource:'supplied passwordFile; original password not copied'}:{password})};
    await writeFile(resolve(output,'admin-login.json'),json(admin),{mode:0o600,flag:'wx'});
    const receipt={schema:1,createdAt:new Date().toISOString(),deployment:'server-sqlite',providerMode:input.providerMode,paymentEnabled:false,baseUrl:config.PAY_BASE_URL,database:'brclio-pay.sqlite',revision:snapshot.revision,documentDigest:snapshot.documentDigest,configNames:Object.keys(config).sort(),domainVerified:false,realPaymentVerified:false,fulfillmentVerified:false};
    await writeFile(resolve(output,'setup-receipt.json'),json(receipt),{mode:0o600,flag:'wx'});
    return {output,database,receipt};
  }finally{store?.close();}
}

function validateRuntime(config){
  baseUrl(config.PAY_BASE_URL);if(!['true','false'].includes(config.PAYMENT_ENABLED)||!['live','sandbox'].includes(config.PAYMENT_MODE)||config.REGISTRY_STORAGE_MODE!=='plain'||typeof config.CHECKOUT_SECRET!=='string'||config.CHECKOUT_SECRET.length<32)fail('INVALID_RUNTIME_CONFIG');
  if(config.ALIPAY_CHANNELS){channels(config.ALIPAY_CHANNELS);match(config.ALIPAY_APP_ID,/^20\d{14}$/,'INVALID_ALIPAY_APP_ID');match(config.ALIPAY_SELLER_ID,/^2088\d{12}$/,'INVALID_ALIPAY_SELLER_ID');rsaKey(config.ALIPAY_PRIVATE_KEY,true);rsaKey(config.ALIPAY_PUBLIC_KEY,false);if(config.PAYMENT_MODE==='live'&&config.ALIPAY_GATEWAY&&config.ALIPAY_GATEWAY!=='https://openapi.alipay.com/gateway.do')fail('INVALID_ALIPAY_GATEWAY');if(config.PAYMENT_MODE==='sandbox'&&!['https://openapi-sandbox.dl.alipaydev.com/gateway.do','https://openapi.alipaydev.com/gateway.do'].includes(config.ALIPAY_GATEWAY))fail('INVALID_ALIPAY_GATEWAY');}
  if(config.WECHAT_CHANNELS){if(config.WECHAT_CHANNELS!=='native'||config.PAYMENT_MODE!=='live')fail('INVALID_WECHAT_CHANNELS');match(config.WECHAT_MCH_ID,/^\d{6,20}$/,'INVALID_WECHAT_MERCHANT_ID');match(config.WECHAT_APP_ID,/^wx[A-Za-z0-9]{16}$/,'INVALID_WECHAT_APP_ID');match(config.WECHAT_SERIAL_NO,/^[A-Fa-f0-9]{16,64}$/,'INVALID_WECHAT_SERIAL');rsaKey(config.WECHAT_PRIVATE_KEY,true);if(Buffer.byteLength(config.WECHAT_API_V3_KEY||'')!==32)fail('WECHAT_API_V3_KEY_MUST_BE_32_BYTES');let publicKeys;try{publicKeys=JSON.parse(config.WECHAT_PUBLIC_KEYS_JSON);}catch{fail('INVALID_WECHAT_PUBLIC_KEYS');}if(!plain(publicKeys)||!Object.keys(publicKeys).length)fail('INVALID_WECHAT_PUBLIC_KEYS');for(const [name,key]of Object.entries(publicKeys)){match(name,/^PUB_KEY_ID_[A-Za-z0-9_]+$/,'INVALID_WECHAT_PUBLIC_KEY_ID');rsaKey(key,false);}if(config.WECHAT_PUBLIC_KEY_ID&&!Object.hasOwn(publicKeys,config.WECHAT_PUBLIC_KEY_ID))fail('INVALID_WECHAT_PUBLIC_KEY_ID');}
  match(config.ADMIN_EMAIL,/^[^\s@]+@[^\s@]+\.[^\s@]+$/,'INVALID_ADMIN_EMAIL');match(config.ADMIN_PASSWORD_HASH,/^pbkdf2-sha256\$100000\$[a-f0-9]{64}\$[a-f0-9]{64}$/,'INVALID_ADMIN_PASSWORD_HASH');for(const name of ['ADMIN_PASSWORD_PEPPER','ADMIN_SESSION_SECRET'])match(config[name],/^[a-f0-9]{64}$/,'INVALID_ADMIN_SECRET');
  let clients;try{clients=JSON.parse(config.CLIENTS_JSON);}catch{fail('INVALID_CLIENTS_JSON');}if(!Array.isArray(clients))fail('INVALID_CLIENTS_JSON');if(config.LEGACY_WECHAT_BASE_URL)baseUrl(config.LEGACY_WECHAT_BASE_URL);
}
async function existingStore(database){const info=await lstat(database).catch(()=>null);if(!info?.isFile()||info.isSymbolicLink())fail('EXISTING_DATABASE_REQUIRED');const {SQLiteStore}=await sqliteModule();return new SQLiteStore(database);}
export async function inspectServer(database){const store=await existingStore(database);try{const data=store.exportSnapshot();return {revision:data.revision,configNames:Object.keys(data.runtimeConfig).sort(),storage:'sqlite-local'};}finally{store.close();}}
export async function updateServerConfig(database,input,expectedRevision){
  keys(input,['values']);if(!plain(input.values)||!Object.keys(input.values).length||Object.entries(input.values).some(([name,value])=>!allowedUpdates.has(name)||typeof value!=='string'))fail('INVALID_CONFIG_UPDATE');
  if(typeof expectedRevision!=='string'||!/^sqlite:[0-9]+$/.test(expectedRevision))fail('EXPECTED_REVISION_REQUIRED');
  const store=await existingStore(database);
  try{const current=store.readRuntimeConfig(),config={...current,...input.values,STORAGE_BACKEND:'sqlite'};validateRuntime(config);const {clients}=await sqliteModule();clients(config);const revision=store.replaceRuntimeConfig(config,{expectedRevision});return {updated:true,revision,changedNames:Object.keys(input.values).sort(),restartRequired:true};}finally{store.close();}
}
export function parseServerArguments(argv){
  const options={output:'secrets/server-generated'};const seen=new Set();
  for(let i=0;i<argv.length;i++){const arg=argv[i];if(seen.has(arg))fail('DUPLICATE_ARGUMENT');seen.add(arg);if(['--help','--inspect','--update'].includes(arg))options[arg.slice(2)]=true;else if(['--input','--output','--database','--expected-revision'].includes(arg)&&argv[i+1]&&!argv[i+1].startsWith('--'))options[arg.slice(2)]=argv[++i];else fail('INVALID_ARGUMENT');}
  if(!options.help){if(options.inspect){if(!options.database||options.update||options.input||options['expected-revision']||seen.has('--output'))fail('INVALID_ARGUMENT');}else if(options.update){if(!options.database||!options.input||!options['expected-revision']||seen.has('--output'))fail('INVALID_ARGUMENT');}else if(!options.input||options.database||options['expected-revision'])fail('INVALID_ARGUMENT');}
  return options;
}
export async function main(argv=process.argv.slice(2)){
  process.umask(0o077);const options=parseServerArguments(argv);
  if(options.help){console.log('First install: npm run setup:server -- --input secrets/server-input.json [--output secrets/server-generated]\nInspect revision (no secret values): npm run setup:server -- --inspect --database /absolute/private/brclio-pay.sqlite\nUpdate protected configuration: npm run setup:server -- --update --database /absolute/private/brclio-pay.sqlite --input /absolute/private/update.json --expected-revision sqlite:REVISION\nUpdate input: {"values":{"PAYMENT_ENABLED":"true"}}. Back up first; restart after updating.\nExample: examples/deployment/server-input.example.json. No Cloudflare/GitHub account needed. Initialization is offline, refuses existing output, and leaves payments disabled. Credentials remain in SQLite; initial generated administrator login is saved only to a private admin-login.json.');return;}
  if(options.inspect){console.log(JSON.stringify(await inspectServer(resolve(options.database))));return;}
  const inputPath=resolve(options.input),input=JSON.parse(await fileText(inputPath));
  if(options.update){console.log(JSON.stringify(await updateServerConfig(resolve(options.database),input,options['expected-revision'])));return;}
  const result=await prepareServer(input,{...options,inputDirectory:dirname(inputPath)});console.log(JSON.stringify({prepared:true,output:result.output,database:result.database,providerMode:result.receipt.providerMode,paymentEnabled:false,revision:result.receipt.revision,next:'Back up the private setup directory, configure HTTPS and the loopback reverse proxy, then start the server using PAY_DATABASE_PATH. No public deployment has occurred.'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({error:/^[A-Z0-9_]+$/.test(error.message)?error.message:'SERVER_SETUP_FAILED_VALUES_WITHHELD'}));process.exitCode=1;});
