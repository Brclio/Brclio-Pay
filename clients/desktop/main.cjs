'use strict';
const {app,BrowserWindow,WebContentsView,session,ipcMain,Menu,dialog,shell}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {connectionAfterLoad,CENTER,validHttps,remoteAdmin,remoteResource,trustedShell,safeFilename}=require('./security.cjs');
const {UpdateManager}=require('./update-manager.cjs');
const SHELL=path.join(__dirname,'ui','index.html'),TOP=136;
let window,view,updater,reportHttpStatus=null,externalPromptActive=false,externalPromptAfter=0;
let connection={phase:'loading',message:'正在连接支付后台…'};
const flag=(name)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;};
const smokeReport=flag('--client-smoke-report'),smokeProfile=flag('--client-profile');
const smoke=Boolean(smokeReport||smokeProfile);
let verificationProfileReused=false,previousSmokeVersion=null;
app.setName('Brclio Pay');
if(smoke&&(!smokeReport||!smokeProfile||!path.isAbsolute(smokeReport)||!path.isAbsolute(smokeProfile))) {console.error('Smoke mode requires absolute --client-smoke-report and --client-profile.');app.exit(2);}
if(smoke){
  const syncFs=require('node:fs'),profileMarker=path.join(smokeProfile,'.brclio-pay-verification.json');
  const normalized=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  try{
    if(normalized(smokeProfile)===normalized(app.getPath('userData')))throw Error('Real user profile is forbidden');
    if(syncFs.existsSync(smokeProfile)){
      if(syncFs.lstatSync(smokeProfile).isSymbolicLink())throw Error('Symlink profile is forbidden');
      const entries=syncFs.readdirSync(smokeProfile);
      if(entries.length){
        const markerStat=syncFs.lstatSync(profileMarker);if(!markerStat.isFile()||markerStat.isSymbolicLink()||markerStat.size>4096)throw Error('Verification profile marker required');
        const marker=JSON.parse(syncFs.readFileSync(profileMarker,'utf8'));
        if(marker.schema!==1||marker.applicationId!=='cn.bornforthis.brcliopay'||marker.purpose!=='client-smoke')throw Error('Invalid verification profile marker');
        verificationProfileReused=true;previousSmokeVersion=typeof marker.lastSuccessfulVersion==='string'?marker.lastSuccessfulVersion:null;
      }
    }
    syncFs.mkdirSync(smokeProfile,{recursive:true,mode:0o700});
    if(!verificationProfileReused)syncFs.writeFileSync(profileMarker,JSON.stringify({schema:1,applicationId:'cn.bornforthis.brcliopay',purpose:'client-smoke'}),{mode:0o600,flag:'wx'});
    app.setPath('userData',smokeProfile);
  }catch{console.error('Smoke profile must be fresh or a marked verification profile, and separate from the real user profile.');app.exit(2);}
}
app.setName('Brclio Pay');
function state(){return{version:app.getVersion(),connection,update:updater?.state||{phase:'idle',message:'初始化更新检查…'}};}
function publish(){if(window&&!window.isDestroyed())window.webContents.send('client:state',state());}
function status(phase,message){connection={phase,message};publish();}
function bounds(){if(window&&!window.isDestroyed()&&view){const [width,height]=window.getContentSize();view.setBounds({x:0,y:TOP,width,height:Math.max(0,height-TOP)});}}
async function openExplicit(url){
  if(!validHttps(url)||externalPromptActive||Date.now()<externalPromptAfter)return;
  externalPromptActive=true;
  try{const {response}=await dialog.showMessageBox(window,{type:'question',title:'在浏览器打开',message:'在系统浏览器中打开此 HTTPS 链接？',detail:url,buttons:['打开浏览器','取消'],defaultId:1,cancelId:1,noLink:true});
  if(response===0)await shell.openExternal(url);
  }finally{externalPromptActive=false;externalPromptAfter=Date.now()+1500;}
}
function secureRemote(ses){
  ses.setPermissionCheckHandler((wc,permission,origin,details)=>wc===view?.webContents && permission==='clipboard-sanitized-write' && origin===CENTER && details.isMainFrame && remoteAdmin(details.requestingUrl||wc.getURL()));
  ses.setPermissionRequestHandler((wc,permission,callback,details)=>callback(wc===view?.webContents&&permission==='clipboard-sanitized-write'&&remoteAdmin(wc.getURL())&&details.isMainFrame));
  ses.setDevicePermissionHandler(()=>false);
  ses.setDisplayMediaRequestHandler((_request,callback)=>callback({}));
  ses.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!remoteResource(details.url)}));
  ses.on('will-download',(event,item,wc)=>{
    const chain=item.getURLChain();
    if(wc!==view.webContents || !remoteAdmin(wc.getURL()) || !chain.length || chain.some(url=>!remoteResource(url)) || !/\.(csv|zip)$/i.test(item.getFilename())){event.preventDefault();return;}
    const filename=safeFilename(item.getFilename());
    item.setSaveDialogOptions({title:'保存后台导出文件',defaultPath:path.join(app.getPath('downloads'),filename),buttonLabel:'保存',properties:['showOverwriteConfirmation']});
    item.on('updated',()=>{const total=item.getTotalBytes();if(total>512*1024*1024||item.getReceivedBytes()>512*1024*1024)item.cancel();});
    item.once('done',(_e,result)=>{if(result==='completed')status('ready',`文件已保存：${filename}`);else if(result!=='cancelled')status('error','文件下载中断，请重试');});
  });
}
function remoteGuards(wc){
  wc.setWindowOpenHandler(details=>{if(validHttps(details.url))void openExplicit(details.url);return{action:'deny'};});
  wc.on('will-attach-webview',event=>event.preventDefault());
  wc.on('will-frame-navigate',event=>{if(!event.isMainFrame||!remoteAdmin(event.url)){event.preventDefault();if(event.isMainFrame&&validHttps(event.url))void openExplicit(event.url);}});
  wc.on('will-redirect',event=>{if(!remoteAdmin(event.url))event.preventDefault();});
  wc.on('will-navigate',event=>{if(!remoteAdmin(event.url)){event.preventDefault();if(validHttps(event.url))void openExplicit(event.url);}});
  wc.on('context-menu',(_event,params)=>{
    const items=[];
    if(params.isEditable)items.push({role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'});
    else if(params.selectionText)items.push({role:'copy',label:'复制'});
    if(validHttps(params.linkURL))items.push({label:'在浏览器打开链接…',click:()=>openExplicit(params.linkURL)});
    if(items.length)Menu.buildFromTemplate(items).popup({window});
  });
  wc.on('did-start-loading',()=>{reportHttpStatus=null;status('loading','正在载入支付后台…');});
  wc.on('did-navigate',(_e,_url,httpStatus)=>{reportHttpStatus=httpStatus;});
  wc.on('did-finish-load',()=>{const result=connectionAfterLoad(reportHttpStatus);status(result.phase,result.message);});
  wc.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)status('error','连接失败，请检查网络后重新连接');});
  wc.on('render-process-gone',()=>status('error','后台页面已停止，请重新连接'));
}
async function confirmStartup(){
  if(process.platform!=='darwin'||!app.isPackaged)return;
  const work=path.join(app.getPath('userData'),'updates',app.getVersion());
  try{const c=JSON.parse(await fs.readFile(path.join(work,'install.json'),'utf8'));const current=path.resolve(process.resourcesPath,'../..'),s=await fs.lstat(current);
    if(c.current===current&&c.version===app.getVersion()&&c.settings.applicationId==='cn.bornforthis.brcliopay'&&`${s.dev}:${s.ino}`===c.stagedInode)
      await fs.writeFile(path.join(work,'startup-confirmed.json'),JSON.stringify({version:app.getVersion(),applicationId:c.settings.applicationId,currentInode:c.stagedInode}),{mode:0o600});
  }catch{}
}
async function smokeCheck(){
  let exit=0,report;
  try{
    if(!remoteAdmin(view.webContents.getURL())||reportHttpStatus!==200)throw Error('login navigation failed');
    const isolation=await view.webContents.executeJavaScript('({nodeIntegration:typeof require!=="undefined"||typeof process!=="undefined",nativeBridge:typeof window.brclioClient!=="undefined",loginForm:!!document.getElementById("loginForm")})');
    const native=await window.webContents.executeJavaScript('({bridge:typeof window.brclioClient?.getState==="function",ready:!!document.getElementById("check")})');
    report={schema:1,applicationId:'cn.bornforthis.brcliopay',appVersion:app.getVersion(),isPackaged:app.isPackaged,platform:process.platform,arch:process.arch,pageUrl:view.webContents.getURL(),httpStatus:reportHttpStatus,remoteNodeIsolated:!isolation.nodeIntegration,remoteNativeBridgeAbsent:!isolation.nativeBridge,loginFormReady:isolation.loginForm,nativeShellReady:native.bridge&&native.ready,verificationProfileReused,previousSmokeVersion};
    if(!report.remoteNodeIsolated||!report.remoteNativeBridgeAbsent||!report.loginFormReady||!report.nativeShellReady)throw Error('isolation or login check failed');
    await fs.writeFile(path.join(smokeProfile,'.brclio-pay-verification.json'),JSON.stringify({schema:1,applicationId:'cn.bornforthis.brcliopay',purpose:'client-smoke',lastSuccessfulVersion:app.getVersion()}),{mode:0o600});
  }catch{exit=1;report={schema:1,applicationId:'cn.bornforthis.brcliopay',appVersion:app.getVersion(),isPackaged:app.isPackaged,platform:process.platform,arch:process.arch,smokePassed:false};}
  try{await fs.mkdir(path.dirname(smokeReport),{recursive:true,mode:0o700});await fs.writeFile(smokeReport,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});}catch{exit=1;}
  app.exit(exit);
}
app.on('certificate-error',(_event,_wc,_url,_error,_certificate,callback)=>callback(false));
app.on('web-contents-created',(_event,wc)=>wc.on('will-attach-webview',e=>e.preventDefault()));
async function createWindow(){
  const resources=app.isPackaged?path.join(process.resourcesPath,'update'):path.resolve(__dirname,'../shared');
  const settings=JSON.parse(await fs.readFile(path.join(resources,'release-settings.json'),'utf8')),key=await fs.readFile(path.join(resources,'update-public-key.pem'),'utf8');
  const ses=session.fromPartition(smoke?'persist:brclio-pay-smoke':'persist:brclio-pay-admin');
  window=new BrowserWindow({title:'Brclio Pay',width:1340,height:920,minWidth:860,minHeight:640,show:!smoke,backgroundColor:'#fefcf6',webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,devTools:!app.isPackaged}});
  view=new WebContentsView({webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,devTools:!app.isPackaged}});
  window.contentView.addChildView(view);bounds();secureRemote(ses);remoteGuards(view.webContents);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',e=>e.preventDefault());
  window.webContents.on('will-frame-navigate',e=>e.preventDefault());
  window.on('resize',bounds);window.on('closed',()=>{view.webContents.close();window=null;view=null;});
  updater=new UpdateManager({app,settings,key,publish:()=>publish()});
  const route=(channel,handler)=>ipcMain.handle(channel,async event=>{if(!trustedShell(event,window?.webContents,SHELL))throw Error('IPC origin denied');await handler();return state();});
  route('client:state',async()=>{});
  route('client:refresh',async()=>{if(view.webContents.isLoading())return;await view.webContents.loadURL(CENTER+'/admin');});
  route('client:browser',async()=>openExplicit(CENTER+'/admin'));
  route('client:update-check',async()=>updater.check());
  route('client:update-download',async()=>{
    if(updater.state.phase!=='available')return;
    const {response}=await dialog.showMessageBox(window,{type:'info',title:'下载新版本',message:`下载 Brclio Pay ${updater.manifest.version}？`,detail:updater.manifest.notes+(process.platform==='darwin'?'\n\n当前 Mac 安装包使用 Brclio 自签证书，未经 Apple 公证。首次安装请使用 DMG 内安装助手并明确确认；系统信任步骤不会自动跳过。':''),buttons:['下载更新','取消'],defaultId:1,cancelId:1,noLink:true});
    if(response===0)void updater.download();
  });
  route('client:installer-download',async()=>{if(updater.state.phase==='manual')void updater.download(true);});
  route('client:update-install',async()=>{
    if(updater.state.phase!=='ready')return;
    const dmg=updater.downloaded?.type==='dmg';
    const {response}=await dialog.showMessageBox(window,{type:'question',title:'安装已核验更新',message:dmg?'打开 DMG 安装包？':'保存当前操作并退出，安装新版本？',detail:dmg?'将打开已核验的 DMG。请运行其中“安装 Brclio Pay.command”，核验后明确确认安装到当前用户 Applications。':'请先保存后台编辑。客户端将退出；安装后重新打开。',buttons:[dmg?'打开 DMG':'退出并安装','取消'],defaultId:1,cancelId:1,noLink:true});
    if(response===0){try{if(dmg){await updater.verifyDownloaded();const error=await shell.openPath(updater.downloaded.path);if(error)throw Error('无法打开安装映像');}else await updater.install();}catch(e){updater.set({phase:'error',message:e.message});}}
  });
  await window.loadFile(SHELL);await confirmStartup();
  await view.webContents.loadURL(CENTER+'/admin').catch(()=>{});
  if(smoke){await smokeCheck();return;}
  setTimeout(()=>{if(window)void updater.check();},1500);
}
app.whenReady().then(()=>{
  const menu=[...(process.platform==='darwin'?[{label:'Brclio Pay',submenu:[{role:'about',label:'关于 Brclio Pay'},{type:'separator'},{role:'hide',label:'隐藏 Brclio Pay'},{role:'hideOthers',label:'隐藏其他应用'},{role:'unhide',label:'显示全部'},{type:'separator'},{role:'quit',label:'退出'}]}]:[]),{label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},{label:'窗口',submenu:[{role:'minimize',label:'最小化'},{role:'close',label:'关闭'}]}];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));return createWindow();
}).catch(()=>{if(smoke)app.exit(1);else{dialog.showErrorBox('Brclio Pay 无法启动','本地客户端资源未能读取，请重新安装完整客户端。');app.quit();}});
app.on('window-all-closed',()=>app.quit());
