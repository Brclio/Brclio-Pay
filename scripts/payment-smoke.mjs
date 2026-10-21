#!/usr/bin/env node
/** Creates only bounded unpaid probes, never opens payment links, and closes every recoverable probe. */
import {readFile,writeFile,mkdir,rename,chmod,open,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {fetch,ProxyAgent} from 'undici';
import {installationGithub,TARGET_REPOSITORY} from './migrate-data.mjs';
import {createBrclioWechatPayClient} from '../tests/fixtures/legacy-wechat-client.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const TEMP_CLIENT='deployment-check-20261021';
const hash=value=>createHash('sha256').update(value).digest('hex');
const hmac=(secret,value)=>createHmac('sha256',secret).update(value).digest('hex');
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const requireThat=(condition,code)=>{if(!condition)fail(code);};
const json=value=>JSON.stringify(value,null,2)+'\n';
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(plain(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';return JSON.stringify(value);}
function origin(value){const parsed=new URL(value);requireThat(parsed.protocol==='https:'&&parsed.origin===value&&!parsed.username&&!parsed.password,'INVALID_ORIGIN');return parsed.origin;}
function privatePath(value){const path=resolve(ROOT,value);requireThat(path.startsWith(resolve(ROOT,'secrets')+'/'),'PRIVATE_OUTPUT_REQUIRED');return path;}
function argumentsFor(argv){
  const result={};const fields=new Map([['--base','base'],['--legacy-base','legacyBase'],['--state','state'],['--report','report'],['--private-key','privateKey']]);
  for(let i=0;i<argv.length;i++){if(argv[i]==='--help')result.help=true;else if(fields.has(argv[i])&&argv[i+1]&&!argv[i+1].startsWith('--'))result[fields.get(argv[i])]=argv[++i];else fail('INVALID_ARGUMENT');}
  return result;
}
async function loadJson(path){return JSON.parse(await readFile(path,'utf8'));}
async function atomicJson(path,value){await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.pending';await writeFile(temporary,json(value),{mode:0o600});await chmod(temporary,0o600);await rename(temporary,path);await chmod(path,0o600);}
async function lock(path){
  for(let attempt=0;attempt<2;attempt++){
    try{const file=await open(path,'wx',0o600);await file.writeFile(json({pid:process.pid,at:new Date().toISOString()}));await file.close();return;}
    catch(error){if(error.code!=='EEXIST')throw error;let prior;try{prior=await loadJson(path);}catch{fail('SMOKE_LOCK_REQUIRES_REVIEW');}requireThat(Number.isSafeInteger(prior.pid)&&prior.pid>1,'SMOKE_LOCK_REQUIRES_REVIEW');try{process.kill(prior.pid,0);fail('SMOKE_ALREADY_RUNNING');}catch(error){if(error.code!=='ESRCH')throw error;}await unlink(path);}
  }
  fail('SMOKE_LOCK_FAILED');
}

export async function main(argv=process.argv.slice(2)){
  const options=argumentsFor(argv);
  if(options.help){process.stdout.write('Usage: node scripts/payment-smoke.mjs [--base https://pay.bornforthis.cn] [--legacy-base https://paywc.bornforthis.cn] [--state secrets/verification/smoke-state.json] [--report secrets/verification/payment-smoke.json] [--private-key /local/app-key.pem]\nCreates three unpaid probes using one durable run stamp. Never opens payment links. Immediately closes probes and pauses only the dedicated temporary platform. Reuse the same state file to recover interruptions.\n');return;}
  const configuration=JSON.parse(await readFile(resolve(ROOT,'wrangler.jsonc'),'utf8'));
  const env={...await loadJson(resolve(ROOT,'secrets/runtime-vars.json')),...configuration.vars};
  const base=origin(options.base||env.PAY_BASE_URL),legacyBase=origin(options.legacyBase||env.LEGACY_WECHAT_BASE_URL||'https://paywc.bornforthis.cn');
  const statePath=privatePath(options.state||'secrets/verification/smoke-state.json'),reportPath=privatePath(options.report||'secrets/verification/payment-smoke.json'),lockPath=statePath+'.lock';
  requireThat(statePath!==reportPath,'OUTPUT_PATH_COLLISION');
  await mkdir(dirname(statePath),{recursive:true,mode:0o700});await lock(lockPath);
  const proxy=process.env.HTTPS_PROXY||process.env.https_proxy,dispatcher=proxy?new ProxyAgent(proxy):undefined;
  let state,github,temporaryValidated=false,failure,cleanupFailure,interrupted=false,cleanupMode=false;
  const onInterrupt=()=>{interrupted=true;};process.on('SIGINT',onInterrupt);process.on('SIGTERM',onInterrupt);
  const save=async()=>atomicJson(statePath,state);
  const knownKinds=['alipay','wechat','legacyWechat'];
  const safeCode=error=>typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.code)?error.code:'SMOKE_OPERATION_FAILED';
  async function request(path,{method='GET',body,headers={},target=base}={}){
    if(interrupted&&!cleanupMode)fail('SMOKE_INTERRUPTED');
    requireThat(target===base||target===legacyBase,'UNTRUSTED_TARGET');
    let response;try{response=await fetch(target+path,{method,headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body}),dispatcher,redirect:'manual',signal:AbortSignal.timeout(30000)});}catch{fail('API_NETWORK_UNCERTAIN');}
    requireThat(response.status<300||response.status>=400,'API_REDIRECT_REFUSED');
    const raw=await response.text();requireThat(Buffer.byteLength(raw)<=512*1024,'API_RESPONSE_TOO_LARGE');
    let value;try{value=JSON.parse(raw);}catch{fail('API_RESPONSE_INVALID');}
    if(!response.ok){const code=value?.error?.code;fail(typeof code==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(code)?code:'API_HTTP_'+response.status);}
    requireThat(plain(value),'API_RESPONSE_INVALID');return value;
  }
  function adminHeaders(){
    requireThat(typeof env.ADMIN_EMAIL==='string'&&typeof env.ADMIN_PASSWORD_HASH==='string'&&typeof env.ADMIN_SESSION_SECRET==='string','ADMIN_CONFIGURATION_REQUIRED');
    const seconds=Math.floor(Date.now()/1000),csrf=hash(randomBytes(32)),payload={sub:hash(env.ADMIN_EMAIL.trim().toLowerCase()),iat:seconds,exp:seconds+8*3600,csrf,credential:hash(env.ADMIN_PASSWORD_HASH)},encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
    return {Cookie:'__Host-brclio_admin='+encoded+'.'+hmac(env.ADMIN_SESSION_SECRET,'admin-session-v1:'+encoded),Origin:origin(env.PAY_BASE_URL),'X-CSRF-Token':csrf};
  }
  const admin=(path,body)=>request(path,{headers:adminHeaders(),...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  function signRequest(method,path,body,client){const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomBytes(16).toString('hex');return {'X-Brclio-Client':client.id,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Signature':hmac(client.apiSecret,[method,path,timestamp,nonce,hash(body)].join('\n'))};}
  async function snapshot(){return github.snapshot(TARGET_REPOSITORY,env.GITHUB_BRANCH||'main');}
  async function record(path,current){current??=await snapshot();const entry=current.files.find(file=>file.path===path);return entry?JSON.parse((await github.bytes(TARGET_REPOSITORY,entry)).toString('utf8')):null;}
  async function clients(){const current=await snapshot();return Promise.all(current.files.filter(file=>/^registry\/clients\/[^/]+\.json$/.test(file.path)).map(async file=>JSON.parse((await github.bytes(TARGET_REPOSITORY,file)).toString('utf8'))));}
  async function notPaid(order){if(order?.status==='PAID'||order?.status==='SUCCESS'){state.unexpectedPaid=true;state.unexpectedPaidAt=new Date().toISOString();await save();fail('UNEXPECTED_PAID_STOPPED');}}
  async function recover(entry){
    if(entry.id)return entry.id;
    if(!entry.clientId)return null;
    const digest=hash(entry.business),index=await record(`indexes/${entry.clientId}/${digest.slice(0,2)}/${digest}.json`);
    if(index){requireThat(/^pay_[a-f0-9]{32}$/.test(index.id),'ORDER_ID_INVALID');entry.id=index.id;await save();}
    return entry.id||null;
  }
  async function detail(entry){const id=await recover(entry);requireThat(id,'ORDER_NOT_RECOVERABLE');const value=await admin('/api/admin/orders/'+id);requireThat(value.order?.id===id,'ORDER_DETAIL_MISMATCH');await notPaid(value.order);return value;}
  async function closeProbe(entry){
    if(state.unexpectedPaid)return;
    if(!await recover(entry))return;
    const current=await detail(entry);requireThat(current.order.clientId===entry.clientId&&current.order.provider===(entry.kind==='alipay'?'alipay':'wechat')&&current.order.amount===entry.amount&&current.order.productOrderId===entry.business,'ORDER_DETAIL_MISMATCH');
    if(current.order.status==='CLOSED'){entry.closed=true;entry.queryClosed=true;entry.remoteCloseConfirmed=current.order.activeAttempt?.closeConfirmed===true;await save();return;}
    requireThat(current.order.status==='PENDING','ORDER_STATE_UNEXPECTED');
    entry.closed=false;entry.queryClosed=false;entry.remoteCloseConfirmed=false;await save();
    requireThat(!current.order.operation||current.order.operation.expired,'ORDER_OPERATION_IN_PROGRESS');
    entry.closeAttempts=(entry.closeAttempts||0)+1;requireThat(entry.closeAttempts<=10,'CLOSE_RETRY_LIMIT');
    const input={expectedVersion:current.version,requestId:`${state.stamp}-${entry.kind}-close-${entry.closeAttempts}`,reason:'部署验证：立即核验并关闭未付款测试订单'};
    entry.closeRequest=input;await save();
    const closed=await admin('/api/admin/orders/'+entry.id+'/close',input);await notPaid(closed.order);requireThat(closed.order?.status==='CLOSED','ORDER_CLOSE_NOT_CONFIRMED');
    const verified=await admin('/api/admin/orders/'+entry.id);await notPaid(verified.order);requireThat(verified.order?.status==='CLOSED','ORDER_CLOSE_NOT_CONFIRMED');
    entry.closed=true;entry.queryClosed=true;entry.remoteCloseConfirmed=verified.order.activeAttempt?.closeConfirmed===true;await save();
  }
  function tempConfig(enabled=true){return {id:TEMP_CLIENT,name:'Brclio Pay deployment check',providers:['alipay','wechat'],webhookProtocol:'brclio-v1',webhookUrl:origin(env.PAY_BASE_URL)+'/api/smoke-webhook',returnOrigins:[origin(env.PAY_BASE_URL)],skus:{probe:{subject:'Brclio Pay deployment probe',amount:'0.01'}},enabled};}
  function sameTemp(value){const {enabled:_,version:__,apiSecret:___,webhookSecret:____,...actual}=value;const {enabled:_____,...expected}=tempConfig();return canonical(actual)===canonical(expected);}
  async function prepareTemporary(){
    const listing=await admin('/api/admin/clients');requireThat(Array.isArray(listing.clients),'CLIENT_LIST_INVALID');const existing=listing.clients.find(client=>client.id===TEMP_CLIENT);
    if(existing){requireThat(sameTemp(existing),'TEMP_CLIENT_CONFIGURATION_CONFLICT');temporaryValidated=true;state.temporaryPaused=false;await save();if(existing.enabled===false)await admin('/api/admin/clients',{config:tempConfig(true),expectedVersion:existing.version});}
    else{temporaryValidated=true;state.temporaryPrepared=true;await save();await admin('/api/admin/clients',{config:tempConfig(true),expectedVersion:'absent'});}
    state.temporaryPrepared=true;await save();
    const value=await record(`registry/clients/${TEMP_CLIENT}.json`);requireThat(value?.id===TEMP_CLIENT&&typeof value.apiSecret==='string'&&sameTemp(value),'TEMP_CLIENT_CREDENTIALS_UNAVAILABLE');return value;
  }
  async function pauseTemporary(){
    if(!temporaryValidated||state.unexpectedPaid)return;
    const listing=await admin('/api/admin/clients'),current=listing.clients?.find(client=>client.id===TEMP_CLIENT);
    if(!current){state.temporaryPaused=true;await save();return;}
    requireThat(sameTemp(current),'TEMP_CLIENT_CONFIGURATION_CONFLICT');
    if(current.enabled!==false)await admin('/api/admin/clients',{config:tempConfig(false),expectedVersion:current.version});
    const latest=await admin('/api/admin/clients');requireThat(latest.clients?.find(client=>client.id===TEMP_CLIENT)?.enabled===false,'TEMP_CLIENT_PAUSE_FAILED');state.temporaryPaused=true;await save();
  }
  async function canonicalProbe(entry,client){
    entry.clientId=client.id;await save();
    const value={productOrderId:entry.business,sku:'probe',returnUrl:origin(env.PAY_BASE_URL)+'/?smoke='+encodeURIComponent(state.stamp),provider:entry.kind},body=JSON.stringify(value),path='/api/v1/orders';
    const created=await request(path,{method:'POST',body,headers:signRequest('POST',path,body,client)});await notPaid(created);
    requireThat(/^pay_[a-f0-9]{32}$/.test(created.id)&&created.provider===entry.kind&&created.amount==='0.01','ORDER_CREATE_MISMATCH');
    if(entry.id)requireThat(entry.id===created.id,'IDEMPOTENCY_MISMATCH');entry.id=created.id;entry.amountValidated=true;await save();
    const repeated=await request(path,{method:'POST',body,headers:signRequest('POST',path,body,client)});await notPaid(repeated);requireThat(repeated.id===entry.id&&repeated.amount===entry.amount&&repeated.provider===entry.kind,'IDEMPOTENCY_MISMATCH');entry.idempotent=true;await save();
    if(!entry.prepay){
      requireThat(created.status==='PENDING','PROBE_CLOSED_BEFORE_PREPAY');const authorization='Bearer '+hmac(env.CHECKOUT_SECRET,'brclio-checkout-v1:'+entry.id);
      const payment=await request('/api/checkout/'+entry.id+'/pay',{method:'POST',body:JSON.stringify({channel:entry.kind==='alipay'?'page':'native'}),headers:{Authorization:authorization}});
      if(entry.kind==='alipay'){const parsed=new URL(payment.paymentUrl);requireThat(parsed.protocol==='https:'&&parsed.hostname==='openapi.alipay.com'&&parsed.pathname==='/gateway.do'&&parsed.searchParams.get('app_id')===env.ALIPAY_APP_ID,'ALIPAY_PREPAY_INVALID');const business=JSON.parse(parsed.searchParams.get('biz_content'));requireThat(business.total_amount==='0.01'&&business.out_trade_no===entry.id,'ALIPAY_PREPAY_AMOUNT_MISMATCH');}
      else requireThat(payment.provider==='wechat'&&typeof payment.codeUrl==='string'&&payment.codeUrl.startsWith('weixin://wxpay/bizpayurl?'),'WECHAT_PREPAY_INVALID');
      entry.prepay=true;await save();
    }
    const readPath='/api/v1/orders/'+entry.id,queried=await request(readPath,{headers:signRequest('GET',readPath,'',client)});await notPaid(queried);requireThat(queried.id===entry.id&&queried.amount===entry.amount,'ORDER_QUERY_MISMATCH');entry.queryVerified=true;await save();
    await closeProbe(entry);
  }
  async function legacyProbe(entry,allClients){
    let client;if(entry.clientId)client=allClients.find(value=>value.id===entry.clientId);else client=allClients.find(value=>value.enabled!==false&&value.legacyWechat?.id==='p-2bb6d77a673327a2f8d881bac2d4fe26'&&value.providers?.includes('wechat'));
    requireThat(client&&client.enabled!==false&&client.legacyWechat?.id,'LEGACY_CLIENT_UNAVAILABLE');
    if(!entry.sku){const sku=Object.entries(client.skus).find(([,value])=>value.enabled!==false&&value.amount==='3.00');requireThat(sku,'LEGACY_THREE_YUAN_SKU_UNAVAILABLE');entry.sku=sku[0];entry.clientId=client.id;entry.externalClientId=client.legacyWechat.id;entry.amount='3.00';const approved=client.returnOrigins.find(value=>!value.includes('*')&&value.startsWith('https://'));requireThat(approved,'LEGACY_RETURN_ORIGIN_REQUIRED');entry.returnUrl=origin(approved)+'/?smoke='+encodeURIComponent(state.stamp);await save();}
    requireThat(client.skus[entry.sku]?.amount===entry.amount&&client.skus[entry.sku]?.enabled!==false,'LEGACY_SKU_CHANGED');
    const sdk=createBrclioWechatPayClient({baseUrl:legacyBase,clientId:entry.externalClientId,apiKey:client.apiSecret,fetcher:(input,init)=>{if(interrupted&&!cleanupMode)fail('SMOKE_INTERRUPTED');requireThat(new URL(input).origin===legacyBase,'UNTRUSTED_TARGET');return fetch(input,{...init,dispatcher,redirect:'manual'});}});
    const input={merchantOrderId:entry.business,sku:entry.sku,quantity:1,channel:'native',expectedTotal:300,returnUrl:entry.returnUrl},created=await sdk.createOrder(input);await notPaid(created);
    requireThat(/^[a-f0-9]{32}$/.test(created.id)&&created.clientId===entry.externalClientId&&created.merchantOrderId===entry.business&&created.amount?.total===300&&created.amount?.currency==='CNY','LEGACY_ORDER_MISMATCH');
    if(entry.id)requireThat(entry.id==='pay_'+created.id,'IDEMPOTENCY_MISMATCH');entry.id='pay_'+created.id;entry.amountValidated=true;
    if(created.status==='PENDING'){requireThat(created.payment?.channel==='native'&&typeof created.payment.codeUrl==='string'&&created.payment.codeUrl.startsWith('weixin://wxpay/bizpayurl?'),'LEGACY_PREPAY_INVALID');entry.prepay=true;}else requireThat(entry.prepay&&created.status==='CLOSED','PROBE_CLOSED_BEFORE_PREPAY');await save();
    const repeated=await sdk.createOrder(input);await notPaid(repeated);requireThat(repeated.id===created.id&&repeated.amount?.total===300,'IDEMPOTENCY_MISMATCH');entry.idempotent=true;await save();
    const queried=await sdk.getOrder(created.id);await notPaid(queried);requireThat(queried.id===created.id&&queried.amount?.total===300,'LEGACY_QUERY_MISMATCH');entry.queryVerified=true;await save();
    await closeProbe(entry);
  }
  async function verifyPersistence(){
    for(const entry of state.probes)entry.plaintextPartitioned=false;await save();
    const current=await snapshot();
    for(const entry of state.probes){
      if(!entry.id)continue;const location=await record(`order-locations/${hash(entry.id).slice(0,2)}/${entry.id}.json`,current);requireThat(location?.schema===1&&new RegExp(`^orders/[0-9]{4}/[0-9]{2}/${entry.id}\\.json$`).test(location.path),'ORDER_PARTITION_INVALID');
      const stored=await record(location.path,current);await notPaid(stored);requireThat(stored?.id===entry.id&&stored.productOrderId===entry.business&&stored.amount===entry.amount&&stored.provider===(entry.kind==='alipay'?'alipay':'wechat')&&stored.status==='CLOSED'&&!stored.ciphertext&&!stored.algorithm,'PLAINTEXT_ORDER_MISMATCH');
      const expectedMonth=new Date(Date.parse(stored.createdAt)+8*3600_000).toISOString().slice(0,7).replace('-','/');requireThat(location.path===`orders/${expectedMonth}/${entry.id}.json`,'ORDER_PARTITION_INVALID');
      if(entry.kind==='legacyWechat'){requireThat(stored.legacyWechat?.clientId===entry.externalClientId&&stored.legacyWechat?.quantity===1&&stored.legacyWechat?.channel==='native','LEGACY_MARKER_MISMATCH');entry.legacyProtocolMarker=true;}
      entry.plaintextPartitioned=true;await save();
    }
    state.verifiedRevision=current.revision;await save();
  }
  try{
    try{state=await loadJson(statePath);}catch(error){if(error.code!=='ENOENT')throw error;const stamp='20261021-'+randomBytes(8).toString('hex');state={schema:1,stamp,base,legacyBase,createdAt:new Date().toISOString(),probes:knownKinds.map(kind=>({kind,business:`smoke-${stamp}-${kind}`,amount:kind==='legacyWechat'?'3.00':'0.01'}))};await save();}
    requireThat(state.schema===1&&state.base===base&&state.legacyBase===legacyBase&&/^[A-Za-z0-9-]{16,80}$/.test(state.stamp)&&Array.isArray(state.probes)&&state.probes.length===3&&knownKinds.every(kind=>state.probes.filter(entry=>entry.kind===kind).length===1),'SMOKE_STATE_INVALID');
    requireThat(!state.unexpectedPaid,'UNEXPECTED_PAID_STOPPED');
    for(const entry of state.probes)requireThat(entry.business===`smoke-${state.stamp}-${entry.kind}`&&entry.amount===(entry.kind==='legacyWechat'?'3.00':'0.01')&&(!entry.id||/^pay_[a-f0-9]{32}$/.test(entry.id)),'SMOKE_STATE_INVALID');
    ({github}=await installationGithub(options.privateKey));
    if(state.complete){const listing=await admin('/api/admin/clients'),existing=listing.clients?.find(client=>client.id===TEMP_CLIENT);requireThat(existing&&sameTemp(existing),'TEMP_CLIENT_CONFIGURATION_CONFLICT');temporaryValidated=true;await verifyPersistence();}
    else{
      const health=await request('/api/health');requireThat(health.ready===true&&health.acceptingPayments===true&&health.mode==='live'&&health.providers?.wechat?.configured===true,'SERVICE_NOT_READY');
      const temporary=await prepareTemporary();const allClients=await clients();
      // Recover every previously accepted request before creating any later probe.
      for(const entry of state.probes)if(await recover(entry))await notPaid((await detail(entry)).order);
      for(const kind of knownKinds){const entry=state.probes.find(value=>value.kind===kind);if(entry.closed&&entry.prepay&&entry.idempotent)continue;if(kind==='legacyWechat')await legacyProbe(entry,allClients);else await canonicalProbe(entry,temporary);}
      await verifyPersistence();
    }
  }catch(error){failure=safeCode(error);}
  finally{
    cleanupMode=true;
    if(state&&github&&!state.unexpectedPaid){
      for(const entry of state.probes||[]){try{await closeProbe(entry);}catch(error){cleanupFailure??=safeCode(error);if(state.unexpectedPaid)break;}}
      if(!state.unexpectedPaid){try{await pauseTemporary();}catch(error){cleanupFailure??=safeCode(error);}try{await verifyPersistence();}catch(error){cleanupFailure??=safeCode(error);}}
    }
    if(state){
      const providers=Object.fromEntries((state.probes||[]).map(entry=>[entry.kind,{prepayParametersVerified:entry.prepay===true,idempotencyVerified:entry.idempotent===true,queryVerified:entry.queryVerified===true,closed:entry.closed===true,queryAndCloseVerified:entry.queryClosed===true,remoteCloseConfirmed:entry.remoteCloseConfirmed===true,plaintextPartitioned:entry.plaintextPartitioned===true,amountValidated:entry.amountValidated===true,...(entry.kind==='legacyWechat'?{legacyProtocolMarker:entry.legacyProtocolMarker===true}:{})}]));
      const required=['prepayParametersVerified','idempotencyVerified','queryVerified','closed','queryAndCloseVerified','plaintextPartitioned','amountValidated'];
      const complete=!failure&&!cleanupFailure&&!state.unexpectedPaid&&state.temporaryPaused===true&&knownKinds.every(kind=>providers[kind]&&required.every(key=>providers[kind][key]===true)&&(kind!=='legacyWechat'||providers[kind].legacyProtocolMarker===true)&&(kind==='alipay'||providers[kind].remoteCloseConfirmed===true));
      state.complete=!!complete;state.lastCheckedAt=new Date().toISOString();state.lastError=failure||cleanupFailure||null;await save();
      const report={schema:1,at:state.lastCheckedAt,complete:state.complete,noPaymentLinkOpened:true,noChargeRequested:true,unexpectedPaid:state.unexpectedPaid===true,temporaryClientPaused:state.temporaryPaused===true,providers,...(failure?{error:failure}:{}),...(cleanupFailure?{cleanupError:cleanupFailure}:{})};
      await atomicJson(reportPath,report);process.stdout.write(json(report));if(!state.complete)process.exitCode=1;
    }else{process.stderr.write(json({complete:false,error:failure||'SMOKE_STATE_UNAVAILABLE'}));process.exitCode=1;}
    process.off('SIGINT',onInterrupt);process.off('SIGTERM',onInterrupt);await dispatcher?.close();await unlink(lockPath).catch(()=>{});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.code)?error.code:'SMOKE_OPERATION_FAILED';process.stderr.write(json({complete:false,error:code}));process.exitCode=1;});
