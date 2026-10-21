'use strict';
const api=window.brclioClient, byId=id=>document.getElementById(id);
function render(state){
  byId('version').textContent=`v${state.version}`;
  byId('connection').textContent=state.connection.message;
  byId('connectionDot').className=`dot ${state.connection.phase}`;
  const u=state.update;
  byId('update').textContent=u.message;
  byId('progress').hidden=u.phase!=='downloading';byId('progress').value=u.progress||0;
  byId('check').disabled=['checking','downloading'].includes(u.phase);
  byId('download').hidden=u.phase!=='available';
  byId('installer').hidden=u.phase!=='manual';
  byId('install').hidden=u.phase!=='ready';
  byId('install').textContent=u.phase==='ready'&&u.message.startsWith('DMG')?'打开 DMG':'退出并安装';
}
function action(id,method){byId(id).addEventListener('click',async()=>{try{render(await method());}catch{byId('update').textContent='操作未完成，请重试。';}});}
action('refresh',api.refresh);action('browser',api.openBrowser);action('check',api.checkUpdate);action('download',api.downloadUpdate);action('installer',api.downloadInstaller);action('install',api.installUpdate);
api.onState(render);api.getState().then(render);
