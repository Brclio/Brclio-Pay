'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const CENTER = 'https://pay.bornforthis.cn';
function validHttps(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port; } catch { return false; }
}
function remoteAdmin(value) {
  if (!validHttps(value)) return false;
  const u = new URL(value); return u.origin === CENTER && ['/admin', '/admin/'].includes(u.pathname) && !u.search;
}
function remoteResource(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith(`blob:${CENTER}/`)) return true;
  if (value.startsWith('data:image/')) return true;
  try { return validHttps(value) && new URL(value).origin === CENTER; } catch { return false; }
}
function trustedShell(event, contents, shellPath) {
  return Boolean(contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame
    && event.senderFrame?.url === pathToFileURL(shellPath).href);
}
function safeFilename(name) { return path.basename(String(name)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'download'; }
function connectionAfterLoad(code){return Number.isInteger(code)&&code>=200&&code<300?{phase:'ready',message:'已连接支付后台'}:{phase:'error',message:Number.isInteger(code)?`支付后台返回 HTTP ${code}，请稍后重新连接`:'未能确认后台连接，请重新连接'};}
module.exports = { connectionAfterLoad,CENTER, validHttps, remoteAdmin, remoteResource, trustedShell, safeFilename };
