import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {fetch,ProxyAgent} from 'undici';
import {installationGithub,TARGET_REPOSITORY} from './migrate-data.mjs';
const base=process.argv[2]||'https://brclio-pay-unified.aiyuechuang.workers.dev';
const url=new URL(base);if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid HTTPS origin');
const env={...JSON.parse(await readFile('secrets/runtime-vars.json','utf8')),...JSON.parse(await readFile('wrangler.jsonc','utf8')).vars};
const manifest=JSON.parse(await readFile('package.json','utf8'));
const dispatcher=process.env.HTTPS_PROXY?new ProxyAgent(process.env.HTTPS_PROXY):undefined;
const hash=v=>createHash('sha256').update(v).digest('hex');
const hmac=(secret,value)=>createHmac('sha256',secret).update(value).digest('hex');
const request=async(path,headers={})=>{const start=Date.now();const r=await fetch(base+path,{headers,dispatcher,redirect:'manual',signal:AbortSignal.timeout(30000)});const bytes=Buffer.from(await r.arrayBuffer());return {status:r.status,bytes,ms:Date.now()-start,json:()=>JSON.parse(bytes.toString())};};
const signed=(path,client)=>{const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomBytes(16).toString('hex');return {'X-Brclio-Client':client.id,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Signature':hmac(client.apiSecret,`GET\n${path}\n${timestamp}\n${nonce}\n${hash('')}`)};};
const assert=(condition,code)=>{if(!condition)throw Error(code);};
try{
 const {github}=await installationGithub();const snapshot=await github.snapshot(TARGET_REPOSITORY,'main');
 const load=async file=>JSON.parse((await github.bytes(TARGET_REPOSITORY,file)).toString());
 const clients=await Promise.all(snapshot.files.filter(f=>/^registry\/clients\/[^/]+\.json$/.test(f.path)).map(load));
 const orders=await Promise.all(snapshot.files.filter(f=>/^orders\/\d{4}\/\d{2}\/pay_[a-f0-9]{32}\.json$/.test(f.path)).map(load));
 const health=(await request('/api/health')).json();assert(health.version===manifest.version&&health.ready&&health.acceptingPayments&&health.providers.wechat.configured,'HEALTH_FAILED');
 const seconds=Math.floor(Date.now()/1000),payload={sub:hash(env.ADMIN_EMAIL.trim().toLowerCase()),iat:seconds,exp:seconds+8*3600,csrf:hash(randomBytes(32)),credential:hash(env.ADMIN_PASSWORD_HASH)};
 const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');const headers={Cookie:'__Host-brclio_admin='+encoded+'.'+hmac(env.ADMIN_SESSION_SECRET,'admin-session-v1:'+encoded)};
 let historicalClientMissing=0;
 let maxReadMs=0;
 for(const client of clients){const result=await request('/api/v1/catalog',signed('/api/v1/catalog',client));assert(result.status===200,'CATALOG_FAILED');const catalog=result.json();assert(catalog.clientId===client.id&&Object.keys(catalog.skus).length===Object.keys(client.skus).length,'CATALOG_MISMATCH');maxReadMs=Math.max(maxReadMs,result.ms);}
 for(const order of orders){const client=clients.find(c=>c.id===order.clientId);const path=(client?'/api/v1/orders/':'/api/admin/orders/')+order.id,result=await request(path,client?signed(path,client):headers);assert(result.status===200,'ORDER_QUERY_FAILED');const view=client?result.json():result.json().order;if(!client)historicalClientMissing++;assert(view.id===order.id&&view.amount===order.amount&&view.status===order.status&&view.provider===order.provider,'ORDER_MISMATCH');maxReadMs=Math.max(maxReadMs,result.ms);}
 const summaryResult=await request('/api/admin/reports/summary?month=2026-10',headers);assert(summaryResult.status===200,'SUMMARY_FAILED');const summary=summaryResult.json();assert(summary.coverage.complete&&summary.coverage.sourceOrders===orders.length,'REPORTING_COVERAGE_FAILED');
 const expected=orders.filter(o=>o.status==='PAID').reduce((sum,o)=>sum+Math.round(Number(o.amount)*100),0);assert(summary.allTime.paidAmountCents===expected,'REPORTING_TOTAL_FAILED');
 let skills=0;for(const name of ['brclio-pay-integrate','brclio-alipay-integrate','brclio-wechatpay-integrate']){const r=await request('/api/skills/'+name+'.zip');assert(r.status===200&&r.bytes.readUInt32LE(0)===0x04034b50,'SKILL_DOWNLOAD_FAILED');skills++;}
 assert((await request('/api/v1/catalog')).status===401,'AUTH_BOUNDARY_FAILED');
 const report={base,at:new Date().toISOString(),health,clientsVerified:clients.length,ordersVerified:orders.length,historicalClientMissing,paidAmountCents:expected,reportingCoverage:summary.coverage,skillsVerified:skills,anonymousRejected:true,maxReadMs,repositoryRevision:snapshot.revision};
 await mkdir('secrets/verification',{recursive:true,mode:0o700});await writeFile('secrets/verification/'+url.hostname+'.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}finally{await dispatcher?.close();}
