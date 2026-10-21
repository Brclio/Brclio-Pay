// Read-only production admin verification; login/logout do not change platform configuration.
// Credentials arrive on stdin, remain in memory, and never enter diagnostic output.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fetch,ProxyAgent} from 'undici';
import {loadDeploymentExpectations} from './deployment-preflight.mjs';

let dispatcher;
const checks={};
const diagnostics={};
try {
  const input=JSON.parse(readFileSync(0,'utf8'));
  assert.equal(typeof input.email,'string');assert.equal(typeof input.password,'string');
  const base=new URL(process.env.BRCLIO_PAY_BASE_URL || 'https://pay.bornforthis.cn');
  assert.equal(base.protocol,'https:');assert.equal(base.pathname,'/');assert.equal(base.search,'');
  assert.equal(base.username,'');assert.equal(base.password,'');assert.equal(base.hash,'');
  const proxy=process.env.HTTPS_PROXY || process.env.https_proxy;
  dispatcher=proxy?new ProxyAgent(proxy):undefined;
  const call=(path,options={})=>fetch(new URL(path,base),{redirect:'error',...options,dispatcher,signal:AbortSignal.timeout(30000)});
  const anonymous=await call('/api/admin/skill.zip');
  checks.anonymousRejected=anonymous.status===401;await anonymous.body?.cancel();
  const staticZip=await call('/skills/brclio-pay-integrate.zip');
  checks.staticZipBlocked=staticZip.status===404;await staticZip.body?.cancel();
  const page=await call('/admin');
  checks.loginPage=page.status===200 && (await page.text()).includes('loginForm');
  const login=await call('/api/admin/login',{method:'POST',headers:{Origin:base.origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal(login.status,200);
  const setCookie=login.headers.get('Set-Cookie') || '';
  checks.secureCookie=setCookie.startsWith('__Host-brclio_admin=') && ['HttpOnly','Secure','SameSite=Strict','Path=/'].every(part=>setCookie.includes(part)) && !setCookie.includes('Domain=');
  const identity=await login.json();
  assert.equal(typeof identity.csrfToken,'string');
  const headers={Cookie:setCookie.split(';')[0]};
  const session=await call('/api/admin/session',{headers});
  checks.authenticatedSession=session.status===200 && (await session.json()).user?.email===input.email.trim().toLowerCase();
  for(const key of ['clients','grants','audit']) {
    const response=await call(`/api/admin/${key}`,{headers});
    const text=await response.text();
    if(!response.ok) {let code;try{code=JSON.parse(text)?.error?.code;}catch{}diagnostics[key]={status:response.status,...(typeof code==='string' && /^[A-Z_]{1,80}$/.test(code)?{code}:{})};}
    checks[`${key}Readable`]=response.status===200 && !text.includes(input.password) && !text.includes('apiSecret') && !text.includes('webhookSecret') && !text.includes('tokenHash');
  }
  const month=new Date(Date.now()+8*3600000).toISOString().slice(0,7);
  for(const [label,path] of [['summary',`/api/admin/reports/summary?month=${month}`],['orders',`/api/admin/reports/orders?month=${month}&limit=20`]]) {
    const response=await call(path,{headers});const data=await response.json();
    checks[`${label}Readable`]=response.status===200 && data.mode==='live' && typeof data.coverage?.complete==='boolean';
    if(!response.ok)diagnostics[label]={status:response.status,code:typeof data.error?.code==='string'?data.error.code:'UNKNOWN'};
  }
  const zip=await call('/api/admin/skill.zip',{headers});
  const bytes=new Uint8Array(await zip.arrayBuffer());
  checks.authenticatedSkill=zip.status===200 && bytes[0]===80 && bytes[1]===75 && bytes[2]===3 && bytes[3]===4;
  checks.skillHasNoPassword=!new TextDecoder().decode(bytes).includes(input.password);
  const health=await call('/api/health');
  const status=await health.json();
  const expected=loadDeploymentExpectations();
  checks.paymentConfigurationMatches=health.status===200 && status.version===expected.version && status.mode===expected.paymentMode
    && status.acceptingPayments===expected.paymentEnabled && (!expected.paymentEnabled || status.ready===true);
  const logout=await call('/api/admin/logout',{method:'POST',headers:{...headers,Origin:base.origin,'X-CSRF-Token':identity.csrfToken}});
  checks.logout=logout.status===200 && logout.headers.get('Set-Cookie')?.includes('Max-Age=0');
  await logout.body?.cancel();
  for(const passed of Object.values(checks))assert.equal(passed,true);
  console.log(JSON.stringify({adminProduction:true,...checks}));
} catch(error) {
  console.error(JSON.stringify({adminProduction:false,...checks,diagnostics,errorType:error?.name || 'Error'}));
  process.exitCode=1;
} finally {await dispatcher?.close();}
