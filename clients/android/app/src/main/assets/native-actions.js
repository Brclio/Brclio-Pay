(() => {
  'use strict';
  if (location.origin !== 'https://pay.bornforthis.cn' || window.top !== window || window.__brclioPayNativeReady || !window.BrclioPayNative) return;
  window.__brclioPayNativeReady = true;
  const pending = new Map();
  let sequence = 0;
  const send = (action, body) => new Promise((resolve, reject) => {
    const id = `r${Date.now()}_${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('客户端操作超时，请重试')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    window.BrclioPayNative.postMessage(JSON.stringify({ id, action, ...body }));
  });
  window.BrclioPayNative.onmessage = (event) => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    const task = pending.get(message.id); if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.ok) task.resolve(); else task.reject(new Error(message.error || '客户端操作失败'));
  };
  const clipboard = { writeText: async (text) => send('copyText', { text: String(text) }) };
  try { Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true }); }
  catch { try { Object.defineProperty(navigator.clipboard, 'writeText', { value: clipboard.writeText }); } catch {} }
  let exporting = false;
  async function saveBlob(link) {
    if (exporting) throw new Error('请先完成当前导出');
    exporting = true;
    try {
      const response = await fetch(link.href); const blob = await response.blob();
      const mime = blob.type.split(';')[0];
      if (!['text/csv', 'application/zip'].includes(mime) || !blob.size || blob.size > 16 * 1024 * 1024) throw new Error('导出格式无效或文件超过 16 MiB');
      const transfer = `e${Date.now()}_${++sequence}`;
      await send('exportStart', { transfer, filename: link.download || (mime === 'text/csv' ? 'brclio-pay.csv' : 'brclio-pay.zip'), mime, bytes: blob.size });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let part = 0;
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 65536));
        let binary = ''; for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
        await send('exportChunk', { transfer, sequence: part++, data: btoa(binary) });
      }
      await send('exportFinish', { transfer });
    } finally { exporting = false; }
  }
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]'); if (!link) return;
    let target; try { target = new URL(link.href); } catch { return; }
    if (target.protocol === 'blob:' && target.origin === location.origin) {
      event.preventDefault(); event.stopImmediatePropagation();
      void saveBlob(link).catch(error => alert(error.message));
    } else if (event.isTrusted && target.protocol === 'https:' && target.origin !== location.origin) {
      event.preventDefault(); event.stopImmediatePropagation(); void send('external', { url: target.href });
    }
  }, true);
})();
