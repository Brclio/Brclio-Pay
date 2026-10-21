(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'checkoutPanel', 'loadingState', 'emptyState', 'orderDetails', 'productName', 'orderSubject',
    'amountLabel', 'orderAmount', 'orderId', 'orderExpiry', 'copyOrder', 'copyFeedback',
    'statusBadge', 'statusTitle', 'statusCopy', 'paymentOptions', 'payButton',
    'refreshButton', 'returnLink', 'pollNote', 'errorNotice', 'sandboxNotice',
    'autoReturnNotice', 'autoReturnCopy', 'stayButton', 'orderProvider', 'wechatQrPanel', 'wechatQrCanvas', 'wechatQrHint',
  ].map((id) => [id, byId(id)]));

  const route = window.location.pathname.match(/^\/checkout\/([^/]+)\/?$/);
  let orderId = '';
  try { orderId = route ? decodeURIComponent(route[1]) : ''; } catch { /* Invalid route. */ }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) orderId = '';

  const storageKey = `brclio-pay:checkout:${orderId}`;
  let token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
  // Remove the fragment before any network request or onward navigation.
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  if (token && orderId) {
    try { window.sessionStorage.setItem(storageKey, token); } catch { /* Memory fallback. */ }
  } else if (orderId) {
    try { token = window.sessionStorage.getItem(storageKey) || ''; } catch { /* Storage unavailable. */ }
  }

  let order = null;
  let qrCode = '';
  const providerName = () => order?.provider === 'wechat' ? '微信支付' : '支付宝';
  const payLabel = () => order?.provider === 'wechat' ? '显示微信付款码' : order?.mode === 'sandbox' ? '前往支付宝沙箱 ↗' : '前往支付宝付款 ↗';
  function clearQr() { qrCode = ''; ui.wechatQrPanel.hidden = true; }
  let busy = false;
  let cooldownUntil = 0;
  let fatal = false;
  let unavailable = false;
  let pollTimer = null;
  let expiryTimer = null;
  let cooldownTimer = null;
  let redirecting = false;
  let pageActive = true;
  let pageEpoch = 0;
  let activeRequest = null;
  let watchPhase = '';
  let watchUntil = 0;
  let automaticChecks = 0;
  let lastReadAt = -Infinity;
  let returnTimer = null;
  let returnDeadline = null;
  let returnCancelled = false;
  const POLL_INTERVAL = 15000;
  const WATCH_WINDOW = 10 * 60 * 1000;
  const MAX_AUTOMATIC_CHECKS = 40;
  const RETURN_DELAY = 5000;

  class ApiError extends Error {
    constructor(status, code, message) {
      super('Checkout request failed');
      this.status = status;
      this.code = code;
      this.publicMessage = typeof message === 'string' ? message.slice(0, 240) : '';
    }
  }

  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(window.navigator.userAgent);
  const defaultChannel = document.querySelector(`input[name="channel"][value="${mobile ? 'wap' : 'page'}"]`);
  if (defaultChannel) defaultChannel.checked = true;

  function safeHttpsUrl(value) {
    if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url : null;
    } catch { return null; }
  }

  function paymentUrl(value) {
    const url = safeHttpsUrl(value);
    if (!url) return null;
    const host = url.hostname.toLowerCase();
    return ['alipay.com', 'alipaydev.com'].some((domain) => host === domain || host.endsWith(`.${domain}`)) ? url.href : null;
  }

  function validatedCodeUrl(value) {
    if (typeof value !== 'string' || value.length > 1024 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'weixin:' && url.hostname === 'wxpay' && url.pathname === '/bizpayurl'
        && !url.username && !url.password && !url.port && !url.hash && url.searchParams.getAll('pr').length === 1
        && [...url.searchParams.keys()].every((key) => key === 'pr') && !!url.searchParams.get('pr') ? value : null;
    } catch { return null; }
  }

  function isExpired() {
    return order && order.status === 'PENDING' && Date.parse(order.expiresAt) <= Date.now();
  }

  function syncButtons() {
    const canPay = order && order.status === 'PENDING' && !isExpired() && !fatal && !unavailable;
    ui.paymentOptions.hidden = !canPay;
    if (!canPay) clearQr();
    ui.payButton.disabled = busy || redirecting;
    ui.refreshButton.disabled = busy || redirecting || Date.now() < cooldownUntil;
    document.querySelectorAll('input[name="channel"]').forEach((input) => { input.disabled = busy || redirecting; });
    ui.checkoutPanel.setAttribute('aria-busy', String(busy));
  }

  function stopPolling() {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function needsPolling() {
    return order?.status === 'PENDING' || (order?.status === 'PAID' && order.fulfillmentStatus === 'pending');
  }

  function resetWatch() {
    automaticChecks = 0;
    watchUntil = Date.now() + WATCH_WINDOW;
  }

  function withinWatch() {
    return automaticChecks < MAX_AUTOMATIC_CHECKS && Date.now() < watchUntil;
  }

  function updatePolling() {
    stopPolling();
    if (!pageActive || document.hidden || fatal || redirecting || !needsPolling()) return;
    if (!withinWatch()) {
      ui.pollNote.textContent = order.status === 'PAID'
        ? '自动通知确认已暂停。请点击“刷新产品通知状态”继续确认，无需再次付款。'
        : '自动状态确认已暂停。请点击刷新继续确认付款结果。';
      return;
    }
    if (!busy) pollTimer = window.setTimeout(() => { pollTimer = null; void loadOrder(true); }, POLL_INTERVAL);
  }

  function stopAutomaticReturn() {
    if (returnTimer !== null) window.clearTimeout(returnTimer);
    returnTimer = null;
    returnDeadline = null;
  }

  function updateAutomaticReturn() {
    const destination = safeHttpsUrl(order?.returnUrl);
    const eligible = order?.status === 'PAID' && order.fulfillmentStatus === 'delivered'
      && order.mode === 'live' && destination && !returnCancelled && !fatal && !redirecting;
    ui.autoReturnNotice.hidden = !eligible;
    if (!eligible || !pageActive || document.hidden) { stopAutomaticReturn(); return; }
    if (returnDeadline === null) returnDeadline = Date.now() + RETURN_DELAY;
    const seconds = Math.max(0, Math.ceil((returnDeadline - Date.now()) / 1000));
    ui.autoReturnCopy.textContent = `${seconds} 秒后返回 ${order.productName} 查看开通结果。也可以选择留在此页。`;
    if (!seconds) {
      redirecting = true;
      stopPolling(); stopAutomaticReturn();
      if (expiryTimer !== null) window.clearInterval(expiryTimer);
      if (cooldownTimer !== null) window.clearTimeout(cooldownTimer);
      expiryTimer = null;
      cooldownTimer = null;
      syncButtons();
      try { window.location.assign(destination.href); }
      catch {
        redirecting = false; returnCancelled = true;
        ui.autoReturnNotice.hidden = true;
        ui.errorNotice.textContent = '暂时无法自动返回，请点击“返回产品”查看开通结果。';
        ui.errorNotice.hidden = false;
        syncButtons();
      }
    } else if (returnTimer === null) {
      returnTimer = window.setTimeout(() => { returnTimer = null; updateAutomaticReturn(); }, 1000);
    }
  }

  function updateExpiry() {
    if (!order) return;
    const date = new Date(order.expiresAt);
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
    const seconds = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
    const remaining = seconds >= 3600 ? `${Math.ceil(seconds / 3600)} 小时内有效` : `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
    ui.orderExpiry.textContent = order.status === 'PENDING' ? `${formatted}（北京时间） · ${seconds ? remaining : '付款时间已结束'}` : `${formatted}（北京时间）`;
    if (isExpired()) {
      if (expiryTimer !== null) window.clearInterval(expiryTimer);
      expiryTimer = null;
      ui.statusBadge.textContent = '等待最终确认';
      ui.statusTitle.textContent = '付款时间已结束';
      ui.statusCopy.textContent = '请刷新确认订单的最终状态。若未完成付款，请返回产品重新创建订单。';
    }
    syncButtons();
  }

  function validateOrder(value) {
    if (!value || value.id !== orderId || !['PENDING', 'PAID', 'CLOSED'].includes(value.status)
      || typeof value.subject !== 'string' || typeof value.productName !== 'string'
      || typeof value.amount !== 'string' || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value.amount)
      || value.currency !== 'CNY' || !Number.isFinite(Date.parse(value.expiresAt))
      || !['pending', 'delivered'].includes(value.fulfillmentStatus)
      || !['live', 'sandbox'].includes(value.mode)) {
      throw new ApiError(502, 'invalid_response');
    }
    return value;
  }

  function renderOrder(value) {
    order = validateOrder(value);
    if (order.provider !== undefined && !['alipay', 'wechat'].includes(order.provider)) throw new ApiError(502, 'invalid_response');
    if (order.provider !== 'wechat' || order.status !== 'PENDING' || isExpired()) clearQr();
    const phase = order.status === 'PENDING' ? 'payment' : order.status === 'PAID' && order.fulfillmentStatus === 'pending' ? 'fulfillment' : '';
    if (phase !== watchPhase) { watchPhase = phase; resetWatch(); }
    unavailable = false;
    ui.errorNotice.hidden = true;
    ui.loadingState.hidden = true;
    ui.emptyState.hidden = true;
    ui.orderDetails.hidden = false;
    ui.productName.textContent = order.productName;
    ui.orderSubject.textContent = order.subject;
    ui.orderId.textContent = order.id;
    const [whole, fraction = ''] = order.amount.split('.');
    ui.orderAmount.textContent = `${whole}.${fraction.padEnd(2, '0')}`;
    const channels = Array.isArray(order.channels) ? order.channels.filter((channel) => (order.provider === 'wechat' ? ['native'] : ['page', 'wap']).includes(channel)) : order.provider === 'wechat' ? ['native'] : ['page'];
    document.querySelectorAll('input[name="channel"]').forEach((input) => {
      input.closest('label').hidden = !channels.includes(input.value);
    });
    const selected = document.querySelector('input[name="channel"]:checked');
    if (!selected || !channels.includes(selected.value)) {
      const first = document.querySelector(`input[name="channel"][value="${channels[0] || 'page'}"]`);
      if (first) first.checked = true;
    }
    ui.orderProvider.textContent = providerName();
    ui.sandboxNotice.hidden = order.mode !== 'sandbox';
    ui.amountLabel.textContent = order.mode === 'sandbox' ? '测试金额' : '订单金额';
    ui.payButton.textContent = payLabel();
    ui.statusBadge.dataset.state = order.status;
    ui.refreshButton.hidden = order.status === 'CLOSED' || (order.status === 'PAID' && order.fulfillmentStatus === 'delivered');
    const destination = safeHttpsUrl(order.returnUrl);
    ui.returnLink.hidden = !destination;
    if (destination) {
      ui.returnLink.href = destination.href;
      ui.returnLink.textContent = `返回 ${order.productName} ↗`;
    } else ui.returnLink.removeAttribute('href');

    if (order.status === 'PAID') {
      ui.statusBadge.textContent = order.mode === 'sandbox' ? '测试付款已确认' : '已付款';
      const delivered = order.fulfillmentStatus === 'delivered';
      ui.statusTitle.textContent = delivered ? '产品已收到付款通知' : '付款成功，正在通知产品';
      ui.statusCopy.textContent = delivered
        ? '付款通知已经送达。你可以返回原产品查看开通结果。'
        : '款项已经确认，产品通知仍在送达中。请勿重复付款；可以刷新通知状态，或返回原产品查看。';
      if (order.mode === 'sandbox') ui.statusCopy.textContent = delivered
        ? '沙箱付款通知已经送达，仅用于测试，不代表正式产品权益开通。'
        : '沙箱付款已经确认，测试通知仍在送达中。此订单不产生真实收款或正式产品权益。';
      ui.refreshButton.textContent = '刷新产品通知状态';
      ui.pollNote.textContent = delivered ? '付款通知已送达，开通结果请在原产品查看。' : '页面显示时每 15 秒确认一次产品通知状态，最多自动确认 10 分钟。请勿重复付款。';
      document.title = '付款已确认 · Brclio Pay';
    } else if (order.status === 'CLOSED') {
      ui.statusBadge.textContent = '订单已关闭';
      ui.statusTitle.textContent = '这笔订单已结束';
      ui.statusCopy.textContent = '此订单已无法继续付款。如需购买，请返回产品重新创建订单。';
      ui.pollNote.textContent = '订单已关闭，状态检查已停止。';
      document.title = '订单已关闭 · Brclio Pay';
    } else {
      ui.statusBadge.textContent = '等待付款';
      ui.statusTitle.textContent = '准备好了，就去付款吧';
      ui.statusCopy.textContent = '请核对商品与金额。支付完成后，可回到此页面查看确认结果。';
      ui.refreshButton.textContent = '我已付款，刷新状态';
      ui.pollNote.textContent = '页面显示时每 15 秒检查一次订单状态，最多自动确认 10 分钟。';
      document.title = '确认订单 · Brclio Pay';
    }
    if (expiryTimer !== null) window.clearInterval(expiryTimer);
    expiryTimer = null;
    updateExpiry();
    if (order.status === 'PENDING' && !isExpired()) expiryTimer = window.setInterval(updateExpiry, 1000);
    updateAutomaticReturn();
  }

  async function request(suffix = '', method = 'GET', body) {
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/checkout/${encodeURIComponent(orderId)}${suffix}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(response.status, data?.ready === false ? 'not_ready' : data?.error?.code || 'request_failed', data?.error?.message);
      if (data?.ready === false) throw new ApiError(503, 'not_ready');
      if (!data) throw new ApiError(502, 'invalid_response');
      return data;
    } finally { window.clearTimeout(timeout); if (activeRequest === controller) activeRequest = null; }
  }

  function showProblem(error, phase = 'read') {
    let message = '暂时无法连接收银服务。请检查网络后重试。';
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) {
        fatal = true;
        message = '付款链接已失效，或当前会话没有访问权限。请返回原产品重新获取付款链接。';
      } else if (error.status === 404) {
        fatal = true;
        message = '没有找到这笔订单。请从原产品重新打开付款链接。';
      } else if (error.status === 503 || error.code === 'not_ready') {
        unavailable = true;
        message = '收银服务正在准备中，暂时无法付款。请稍后重试，或返回原产品。';
      } else if (error.status === 429) {
        message = '状态查询较频繁，请稍等片刻后再刷新。';
      } else if (error.status === 409) {
        unavailable = true;
        message = '订单状态已发生变化。请刷新后确认最新结果。';
      } else if (error.code === 'invalid_response') {
        unavailable = true;
        message = '暂时无法读取完整订单信息，请稍后刷新重试。';
      } else if (phase === 'pay') {
        message = `暂时无法打开${providerName()}。请稍后重试，或刷新订单确认状态。`;
      }
      if (error.publicMessage && ![401, 403, 404].includes(error.status)) message = error.publicMessage;
    }
    ui.errorNotice.textContent = message;
    ui.errorNotice.hidden = false;
    ui.refreshButton.hidden = fatal;
    if (!order || fatal) {
      ui.loadingState.hidden = true;
      ui.emptyState.hidden = !!order;
      ui.statusBadge.textContent = fatal ? '链接不可用' : '连接暂不可用';
      ui.statusBadge.dataset.state = 'error';
      ui.statusTitle.textContent = fatal ? '请从产品重新发起付款' : '稍后再试一次';
      ui.statusCopy.textContent = message;
      ui.refreshButton.textContent = '重新读取订单';
      ui.pollNote.textContent = '付款结果仍以服务端确认为准。';
    }
    if (fatal) {
      stopPolling();
      stopAutomaticReturn();
      ui.autoReturnNotice.hidden = true;
      try { window.sessionStorage.removeItem(storageKey); } catch { /* Storage unavailable. */ }
      if (expiryTimer !== null) window.clearInterval(expiryTimer);
      if (cooldownTimer !== null) window.clearTimeout(cooldownTimer);
      expiryTimer = null; cooldownTimer = null;
    }
    syncButtons();
  }

  async function loadOrder(automatic = false) {
    if (busy || fatal || redirecting || !pageActive) return;
    if (automatic) {
      if (document.hidden || !needsPolling() || !withinWatch()) { updatePolling(); return; }
      automaticChecks++;
    }
    busy = true;
    const epoch = pageEpoch;
    lastReadAt = Date.now();
    syncButtons();
    try { const value = await request(); if (pageActive && epoch === pageEpoch) renderOrder(value); }
    catch (error) { if (pageActive && epoch === pageEpoch) showProblem(error); }
    finally { busy = false; syncButtons(); updatePolling(); }
  }

  ui.refreshButton.addEventListener('click', async () => {
    if (busy || fatal || redirecting || Date.now() < cooldownUntil) return;
    busy = true;
    const epoch = pageEpoch;
    lastReadAt = Date.now();
    resetWatch();
    cooldownUntil = Date.now() + 3000;
    ui.refreshButton.textContent = '正在确认…';
    syncButtons();
    try {
      const value = order?.status === 'PAID' ? await request() : await request('/refresh', 'POST');
      if (pageActive && epoch === pageEpoch) renderOrder(value);
    }
    catch (error) { if (pageActive && epoch === pageEpoch) showProblem(error); }
    finally {
      busy = false;
      if (!order) ui.refreshButton.textContent = '重新读取订单';
      else if (!fatal) ui.refreshButton.textContent = order.status === 'PAID' ? '刷新产品通知状态' : '我已付款，刷新状态';
      syncButtons();
      updatePolling();
      if (cooldownTimer !== null) window.clearTimeout(cooldownTimer);
      cooldownTimer = pageActive && !fatal ? window.setTimeout(syncButtons, Math.max(0, cooldownUntil - Date.now())) : null;
    }
  });

  ui.payButton.addEventListener('click', async () => {
    if (busy || fatal || unavailable || !order || order.status !== 'PENDING' || isExpired()) return;
    busy = true;
    const epoch = pageEpoch;
    ui.payButton.textContent = order.provider === 'wechat' ? '正在准备付款码…' : '正在打开支付宝…';
    syncButtons();
    try {
      const channel = order.provider === 'wechat' ? 'native' : document.querySelector('input[name="channel"]:checked')?.value === 'wap' ? 'wap' : 'page';
      const result = await request('/pay', 'POST', { channel });
      if (!pageActive || epoch !== pageEpoch) return;
      if (order.provider === 'wechat') {
        const codeUrl = validatedCodeUrl(result.codeUrl);
        if (result.provider !== 'wechat' || result.channel !== 'native' || !codeUrl || !window.QRCodeLib?.toCanvas) throw new ApiError(502, 'invalid_response');
        await window.QRCodeLib.toCanvas(ui.wechatQrCanvas, codeUrl, { width: 224, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#1A1A2E', light: '#fefcf6' } });
        if (!pageActive || epoch !== pageEpoch || order.status !== 'PENDING' || isExpired()) { clearQr(); return; }
        qrCode = codeUrl; ui.wechatQrPanel.hidden = false;
        ui.wechatQrHint.textContent = mobile ? '请使用另一台设备的微信扫一扫。付款结果会在此页确认。' : '打开微信扫一扫。二维码在本页生成，付款后请等待服务端确认。';
        ui.payButton.textContent = '重新显示微信付款码';
        updatePolling();
        return;
      }
      if (result.provider !== undefined && result.provider !== 'alipay') throw new ApiError(502, 'invalid_response');
      const destination = paymentUrl(result.paymentUrl);
      if (!destination) throw new ApiError(502, 'invalid_response');
      redirecting = true;
      stopPolling();
      stopAutomaticReturn();
      window.location.assign(destination);
    } catch (error) {
      if (pageActive && epoch === pageEpoch) {
        showProblem(error, 'pay');
        ui.payButton.textContent = payLabel();
      }
    } finally { busy = false; syncButtons(); updatePolling(); }
  });

  ui.copyOrder.addEventListener('click', async () => {
    if (!order) return;
    try {
      await window.navigator.clipboard.writeText(order.id);
      ui.copyFeedback.textContent = '订单编号已复制';
    } catch { ui.copyFeedback.textContent = '暂时无法复制，请手动选中订单编号。'; }
  });

  ui.stayButton.addEventListener('click', () => {
    returnCancelled = true;
    stopAutomaticReturn();
    ui.autoReturnNotice.hidden = true;
    ui.pollNote.textContent = '已保留此页。付款通知已送达，可随时点击返回产品查看开通结果。';
  });
  ui.returnLink.addEventListener('click', () => {
    returnCancelled = true; stopAutomaticReturn(); stopPolling();
    ui.autoReturnNotice.hidden = true;
  });

  function resumeChecks() {
    if (!pageActive || document.hidden || fatal || redirecting) return;
    updateAutomaticReturn();
    if (needsPolling() && withinWatch() && Date.now() - lastReadAt >= 1000) void loadOrder(true);
    // Returning to an old tab deserves one fresh read even after its automatic
    // watch ended. This never renews the budget or starts another polling loop.
    else if (needsPolling() && !withinWatch() && Date.now() - lastReadAt >= POLL_INTERVAL) void loadOrder();
    else updatePolling();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopPolling(); stopAutomaticReturn(); }
    else resumeChecks();
  });
  window.addEventListener('focus', resumeChecks);
  window.addEventListener('pagehide', () => {
    pageActive = false;
    pageEpoch++;
    stopPolling();
    stopAutomaticReturn();
    activeRequest?.abort();
    clearQr();
    if (expiryTimer !== null) window.clearInterval(expiryTimer);
    if (cooldownTimer !== null) window.clearTimeout(cooldownTimer);
    expiryTimer = null; cooldownTimer = null;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      pageActive = true;
      redirecting = false;
      if (order?.status === 'PENDING' && !isExpired()) expiryTimer = window.setInterval(updateExpiry, 1000);
      updatePolling();
      resumeChecks();
    }
  });

  if (!orderId || !token) {
    fatal = true;
    showProblem(new ApiError(403, 'missing_token'));
    ui.checkoutPanel.setAttribute('aria-busy', 'false');
  } else { void loadOrder(); }
})();
