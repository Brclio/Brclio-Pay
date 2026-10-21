'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('brclioClient',Object.freeze({
  getState:()=>ipcRenderer.invoke('client:state'),
  refresh:()=>ipcRenderer.invoke('client:refresh'),
  checkUpdate:()=>ipcRenderer.invoke('client:update-check'),
  downloadUpdate:()=>ipcRenderer.invoke('client:update-download'),
  downloadInstaller:()=>ipcRenderer.invoke('client:installer-download'),
  installUpdate:()=>ipcRenderer.invoke('client:update-install'),
  openBrowser:()=>ipcRenderer.invoke('client:browser'),
  onState:callback=>{if(typeof callback!=='function')return;const listener=(_event,state)=>callback(state);ipcRenderer.on('client:state',listener);return()=>ipcRenderer.removeListener('client:state',listener);}
}));
