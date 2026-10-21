'use strict';
// Run with the pinned desktop Electron executable. This uses a loopback-only fixture server,
// the production CSP, and a fresh Chromium profile; it never connects to the real payment API.
const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'brclio-pay-blob-csp-'));
app.setPath('userData',profile);
const csp=fs.readFileSync(path.join(root,'public/_headers'),'utf8').match(/Content-Security-Policy:\s*(.+)/)[1];
const script=fs.readFileSync(path.join(__dirname,'app/src/main/assets/native-actions.js'),'utf8');
let server,window;
app.whenReady().then(async()=>{
  server=http.createServer((request,response)=>{
    response.setHeader('Content-Security-Policy',csp);
    response.setHeader('Content-Type',request.url.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');
    if(request.url==='/admin')response.end('<!doctype html><meta charset="utf-8"><title>Isolated Android export fixture</title><body><script src="/bridge.js"></script><script src="/native-actions.js"></script><script src="/exercise.js"></script>');
    else if(request.url==='/native-actions.js')response.end(script.replace("location.origin !== 'https://pay.bornforthis.cn'",`location.origin !== '${origin}'`));
    else if(request.url==='/bridge.js')response.end(`
      window.__messages=[];window.__errors=[];window.__blobFetches=0;
      window.BrclioPayNative={postMessage(text){const message=JSON.parse(text);window.__messages.push(message);queueMicrotask(()=>window.BrclioPayNative.onmessage({data:JSON.stringify({id:message.id,ok:true})}));}};
      window.alert=message=>window.__errors.push(message);
      const originalFetch=window.fetch.bind(window);window.fetch=(url,options)=>{if(String(url).startsWith('blob:'))window.__blobFetches++;return originalFetch(url,options);};
    `);
    else if(request.url==='/exercise.js')response.end(`
      (async()=>{
        const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const body='order,amount\\r\\nfixture,3.00';
        const blockedUrl=URL.createObjectURL(new Blob([body],{type:'text/csv;charset=utf-8'}));
        const productionCspBlocksBlobFetch=await fetch(blockedUrl).then(()=>false,()=>true);URL.revokeObjectURL(blockedUrl);window.__blobFetches=0;
        const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([body],{type:'text/csv;charset=utf-8'}));link.download='fixture.csv';document.body.append(link);link.click();link.remove();URL.revokeObjectURL(link.href);
        for(let i=0;i<100&&!window.__messages.some(message=>message.action==='exportFinish');i++)await pause(10);
        await pause(10);
        const exported=window.__messages.filter(message=>message.action==='exportChunk').map(message=>atob(message.data)).join('');
        const finish=window.__messages.some(message=>message.action==='exportFinish');
        const revoked=document.createElement('a');revoked.href=URL.createObjectURL(new Blob(['test'],{type:'text/csv'}));revoked.download='revoked.csv';URL.revokeObjectURL(revoked.href);document.body.append(revoked);revoked.click();await pause(10);revoked.remove();
        const hidden=document.createElement('a');hidden.href=URL.createObjectURL(new Blob(['test'],{type:'text/csv'}));hidden.download='hidden.csv';window.dispatchEvent(new Event('pagehide'));document.body.append(hidden);hidden.click();await pause(10);hidden.remove();URL.revokeObjectURL(hidden.href);
        window.__result={productionCspBlocksBlobFetch,exportCompleted:finish,exactBytes:exported===body,noBlobNetworkFetch:window.__blobFetches===0,revokedAndHiddenRejected:window.__errors.length===2};
      })().catch(error=>window.__result={fixtureFailed:true,error:error.message});
    `);
    else{response.statusCode=404;response.end('Not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  // The real bridge's exact-origin guard is independently covered by unit tests. Only this
  // fixture copy substitutes the loopback origin so genuine Chromium can enforce the same CSP.
  global.origin=origin;
  const isolated=session.fromPartition('brclio-pay-android-csp-'+Date.now());
  isolated.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  isolated.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith(origin+'/')}));
  window=new BrowserWindow({show:false,webPreferences:{session:isolated,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  await window.loadURL(origin+'/admin');
  let result;
  for(let i=0;i<100;i++){
    result=await window.webContents.executeJavaScript('window.__result');if(result)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(result,'Fixture did not complete');assert.ok(!result.fixtureFailed,result.error);
  for(const name of ['productionCspBlocksBlobFetch','exportCompleted','exactBytes','noBlobNetworkFetch','revokedAndHiddenRejected'])assert.equal(result[name],true,name);
  const proof={schema:1,passed:true,isolatedLoopbackServer:true,productionCsp:csp,chromium:process.versions.chrome,electron:process.versions.electron,...result};
  fs.mkdirSync(path.join(root,'secrets/client-verification/android'),{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(root,'secrets/client-verification/android/blob-csp-proof.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(proof));
  window.destroy();server.close();app.exit(0);
}).catch(error=>{console.error('Android Blob CSP fixture failed:',error.message);if(window&&!window.isDestroyed())window.destroy();if(server)server.close();app.exit(1);});
