(() => {
  'use strict';

  const ids = [
    'loginView', 'dashboardView', 'loginForm', 'loginEmail', 'loginPassword', 'loginButton',
    'loginMessage', 'accountEmail', 'logoutButton', 'globalMessage', 'grantForm', 'grantClientId',
    'grantOrigins', 'grantModeLabel', 'resetGrantButton', 'generateGrantButton', 'grantMessage',
    'copySkillButton', 'skillVariant', 'downloadSkillLink', 'clientProviderAlipay', 'clientProviderWechat', 'outputPanel', 'outputTitle', 'outputMeta', 'taskOutput', 'copyOutputButton',
    'clearOutputButton', 'outputMessage', 'clientsLoading', 'clientsEmpty', 'clientsList',
    'clientCount', 'reloadClientsButton', 'manualSection', 'manualTitle', 'editContext',
    'newClientButton', 'clientForm', 'clientId', 'clientName', 'webhookUrl', 'returnOrigins',
    'skuRows', 'addSkuButton', 'clientEnabled', 'previewButton', 'editMessage', 'conflictNotice',
    'reloadCurrentButton', 'diffPanel', 'diffTarget', 'diffList', 'saveClientButton', 'cancelPreviewButton',
    'reloadGrantsButton', 'grantsMessage', 'grantsEmpty', 'grantsList',
    'pageTitle', 'pageSubtitle', 'overviewPage', 'ordersPage', 'productsPage', 'aiPage', 'platformsPage',
    'coverageNotice', 'coverageText', 'rebuildButton', 'summaryFilters', 'summaryMonth', 'summaryClient',
    'refreshSummaryButton', 'summaryMessage', 'reportMode', 'metricRevenue', 'metricPaid', 'metricPending',
    'metricClosed', 'metricDelivery', 'metricAllTime', 'metricAllTimeCount', 'trendSummary', 'revenueChart',
    'orderFilters', 'ordersMonth', 'ordersClient', 'ordersStatus', 'searchOrdersButton', 'exportOrdersButton',
    'ordersMessage', 'ordersRows', 'ordersEmpty', 'previousOrdersButton', 'nextOrdersButton', 'ordersPageLabel',
    'orderDetails', 'orderDetailFields', 'closeOrderDetailsButton', 'productClient', 'productsEmpty',
    'reloadOrderDetailsButton', 'orderDetailMessage', 'orderPaymentWarning', 'orderActionButtons', 'orderActionHint',
    'closePaymentOrderButton', 'reopenPaymentOrderButton', 'reconcilePaymentOrderButton',
    'orderActionForm', 'orderActionTitle', 'orderActionDescription', 'orderActionReason', 'orderActionAcknowledged',
    'orderActionConfirmationHint', 'confirmOrderActionButton', 'cancelOrderActionButton',
    'orderCheckoutPanel', 'orderCheckoutUrl', 'copyOrderCheckoutButton', 'orderCheckoutMessage',
    'orderAttemptsSection', 'orderAttemptsList', 'orderAuditList', 'orderAuditEmpty',
    'productAiButton', 'productEditorHost', 'platformEditorHost', 'grantDomainMode', 'grantPricingMode',
    'grantOriginsLabel', 'grantOriginsHint', 'grantPricingHint', 'reloadAuditButton', 'auditMessage', 'auditEmpty', 'auditList',
    'billsPage', 'billsAlipayButton', 'billsWechatButton', 'billsFilters', 'billsMonth', 'billsClient',
    'searchBillsButton', 'exportBillsButton', 'billsMessage', 'billsRows', 'billsEmpty', 'billsAmountLabel',
    'billsAmount', 'billsCount', 'billsCoverage', 'previousBillsButton', 'nextBillsButton', 'billsPageLabel',
    'environmentPage', 'environmentTitle', 'environmentMessage', 'environmentSource', 'environmentIntro',
    'environmentFilters', 'environmentSearch', 'environmentGroup', 'environmentCount', 'environmentGroups',
    'environmentEmpty', 'environmentNotes', 'reloadEnvironmentButton', 'refreshDataButton', 'cacheStatus',
  ];
  const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  let session = null;
  let clients = [];
  let clientsLoaded = false;
  let grantsLoaded = false;
  let busy = false;
  let grantMode = 'create';
  let editingClient = null;
  let pendingSave = null;
  let outputExpiry = null;
  let outputTimer = null;
  let outputKind = null;
  let outputGrantId = null;
  let activePage = 'overview';
  let editingProducts = false;
  let summaryLoaded = false;
  let ordersLoaded = false;
  let auditLoaded = false;
  let currentCoverage = null;
  let rebuildCursor = null;
  let orderItems = [];
  let orderNextCursor = null;
  let orderCursors = [null];
  let orderPageIndex = 0;
  let loadedOrderFilters = null;
  let selectedOrderId = null;
  let selectedOrderDetail = null;
  let pendingOrderAction = null;
  let orderCheckoutTimer = null;
  let billsProvider = 'alipay';
  let billsLoaded = false;
  let billItems = [];
  let billNextCursor = null;
  let billCursors = [null];
  let billPageIndex = 0;
  let loadedBillFilters = null;
  let billRevision = null;
  let billTotals = null;
  let environmentLoaded = false;
  let environmentGuide = null;
  let environmentStatuses = new Map();
  // Data stays in this document's memory; never persist it in browser storage.
  const readCache = new Map(), pendingReads = new Map(), readTimes = new Map();
  const CACHE_LIMIT = 100, CACHE_BYTES = 4 * 1024 * 1024;
  let cacheBytes = 0, cacheEpoch = 0, sessionVerifiedAt = 0, sessionCheck = null;
  const pageTitles = {
    overview: ['经营概览', '从已确认付款，了解每个产品的成交。'], orders: ['订单记录', '核对支付与产品通知，查看每一笔订单。'],
    products: ['商品与价格', '调整价格、销售状态和权益说明。'], ai: ['AI 接入', '复制完整任务，让 AI 对接产品与支付中心。'],
    platforms: ['平台与授权', '管理回调、返回域名和单平台短期授权。'],
    bills: ['支付账单', '分别查看支付宝、微信每月确认到账与产品通知。'],
    environment: ['环境变量', '从私有数据仓库读取维护说明，核对当前配置状态。'],
  };

  const skillLabels = { 'brclio-pay-integrate': '支付宝 + 微信', 'brclio-alipay-integrate': '仅支付宝', 'brclio-wechatpay-integrate': '仅微信' };
  const selectedSkillVariant = () => Object.hasOwn(skillLabels, ui.skillVariant.value) ? ui.skillVariant.value : 'brclio-pay-integrate';
  const providerLabel = (provider) => provider === 'wechat' ? '微信支付' : '支付宝';
  function syncSkillChoice() {
    const variant = selectedSkillVariant();
    ui.downloadSkillLink.href = `/api/admin/skill.zip?variant=${variant}`;
    ui.downloadSkillLink.setAttribute('download', `${variant}.zip`);
  }

  class ApiError extends Error {
    constructor(status, code, message) {
      super('Admin request failed');
      this.status = status;
      this.code = code;
      this.publicMessage = typeof message === 'string' ? message.slice(0, 300) : '';
    }
  }
  class InputError extends Error {}

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function message(target, text, kind = 'info') {
    target.textContent = text;
    target.classList.remove('notice-error', 'notice-success');
    if (kind !== 'info') target.classList.add(`notice-${kind}`);
    target.hidden = !text;
  }
  function syncControls() {
    document.querySelectorAll('[data-busy-lock]').forEach((control) => { control.disabled = busy; });
    ui.saveClientButton.disabled = busy || !pendingSave;
    ui.copyOutputButton.disabled = busy || (outputKind === 'grant' && outputExpiry !== null && Date.now() >= outputExpiry);
    ui.loginForm.setAttribute('aria-busy', String(busy));
    ui.grantForm.setAttribute('aria-busy', String(busy));
    ui.clientForm.setAttribute('aria-busy', String(busy));
    ui.exportOrdersButton.disabled = busy || orderItems.length === 0;
    ui.previousOrdersButton.disabled = busy || orderPageIndex === 0;
    ui.nextOrdersButton.disabled = busy || !orderNextCursor;
    ui.exportBillsButton.disabled = busy || !billsLoaded || !billTotals?.paidCount;
    ui.previousBillsButton.disabled = busy || billPageIndex === 0;
    ui.nextBillsButton.disabled = busy || !billNextCursor;
    ui.productAiButton.disabled = busy || !clients.some((client) => client.id === ui.productClient.value);
    ui.rebuildButton.disabled = busy || !currentCoverage || currentCoverage.complete;
    for (const [action, button] of [['close', ui.closePaymentOrderButton], ['reopen', ui.reopenPaymentOrderButton], ['reconcile', ui.reconcilePaymentOrderButton]]) {
      button.disabled = busy || !!pendingOrderAction || !selectedOrderDetail?.actions[action];
    }
    ui.reloadOrderDetailsButton.disabled = busy || !selectedOrderId || !!pendingOrderAction?.submission;
    ui.refreshDataButton.disabled = busy || !!pendingOrderAction;
    ui.orderActionForm.setAttribute('aria-busy', String(busy));
    ui.orderActionReason.readOnly = !!pendingOrderAction?.submission;
    ui.orderActionAcknowledged.disabled = busy || !!pendingOrderAction?.submission;
    ui.copyOrderCheckoutButton.disabled = busy || !ui.orderCheckoutUrl.value;
    if (!busy && pendingOrderAction?.submission) ui.confirmOrderActionButton.textContent = '重试并核对结果';
  }
  async function operation(button, progressText, action) {
    if (busy) return;
    busy = true;
    const previousLabel = button?.textContent;
    if (button && progressText) button.textContent = progressText;
    syncControls();
    try { await action(); }
    finally {
      busy = false;
      if (button && previousLabel !== undefined) button.textContent = previousLabel;
      syncControls();
    }
  }

  function updateCacheStatus() {
    const at = readTimes.get(activePage);
    ui.cacheStatus.textContent = at
      ? `页面缓存 · 本页最近读取于 ${timeLabel(new Date(at))}（北京时间）。外部有变更时，请点击“刷新数据”。`
      : '数据读取后保存在当前页面，切换与翻页优先复用；点击“刷新数据”获取最新内容。';
  }
  function invalidateReadCache() {
    cacheEpoch++; readCache.clear(); pendingReads.clear(); readTimes.clear(); cacheBytes = 0;
    clientsLoaded = false; grantsLoaded = false; summaryLoaded = false; ordersLoaded = false;
    billsLoaded = false; auditLoaded = false; environmentLoaded = false;
    updateCacheStatus();
  }
  function cacheKey(path) {
    const url = new URL(path, location.origin); url.searchParams.sort();
    if (url.origin !== location.origin || !['/clients', '/grants', '/audit', '/environment',
      '/reports/summary', '/reports/orders', '/reports/bills'].includes(url.pathname)) return null;
    return url.pathname + url.search;
  }
  function recordRead(path, at) {
    const name = path.split('?')[0];
    const pages = name === '/clients' ? ['products', 'ai', 'platforms']
      : name === '/grants' || name === '/audit' ? ['platforms']
      : { '/reports/summary': ['overview'], '/reports/orders': ['orders'], '/reports/bills': ['bills'], '/environment': ['environment'] }[name] || [];
    pages.forEach(page => readTimes.set(page, at)); updateCacheStatus();
  }
  async function ensureSession(force = false) {
    if (!session || (!force && Date.now() - sessionVerifiedAt < 60000)) return;
    if (sessionCheck) return sessionCheck;
    const current = session;
    const check = (async () => {
      const data = await networkRequest('/session');
      if (session !== current) throw new InputError('页面会话已变化，请重新读取。');
      if (data?.user?.email !== current.user.email || data?.csrfToken !== current.csrfToken) {
        showLogin('登录会话已变化，请重新确认身份。');
        throw new ApiError(401, 'ADMIN_LOGIN_REQUIRED', '登录会话已变化，请重新确认身份。');
      }
    })();
    sessionCheck = check;
    try { await check; } finally { if (sessionCheck === check) sessionCheck = null; }
  }
  async function request(path, { method = 'GET', body, fresh = false } = {}) {
    if (method !== 'GET' || fresh) invalidateReadCache();
    const key = method === 'GET' && session ? cacheKey(path) : null;
    if (!key) return networkRequest(path, { method, body });
    await ensureSession();
    const cached = readCache.get(key);
    if (cached) {
      readCache.delete(key); readCache.set(key, cached); recordRead(key, cached.at);
      return JSON.parse(cached.text);
    }
    if (pendingReads.has(key)) return JSON.parse(await pendingReads.get(key));
    const epoch = cacheEpoch;
    const pending = (async () => {
      const data = await networkRequest(path, { method, body });
      if (epoch !== cacheEpoch || !session) throw new InputError('页面状态已变化，请重新读取。');
      const serialized = JSON.stringify(data), size = serialized.length * 2, at = Date.now();
      if (size <= CACHE_BYTES) {
        while (readCache.size >= CACHE_LIMIT || cacheBytes + size > CACHE_BYTES) {
          const oldest = readCache.keys().next().value;
          cacheBytes -= readCache.get(oldest).size; readCache.delete(oldest);
        }
        readCache.set(key, { text: serialized, size, at }); cacheBytes += size;
      }
      recordRead(key, at); return serialized;
    })();
    pendingReads.set(key, pending);
    try { return JSON.parse(await pending); }
    finally { if (pendingReads.get(key) === pending) pendingReads.delete(key); }
  }
  async function networkRequest(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET' && path !== '/login' && session?.csrfToken) headers['X-CSRF-Token'] = session.csrfToken;
      const response = await fetch(`/api/admin${path}`, {
        method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
      });
      const data = response.status === 204 ? {} : await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(response.status, data?.error?.code, data?.error?.message);
      if (data === null) throw new ApiError(502, 'INVALID_RESPONSE', '管理服务暂时没有返回完整结果，请重试。');
      if (path === '/session') sessionVerifiedAt = Date.now();
      return data;
    } finally { window.clearTimeout(timeout); }
  }
  function report(error, target) {
    // Loader schema checks run after the JSON read. Never retain a bad 2xx body.
    if (error instanceof TypeError || error instanceof ApiError && error.status === 502) invalidateReadCache();
    const changedSnapshot = error instanceof ApiError && error.code === 'REPORTING_SNAPSHOT_CHANGED';
    if (changedSnapshot) { invalidateReadCache(); clearBills(); }
    if (error instanceof ApiError && error.status === 401 && session) {
      showLogin('会话已过期，请重新登录。');
      return;
    }
    const text = changedSnapshot ? '账本已有新变更，请点击顶部“刷新数据”从第一页重新读取，再查看或导出账单。'
      : error instanceof InputError ? error.message
      : error instanceof ApiError && error.publicMessage ? error.publicMessage
      : error?.name === 'AbortError' ? '请求超时，请稍后重试。'
      : '暂时无法连接管理服务，请检查网络后重试。';
    message(target, text, 'error');
  }

  function clearOutput() {
    if (outputTimer !== null) window.clearTimeout(outputTimer);
    outputTimer = null;
    outputExpiry = null;
    outputKind = null;
    outputGrantId = null;
    ui.taskOutput.value = '';
    ui.outputMeta.textContent = '';
    ui.outputMessage.textContent = '';
    ui.outputPanel.hidden = true;
  }
  function showLogin(notice = '') {
    invalidateReadCache(); sessionVerifiedAt = 0; sessionCheck = null;
    session = null;
    clients = [];
    clearOutput();
    resetGrant();
    resetEditor();
    ui.clientsList.replaceChildren();
    summaryLoaded = false; ordersLoaded = false; auditLoaded = false; currentCoverage = null; rebuildCursor = null;
    orderItems = []; orderNextCursor = null; orderCursors = [null]; orderPageIndex = 0; loadedOrderFilters = null;
    clearBills(); environmentLoaded = false; environmentGuide = null; environmentStatuses.clear();
    ui.environmentGroups.replaceChildren(); ui.environmentIntro.replaceChildren(); ui.environmentNotes.replaceChildren();
    ui.environmentSource.textContent = ''; ui.environmentCount.textContent = ''; message(ui.environmentMessage, '');
    ui.auditList.replaceChildren(); ui.auditEmpty.hidden = false; message(ui.auditMessage, '');
    ui.ordersRows.replaceChildren(); clearOrderDetails();
    ui.revenueChart.replaceChildren(); ui.coverageNotice.hidden = true;
    renderClientSelectors();
    for (const id of ['metricRevenue', 'metricPaid', 'metricPending', 'metricClosed', 'metricDelivery', 'metricAllTime']) ui[id].textContent = '—';
    ui.grantsList.replaceChildren();
    ui.grantsEmpty.textContent = '正在读取授权…';
    ui.grantsEmpty.hidden = false;
    message(ui.grantsMessage, '');
    ui.accountEmail.textContent = '';
    ui.accountEmail.hidden = true;
    ui.logoutButton.hidden = true;
    ui.dashboardView.hidden = true;
    ui.loginView.hidden = false;
    ui.loginPassword.value = '';
    message(ui.loginMessage, notice, notice ? 'error' : 'info');
    document.title = '管理员登录 · Brclio Pay';
  }
  function showDashboard(data) {
    if (!data?.user || typeof data.user.email !== 'string' || typeof data.csrfToken !== 'string' || !data.csrfToken) {
      throw new ApiError(502, 'INVALID_SESSION', '登录会话信息不完整，请重新登录。');
    }
    session = { user: { email: data.user.email }, csrfToken: data.csrfToken };
    ui.accountEmail.textContent = data.user.email;
    ui.accountEmail.hidden = false;
    ui.logoutButton.hidden = false;
    ui.loginView.hidden = true;
    ui.dashboardView.hidden = false;
    ui.loginPassword.value = '';
    message(ui.loginMessage, '');
    message(ui.globalMessage, '');
    activatePage(location.hash.slice(1), false);
  }

  function publicClient(value) {
    if (!value || typeof value.id !== 'string' || typeof value.name !== 'string'
      || typeof value.version !== 'string' || typeof value.webhookUrl !== 'string'
      || !Array.isArray(value.returnOrigins) || !value.skus || typeof value.skus !== 'object') {
      throw new ApiError(502, 'INVALID_CLIENT', '平台列表信息不完整，请刷新重试。');
    }
    // Keep an explicit public-field whitelist; credentials never enter UI state.
    const skus = Object.create(null);
    for (const [code, sku] of Object.entries(value.skus)) {
      if (typeof sku?.subject !== 'string' || typeof sku.amount !== 'string') throw new ApiError(502, 'INVALID_CLIENT', '商品配置暂时无法读取。');
      skus[code] = { subject: sku.subject, amount: sku.amount, enabled: sku.enabled !== false,
        ...(typeof sku.description === 'string' ? { description: sku.description } : {}),
        ...(typeof sku.entitlement === 'string' ? { entitlement: sku.entitlement } : {}) };
    }
    return { id: value.id, name: value.name, webhookUrl: value.webhookUrl,
      returnOrigins: value.returnOrigins.filter((origin) => typeof origin === 'string'),
      skus, providers: Array.isArray(value.providers) ? value.providers.filter((provider) => ['alipay', 'wechat'].includes(provider)) : ['alipay'], enabled: value.enabled !== false, version: value.version,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined };
  }
  async function loadClients({ fresh = false } = {}) {
    ui.clientsLoading.hidden = false;
    const result = await request('/clients', { fresh });
    if (!Array.isArray(result.clients)) throw new ApiError(502, 'INVALID_CLIENTS', '暂时无法读取平台列表。');
    clients = result.clients.map(publicClient);
    clientsLoaded = true;
    renderClients();
    ui.clientsLoading.hidden = true;
  }
  async function loadGrants({ fresh = false } = {}) {
    const result = await request('/grants', { fresh });
    if (!Array.isArray(result.grants)) throw new ApiError(502, 'INVALID_GRANTS', '暂时无法读取短期授权。');
    const grants = result.grants.map((value) => {
      if (!value || typeof value.id !== 'string' || typeof value.clientId !== 'string'
        || !['create', 'update'].includes(value.mode) || !Array.isArray(value.allowedOrigins)
        || !Number.isFinite(Date.parse(value.expiresAt))) throw new ApiError(502, 'INVALID_GRANTS', '短期授权信息不完整，请刷新。');
      return { id: value.id, clientId: value.clientId, mode: value.mode,
        allowedOrigins: value.allowedOrigins.filter((origin) => typeof origin === 'string'),
        domainMode: value.domainMode === 'auto' ? 'auto' : 'fixed', pricingMode: value.pricingMode === 'manual' ? 'manual' : 'detect',
        expiresAt: value.expiresAt, revokedAt: typeof value.revokedAt === 'string' ? value.revokedAt : null };
    });
    const rows = grants.map((grant) => {
      const active = !grant.revokedAt && Date.parse(grant.expiresAt) > Date.now();
      const row = element('article', `grant-row${grant.id === outputGrantId ? ' is-current' : ''}`);
      const content = element('div', '');
      const heading = element('div', 'grant-row-heading');
      heading.append(element('strong', '', grant.clientId), element('span', `admin-badge${active ? '' : ' disabled'}`, grant.revokedAt ? '已撤销' : active ? '有效' : '已到期'));
      content.append(heading,
        element('p', 'grant-row-meta', `${grant.mode === 'create' ? '新建平台' : '更新平台'} · 有效至 ${timeLabel(new Date(grant.expiresAt))}（北京时间）`),
        element('p', 'grant-row-meta', `${grant.domainMode === 'auto' ? 'AI 可添加项目所需来源' : '固定来源'} · ${grant.pricingMode === 'manual' ? '人工提供套餐' : 'AI 读取现有套餐'}`),
        element('p', 'grant-row-meta', `已纳入来源 · ${grant.allowedOrigins.length ? grant.allowedOrigins.join('、') : '等待 AI 识别项目域名'}`));
      row.append(content);
      if (active) {
        const revoke = element('button', 'admin-text-button revoke-grant-button', '撤销授权');
        revoke.type = 'button'; revoke.setAttribute('data-busy-lock', '');
        revoke.setAttribute('aria-label', `撤销 ${grant.clientId} 的${grant.mode === 'create' ? '新建' : '更新'}授权`);
        revoke.addEventListener('click', () => {
          void operation(revoke, '正在撤销…', async () => {
            try {
              await request(`/grants/${encodeURIComponent(grant.id)}/revoke`, { method: 'POST' });
              if (grant.id === outputGrantId) clearOutput();
              auditLoaded = false; await loadGrants();
              message(ui.grantsMessage, `已撤销 ${grant.clientId} 的这次授权。对应 AI 任务不能继续使用。`, 'success');
            } catch (error) { report(error, ui.grantsMessage); }
          });
        });
        row.append(revoke);
      }
      return row;
    });
    ui.grantsList.replaceChildren(...rows);
    ui.grantsEmpty.textContent = '目前没有可显示的短期授权。生成接入任务后，可在这里查看并撤销。';
    ui.grantsEmpty.hidden = grants.length > 0;
    grantsLoaded = true;
    message(ui.grantsMessage, '');
    syncControls();
  }
  function renderClients() {
    const rows = clients.map((client) => {
      const article = element('article', 'client-row');
      article.setAttribute('aria-label', `${client.name} 接入配置`);
      const content = element('div', 'client-row-content');
      const heading = element('div', 'client-heading');
      heading.append(element('h3', '', client.name), element('span', `admin-badge${client.enabled ? '' : ' disabled'}`, client.enabled ? '允许新订单' : '已停止新订单'));
      content.append(heading, element('p', 'client-id', client.id), element('p', 'client-address', `付款通知 · ${client.webhookUrl}`));
      content.append(element('p', 'client-products', `${client.providers.map(providerLabel).join(' + ')} · ${Object.keys(client.skus).length} 个商品 · 返回来源 ${client.returnOrigins.join('、')}`));
      const actions = element('div', 'client-row-actions');
      const grant = element('button', 'button button-secondary', '复制 AI 更新任务');
      grant.type = 'button'; grant.setAttribute('data-busy-lock', '');
      grant.setAttribute('aria-label', `复制 ${client.name} 的 AI 更新任务`);
      grant.addEventListener('click', () => {
        activatePage('ai');
        selectGrantClient(client);
        void generateGrant(grant);
      });
      const edit = element('button', 'admin-text-button', '编辑配置');
      edit.type = 'button'; edit.setAttribute('data-busy-lock', '');
      edit.setAttribute('aria-label', `编辑 ${client.name} 的配置`);
      edit.addEventListener('click', () => openEditor(client));
      const products = element('button', 'admin-text-button', '管理商品与价格');
      products.type = 'button'; products.setAttribute('data-busy-lock', '');
      products.addEventListener('click', () => { ui.productClient.value = client.id; openEditor(client, true); });
      actions.append(grant, products, edit); article.append(content, actions); return article;
    });
    ui.clientsList.replaceChildren(...rows);
    ui.clientCount.textContent = String(clients.length);
    ui.clientsEmpty.hidden = clients.length > 0;
    renderClientSelectors();
    syncControls();
  }

  function originsFromText(value, optional = false) {
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length && optional) return [];
    if (!lines.length) throw new InputError('请填写至少一个你控制的 HTTPS 来源。');
    const origins = lines.map((line) => {
      if (line.length > 300) throw new InputError('单个来源不能超过 300 个字符。');
      if (line.startsWith('https://*.')) {
        const domain = line.slice('https://*.'.length);
        const validWildcard = domain.length <= 253 && domain.includes('.')
          && domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
          && !/^[\d.]+$/.test(domain) && !domain.endsWith('.localhost') && !domain.endsWith('.local');
        if (!validWildcard) throw new InputError('子域名规则使用完整格式 https://*.brclio.com，不包含端口、路径或更多通配符。');
        return line;
      }
      let url;
      try { url = new URL(line); } catch { throw new InputError(`来源格式不正确：${line}`); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || url.pathname !== '/' || url.hostname.includes('*')) {
        throw new InputError('来源填写 HTTPS 协议、域名与可选端口，例如 https://app.brclio.com；不要填写路径或登录信息。子域名规则使用 https://*.brclio.com。');
      }
      if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) throw new InputError('来源需要使用公网 HTTPS 域名。');
      return url.origin;
    });
    const unique = [...new Set(origins)];
    if (unique.length > 50) throw new InputError('每个平台最多配置 50 个来源。');
    return unique;
  }
  function validId(value) {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(value)) throw new InputError('平台标识使用 2 至 64 位小写英文字母、数字、下划线或连字符，并以字母或数字开头。');
    return value;
  }
  function resetGrant() {
    grantMode = 'create';
    ui.grantForm.reset();
    ui.grantClientId.readOnly = false;
    ui.grantModeLabel.textContent = '新建平台任务';
    ui.grantModeLabel.classList.remove('update-mode');
    ui.resetGrantButton.hidden = true;
    syncGrantModes();
    syncSkillChoice();
    message(ui.grantMessage, '');
  }
  function selectGrantClient(client) {
    grantMode = 'update';
    ui.skillVariant.value = client.providers.length === 2 ? 'brclio-pay-integrate' : client.providers[0] === 'wechat' ? 'brclio-wechatpay-integrate' : 'brclio-alipay-integrate';
    syncSkillChoice();
    ui.grantClientId.value = client.id;
    ui.grantClientId.readOnly = true;
    let webhookOrigin = '';
    try { webhookOrigin = new URL(client.webhookUrl).origin; } catch { /* Public config is revalidated by the server. */ }
    ui.grantOrigins.value = [...new Set([webhookOrigin, ...client.returnOrigins].filter(Boolean))].join('\n');
    ui.grantModeLabel.textContent = `更新平台 · ${client.id}`;
    ui.grantModeLabel.classList.add('update-mode');
    ui.resetGrantButton.hidden = false;
    message(ui.grantMessage, '');
  }
  function timeLabel(date) {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  function setOutput(content, { title, meta, kind, expiresAt, grantId } = {}) {
    clearOutput();
    ui.outputTitle.textContent = title || 'AI 接入任务';
    ui.outputMeta.textContent = meta || '';
    ui.taskOutput.value = content;
    ui.copyOutputButton.textContent = kind === 'skill' ? '复制 Skill' : '复制任务';
    outputKind = kind || 'grant';
    outputGrantId = typeof grantId === 'string' ? grantId : null;
    outputExpiry = expiresAt ? Date.parse(expiresAt) : null;
    ui.outputPanel.hidden = false;
    if (outputExpiry !== null && Number.isFinite(outputExpiry)) {
      outputTimer = window.setTimeout(() => {
        ui.outputMessage.textContent = '此任务授权已到期，请重新生成后交给 AI。';
        syncControls();
      }, Math.max(0, outputExpiry - Date.now()));
    }
    syncControls();
  }
  async function copyOutput() {
    if (!ui.taskOutput.value) return false;
    try {
      await navigator.clipboard.writeText(ui.taskOutput.value);
      ui.outputMessage.textContent = outputKind === 'skill' ? 'Skill 已复制，可以交给 AI。' : '接入任务已复制，可以交给开发该产品的 AI。';
      return true;
    } catch {
      ui.outputMessage.textContent = `内容已生成。浏览器未完成自动复制，请点击“${outputKind === 'skill' ? '复制 Skill' : '复制任务'}”或手动选择下方内容。`;
      return false;
    }
  }
  async function generateGrant(button = ui.generateGrantButton) {
    if (!ui.grantForm.reportValidity()) return;
    await operation(button, '正在生成授权任务…', async () => {
      try {
        message(ui.grantMessage, '');
        clearOutput();
        const clientId = validId(ui.grantClientId.value.trim());
        const domainMode = ui.grantDomainMode.value;
        const pricingMode = ui.grantPricingMode.value;
        const allowedOrigins = originsFromText(ui.grantOrigins.value, domainMode === 'auto');
        if (grantMode === 'create' && clients.some((client) => client.id === clientId)) throw new InputError('此平台标识已经存在，请从平台列表生成它的更新任务。');
        const result = await request('/grants', { method: 'POST', body: { clientId, mode: grantMode, allowedOrigins, domainMode, pricingMode, skillVariant: selectedSkillVariant() } });
        if (typeof result.prompt !== 'string' || !result.prompt || !Number.isFinite(Date.parse(result.expiresAt))) {
          throw new ApiError(502, 'INVALID_GRANT', '任务结果不完整，请重新生成。');
        }
        activatePage('ai');
        setOutput(result.prompt, {
          title: grantMode === 'create' ? 'AI 平台接入任务' : 'AI 平台更新任务', kind: 'grant', expiresAt: result.expiresAt, grantId: result.grantId,
          meta: `${skillLabels[selectedSkillVariant()]} · 平台 ${clientId} · ${grantMode === 'create' ? '仅创建此平台' : '仅更新此平台'} · 授权至 ${timeLabel(new Date(result.expiresAt))}（北京时间）`,
        });
        const copied = await copyOutput();
        message(ui.grantMessage, copied ? '任务已生成并复制。短期权限仅适用于所选平台。' : '任务已生成，请在下方复制完整内容。', 'success');
        auditLoaded = false;
        try { await loadGrants(); } catch (error) { report(error, ui.grantsMessage); }
      } catch (error) { report(error, ui.grantMessage); }
    });
  }

  function invalidatePreview() {
    pendingSave = null;
    ui.diffPanel.hidden = true;
    syncControls();
  }
  function addSku(code = '', value = { subject: '', amount: '' }) {
    const row = element('div', 'sku-row sku-card');
    const existing = !!editingClient && Object.hasOwn(editingClient.skus, code);
    for (const [field, label, current] of [['code', '商品代码', code], ['subject', '商品名称', value.subject], ['amount', '价格（元）', value.amount]]) {
      const wrapper = element('label', `sku-field sku-${field}`);
      wrapper.append(element('span', 'sku-mobile-label', label));
      const input = element('input', 'admin-input');
      input.type = 'text'; input.required = true; input.value = current;
      input.dataset.field = field; input.setAttribute('data-busy-lock', ''); input.setAttribute('aria-label', label);
      input.maxLength = field === 'subject' ? 120 : field === 'code' ? 80 : 9;
      if (field === 'amount') input.inputMode = 'decimal';
      if (field === 'code') { input.autocomplete = 'off'; input.spellcheck = false; input.readOnly = existing; }
      wrapper.append(input); row.append(wrapper);
    }
    for (const [field, label, limit] of [['description', '商品简介（可选）', 500], ['entitlement', '购买权益 / 有效期说明（可选）', 1000]]) {
      const wrapper = element('label', `sku-field sku-${field}`);
      wrapper.append(element('span', 'sku-mobile-label', label));
      const input = element('textarea', 'admin-input'); input.rows = 2; input.maxLength = limit;
      input.value = value[field] || ''; input.dataset.field = field; input.setAttribute('aria-label', label); input.setAttribute('data-busy-lock', '');
      wrapper.append(input); row.append(wrapper);
    }
    const sale = element('label', 'sku-sale');
    const enabled = element('input', ''); enabled.type = 'checkbox'; enabled.checked = value.enabled !== false;
    enabled.dataset.field = 'enabled'; enabled.setAttribute('data-busy-lock', '');
    sale.append(enabled, element('span', '', '在售 · 允许新建此商品订单'));
    const remove = element('button', 'admin-text-button remove-sku', existing ? '停售商品' : '移除新商品');
    remove.type = 'button'; remove.setAttribute('data-busy-lock', '');
    function syncSale() { row.classList.toggle('sku-stopped', !enabled.checked); if (existing) remove.textContent = enabled.checked ? '停售商品' : '恢复在售'; }
    enabled.addEventListener('change', syncSale);
    remove.addEventListener('click', () => { if (existing) { enabled.checked = !enabled.checked; syncSale(); } else row.remove(); invalidatePreview(); });
    const footer = element('div', 'sku-footer'); footer.append(sale, remove); row.append(footer);
    ui.skuRows.append(row); syncSale(); syncControls();
  }
  function resetEditor() {
    editingClient = null;
    ui.clientForm.reset();
    ui.clientId.readOnly = false;
    ui.skuRows.replaceChildren();
    addSku();
    ui.manualTitle.textContent = '手动注册或编辑平台';
    ui.editContext.textContent = '注册一个新平台，已有平台可从列表进入编辑。';
    ui.conflictNotice.hidden = true;
    message(ui.editMessage, '');
    invalidatePreview();
  }
  function openEditor(client, products = false) {
    resetEditor();
    editingProducts = products;
    ui.manualSection.classList.toggle('products-mode', products);
    (products ? ui.productEditorHost : ui.platformEditorHost).append(ui.manualSection);
    activatePage(products ? 'products' : 'platforms');
    editingClient = client;
    ui.clientId.value = client.id; ui.clientId.readOnly = true;
    ui.clientName.value = client.name; ui.webhookUrl.value = client.webhookUrl;
    ui.returnOrigins.value = client.returnOrigins.join('\n'); ui.clientEnabled.checked = client.enabled;
    ui.clientProviderAlipay.checked = client.providers.includes('alipay'); ui.clientProviderWechat.checked = client.providers.includes('wechat');
    ui.skuRows.replaceChildren();
    Object.entries(client.skus).forEach(([code, sku]) => addSku(code, sku));
    if (!Object.keys(client.skus).length) addSku();
    ui.manualTitle.textContent = products ? `商品与价格 · ${client.name}` : `编辑平台 · ${client.name}`;
    ui.editContext.textContent = `正在编辑 ${client.id}。平台标识固定，保存时校验当前版本。`;
    ui.manualSection.open = true;
    ui.manualSection.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }
  function readConfig() {
    const id = validId(ui.clientId.value.trim());
    if (!editingClient && clients.some((client) => client.id === id)) throw new InputError('此平台标识已经存在，请从列表进入编辑，避免覆盖已有平台。');
    if (editingClient && id !== editingClient.id) throw new InputError('已有平台的标识不能更改。');
    const name = ui.clientName.value.trim();
    if (!name || name.length > 80) throw new InputError('产品名称需要为 1 至 80 个字符。');
    let webhook;
    try { webhook = new URL(ui.webhookUrl.value.trim()); } catch { throw new InputError('请填写完整的 HTTPS 付款通知地址。'); }
    if (webhook.protocol !== 'https:' || webhook.username || webhook.password || webhook.hash || webhook.search) {
      throw new InputError('付款通知地址需要使用 HTTPS，且不包含登录信息、查询参数或片段。');
    }
    const returnOrigins = originsFromText(ui.returnOrigins.value);
    const providers = [ui.clientProviderAlipay.checked ? 'alipay' : null, ui.clientProviderWechat.checked ? 'wechat' : null].filter(Boolean);
    if (!providers.length) throw new InputError('请至少选择一种支付方式。');
    const skus = Object.create(null);
    const rows = [...ui.skuRows.querySelectorAll('.sku-row')];
    if (!rows.length) throw new InputError('请至少配置一个商品。');
    for (const row of rows) {
      const code = row.querySelector('[data-field="code"]').value.trim();
      const subject = row.querySelector('[data-field="subject"]').value.trim();
      const amount = row.querySelector('[data-field="amount"]').value.trim();
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(code) || ['__proto__', 'constructor', 'prototype'].includes(code)) throw new InputError('商品代码使用 1 至 80 位英文字母、数字、下划线或连字符，并避免保留名称。');
      if (Object.hasOwn(skus, code)) throw new InputError(`商品代码重复：${code}`);
      if (!subject) throw new InputError(`请填写商品 ${code} 的名称。`);
      if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new InputError(`商品 ${code} 的价格应大于 0，最高 999999.99 元，最多保留两位小数。`);
      const [whole, fraction = ''] = amount.split('.');
      const description = row.querySelector('[data-field="description"]').value.trim();
      const entitlement = row.querySelector('[data-field="entitlement"]').value.trim();
      if (description.length > 500 || entitlement.length > 1000) throw new InputError(`商品 ${code} 的简介或权益说明超出长度限制。`);
      skus[code] = { subject, amount: `${whole}.${fraction.padEnd(2, '0')}`, enabled: row.querySelector('[data-field="enabled"]').checked,
        ...(description ? { description } : {}), ...(entitlement ? { entitlement } : {}) };
    }
    return { id, name, webhookUrl: webhook.href, returnOrigins, providers, skus, enabled: ui.clientEnabled.checked };
  }
  function skuSummary(skus) {
    return Object.entries(skus).sort(([a], [b]) => a.localeCompare(b)).map(([code, sku]) => `${code} · ${sku.subject} · ¥${sku.amount} · ${sku.enabled !== false ? '在售' : '停售'}${sku.description ? `\n简介：${sku.description}` : ''}${sku.entitlement ? `\n权益：${sku.entitlement}` : ''}`).join('\n');
  }
  function changesFor(config) {
    const before = editingClient;
    const fields = [
      ['平台标识', before?.id, config.id], ['产品名称', before?.name, config.name],
      ['支付方式', before?.providers.map(providerLabel).join(' + '), config.providers.map(providerLabel).join(' + ')],
      ['通知地址', before?.webhookUrl, config.webhookUrl],
      ['返回来源', before?.returnOrigins.join('\n'), config.returnOrigins.join('\n')],
      ['商品配置', before ? skuSummary(before.skus) : undefined, skuSummary(config.skus)],
      ['新订单', before ? before.enabled ? '允许创建' : '停止创建' : undefined, config.enabled ? '允许创建' : '停止创建'],
    ];
    return fields.filter(([, oldValue, newValue]) => oldValue !== newValue);
  }
  function previewConfig() {
    try {
      message(ui.editMessage, ''); ui.conflictNotice.hidden = true;
      const config = readConfig();
      const changes = changesFor(config);
      if (!changes.length) { invalidatePreview(); message(ui.editMessage, '没有发现需要保存的变更。'); return; }
      pendingSave = { config, expectedVersion: editingClient ? editingClient.version : 'absent' };
      ui.diffTarget.textContent = `${editingClient ? '更新已有平台' : '注册新平台'} · ${config.id}`;
      ui.diffList.replaceChildren(...changes.map(([label, before, after]) => {
        const row = element('div', ''); const value = element('dd', '');
        if (before !== undefined) value.append(element('span', 'diff-old', `当前：${before}`));
        value.append(element('span', 'diff-new', `${before === undefined ? '新增' : '改为'}：${after}`));
        row.append(element('dt', '', label), value); return row;
      }));
      ui.diffPanel.hidden = false; syncControls();
      ui.diffPanel.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
    } catch (error) { invalidatePreview(); report(error, ui.editMessage); }
  }

  function activatePage(name, updateHash = true) {
    activePage = Object.hasOwn(pageTitles, name) ? name : 'overview';
    if (activePage !== 'orders') clearOrderCheckout();
    document.querySelectorAll('[data-admin-page]').forEach((page) => { page.hidden = page.dataset.adminPage !== activePage; });
    document.querySelectorAll('[data-page-link]').forEach((link) => {
      if (link.dataset.pageLink === activePage) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    ui.pageTitle.textContent = pageTitles[activePage][0];
    ui.pageSubtitle.textContent = pageTitles[activePage][1];
    if (session) document.title = `${pageTitles[activePage][0]} · Brclio Pay`;
    if (updateHash && location.hash !== `#${activePage}`) history.replaceState(null, '', `#${activePage}`);
    ui.coverageNotice.hidden = !currentCoverage || currentCoverage.complete || !['overview', 'orders'].includes(activePage);
    updateCacheStatus();
  }
  async function loadActiveReport() {
    await ensureSession();
    if (activePage !== 'environment' && !clientsLoaded) await loadClients();
    if (activePage === 'overview' && !summaryLoaded) await loadSummary();
    if (activePage === 'orders' && !ordersLoaded) await loadOrders(true);
    if (activePage === 'platforms' && !grantsLoaded) await loadGrants();
    if (activePage === 'platforms' && !auditLoaded) await loadAudit();
    if (activePage === 'bills' && !billsLoaded) await loadBills(true);
    if (activePage === 'environment' && !environmentLoaded) await loadEnvironment();
  }
  async function loadAudit({ fresh = false } = {}) {
    message(ui.auditMessage, '正在读取操作记录…');
    try {
      const result = await request('/audit', { fresh });
      if (!Array.isArray(result.entries)) throw new ApiError(502, 'INVALID_AUDIT', '操作记录暂时无法读取。');
      const actions = { 'client.created': '注册平台', 'client.updated': '更新平台配置', 'grant.created': '生成短期授权',
        'grant.revoked': '撤销短期授权', 'integration.planned': 'AI 生成变更计划（尚未应用）', 'integration.applied': 'AI 应用平台配置' };
      const entries = result.entries.filter((entry) => entry && typeof entry.clientId === 'string' && typeof entry.at === 'string' && Object.hasOwn(actions, entry.action)).slice(-20).reverse();
      ui.auditList.replaceChildren(...entries.map((entry) => {
        const row = element('article', 'audit-row'), heading = element('div', 'audit-row-heading');
        heading.append(element('strong', '', actions[entry.action]), element('span', 'client-id', entry.clientId), element('time', '', orderTime(entry.at)));
        row.append(heading);
        const origins = Array.isArray(entry.addedOrigins) ? entry.addedOrigins.filter((origin) => typeof origin === 'string') : [];
        if (origins.length) row.append(element('p', 'audit-origins', `${entry.action === 'integration.applied' ? '实际新增来源' : '计划新增来源'} · ${origins.join('、')}`));
        return row;
      }));
      ui.auditEmpty.hidden = entries.length > 0;
      ui.auditEmpty.textContent = '目前没有操作记录。'; auditLoaded = true; message(ui.auditMessage, '');
    } catch (error) { report(error, ui.auditMessage); }
  }
  function renderClientSelectors() {
    for (const [select, emptyLabel] of [[ui.summaryClient, '全部平台'], [ui.ordersClient, '全部平台'], [ui.billsClient, '全部平台'], [ui.productClient, '请选择平台']]) {
      const selected = select.value;
      const first = element('option', '', emptyLabel); first.value = '';
      const options = clients.map((client) => { const option = element('option', '', `${client.name} · ${client.id}`); option.value = client.id; return option; });
      select.replaceChildren(first, ...options);
      select.value = clients.some((client) => client.id === selected) ? selected : '';
    }
    ui.productsEmpty.hidden = clients.length > 0;
  }
  function syncGrantModes() {
    const automatic = ui.grantDomainMode.value === 'auto';
    ui.grantOrigins.required = !automatic;
    ui.grantOriginsLabel.textContent = automatic ? '项目域名（可留空）' : '允许 AI 配置的 HTTPS 来源（必填）';
    ui.grantOrigins.placeholder = automatic ? '不知道域名可直接留空；已知时可填 https://你的域名' : '每行填写一个 HTTPS 来源，例如 https://app.example.com';
    ui.grantOriginsHint.textContent = automatic
      ? '不知道域名可直接留空。项目 AI 会在本次单平台授权有效期内识别并补充所需的公网 HTTPS 来源；新增来源会在后台记录。授权到期后可重新生成任务继续配置。'
      : 'AI 只能使用这些来源。每行填写一个你控制的 HTTPS 来源；https://*.brclio.com 可授权子域名，不包含主域名。';
    ui.grantPricingHint.textContent = ui.grantPricingMode.value === 'detect'
      ? 'AI 先读取项目现有商品、套餐、费用及权益；遇到相互矛盾或缺失的定价信息，再向你确认，不会编造价格。'
      : '把生成的任务交给项目 AI 时，同时提供商品名称、SKU、价格、购买权益和有效期；AI 会与现有实现核对后接入。';
  }
  function money(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(502, 'INVALID_REPORT', '统计金额暂时无法读取，请刷新重试。');
    return `¥${new Intl.NumberFormat('zh-CN').format(Math.floor(value / 100))}.${String(value % 100).padStart(2, '0')}`;
  }
  function count(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(502, 'INVALID_REPORT', '统计笔数暂时无法读取，请刷新重试。');
    return new Intl.NumberFormat('zh-CN').format(value);
  }
  function setCoverage(value) {
    if (!value || typeof value.complete !== 'boolean' || !Number.isSafeInteger(value.sourceOrders) || !Number.isSafeInteger(value.indexedOrders) || !Number.isSafeInteger(value.missingOrders)) throw new ApiError(502, 'INVALID_REPORT', '统计覆盖信息暂时无法读取。');
    currentCoverage = value;
    ui.coverageText.textContent = `账本共 ${count(value.sourceOrders)} 笔，已索引 ${count(value.indexedOrders)} 笔，待补建 ${count(value.missingOrders)} 笔。补建完成前，以下统计和列表可能不完整。`;
    ui.coverageNotice.hidden = value.complete || !['overview', 'orders'].includes(activePage);
    if (value.complete) rebuildCursor = null;
    syncControls();
  }
  function validMonth(value, optional = false) {
    if (!value && optional) return '';
    if (!/^[2-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(value)) throw new InputError('请选择 YYYY-MM 格式的月份。');
    return value;
  }
  function svgElement(tag, attributes = {}, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function renderTrend(daily, complete) {
    if (!Array.isArray(daily) || daily.length > 31) throw new ApiError(502, 'INVALID_REPORT', '每日统计暂时无法读取。');
    const max = Math.max(0, ...daily.map((day) => {
      if (!day || typeof day !== 'object' || typeof day.date !== 'string') throw new ApiError(502, 'INVALID_REPORT', '每日统计暂时无法读取。');
      money(day.paidAmountCents); count(day.paidCount); return day.paidAmountCents;
    }));
    const svg = svgElement('svg', { viewBox: '0 0 820 230', role: 'group', 'aria-label': '每天的成交金额与笔数' });
    svg.append(svgElement('line', { x1: 64, y1: 188, x2: 804, y2: 188, class: 'chart-baseline' }),
      svgElement('text', { x: 54, y: 191, 'text-anchor': 'end', class: 'chart-label' }, '0'),
      svgElement('text', { x: 54, y: 25, 'text-anchor': 'end', class: 'chart-label' }, max ? money(max).slice(1) : '0'));
    daily.forEach((day, index) => {
      const step = 740 / Math.max(1, daily.length), height = max ? day.paidAmountCents / max * 160 : 0;
      const x = 64 + step * index + step * 0.2;
      const detail = `${day.date}，成交 ${money(day.paidAmountCents)}，${count(day.paidCount)} 笔`;
      const group = svgElement('g', { tabindex: 0, role: 'img', 'aria-label': detail, class: 'chart-day' });
      group.append(svgElement('title', {}, detail), svgElement('rect', { x, y: 188 - height, width: step * 0.6, height, rx: 2, class: 'chart-bar' }),
        svgElement('rect', { x: 64 + step * index, y: 22, width: step, height: 166, class: 'chart-hit' }));
      if (index === 0 || (index + 1) % 5 === 0 || index === daily.length - 1) svg.append(svgElement('text', { x: x + step * 0.3, y: 213, 'text-anchor': 'middle', class: 'chart-label' }, String(index + 1)));
      svg.append(group);
    });
    ui.revenueChart.replaceChildren(svg);
    ui.revenueChart.setAttribute('aria-label', max ? `每日成交金额，最高 ${money(max)}。每个日期可聚焦查看。${complete ? '' : '当前仅包含已索引记录。'}` : complete ? '当月每日成交金额均为零。' : '已索引记录暂无成交金额，统计尚未完整。');
    ui.trendSummary.textContent = max ? `${ui.summaryMonth.value} · 按付款确认日期统计${complete ? '' : ' · 统计尚未完整'}` : complete ? '当月还没有已确认付款，实际营业额为 ¥0.00。' : '当前已索引记录暂无已确认付款，补建完成后再确认总额。';
  }
  function clearSummaryView() {
    for (const id of ['metricRevenue', 'metricPaid', 'metricPending', 'metricClosed', 'metricDelivery', 'metricAllTime']) ui[id].textContent = '—';
    ui.metricAllTimeCount.textContent = '所有已确认付款'; ui.revenueChart.replaceChildren();
    ui.trendSummary.textContent = '请选择筛选条件后查看统计。'; ui.reportMode.textContent = '尚未读取'; summaryLoaded = false;
  }
  async function loadSummary({ fresh = false } = {}) {
    clearSummaryView();
    message(ui.summaryMessage, '正在读取经营数据…');
    try {
      const month = validMonth(ui.summaryMonth.value), query = new URLSearchParams({ month });
      if (ui.summaryClient.value) query.set('clientId', ui.summaryClient.value);
      const result = await request(`/reports/summary?${query}`, { fresh });
      if (!['live', 'sandbox'].includes(result.mode) || !result.allTime) throw new ApiError(502, 'INVALID_REPORT', '经营数据暂时无法读取。');
      ui.metricRevenue.textContent = money(result.paidAmountCents);
      ui.metricPaid.textContent = count(result.paidCount); ui.metricPending.textContent = count(result.pendingCount);
      ui.metricClosed.textContent = count(result.closedCount); ui.metricDelivery.textContent = count(result.deliveryPendingCount);
      ui.metricAllTime.textContent = money(result.allTime.paidAmountCents); ui.metricAllTimeCount.textContent = `${count(result.allTime.paidCount)} 笔付款 · 当前平台筛选范围`;
      ui.reportMode.textContent = result.mode === 'live' ? '正式账本 / CNY' : '沙箱账本 / CNY';
      setCoverage(result.coverage); renderTrend(result.daily, result.coverage.complete); summaryLoaded = true; message(ui.summaryMessage, '');
    } catch (error) { report(error, ui.summaryMessage); }
  }
  function orderTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? `${date.getFullYear() > 0 ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : '—'}` : '—';
  }
  function statusLabel(status) { return { PAID: '已付款', PENDING: '待付款', CLOSED: '已关闭' }[status] || '未知状态'; }
  function clearOrderCheckout() {
    if (orderCheckoutTimer !== null) window.clearTimeout(orderCheckoutTimer);
    orderCheckoutTimer = null; ui.orderCheckoutUrl.value = ''; ui.orderCheckoutMessage.textContent = ''; ui.orderCheckoutPanel.hidden = true;
  }
  function clearOrderDetails() {
    selectedOrderId = null; selectedOrderDetail = null; pendingOrderAction = null;
    clearOrderCheckout(); ui.orderActionForm.reset(); ui.orderActionForm.hidden = true;
    ui.orderDetailFields.replaceChildren(); ui.orderAttemptsList.replaceChildren(); ui.orderAuditList.replaceChildren();
    ui.orderAuditEmpty.hidden = false; ui.orderDetails.hidden = true; ui.orderActionButtons.hidden = true; ui.orderActionHint.hidden = true;
    message(ui.orderDetailMessage, ''); message(ui.orderPaymentWarning, '');
  }
  function orderAmount(order) {
    if (Number.isSafeInteger(order.amountCents)) return money(order.amountCents);
    if (typeof order.amount === 'string' && /^\d+\.\d{2}$/.test(order.amount)) return money(Number(order.amount.replace('.', '')));
    throw new ApiError(502, 'INVALID_ORDER', '订单金额暂时无法读取，请刷新后重试。');
  }
  function readOrderDetail(result, id) {
    if (!result?.order || result.order.id !== id || typeof result.version !== 'string' || !result.version
      || !['PENDING', 'PAID', 'CLOSED'].includes(result.order.status)
      || !result.actions || ['close', 'reopen', 'reconcile'].some((action) => typeof result.actions[action] !== 'boolean')
      || !Array.isArray(result.audit)) throw new ApiError(502, 'INVALID_ORDER', '订单详情不完整，请刷新状态后重试。');
    orderAmount(result.order);
    return { order: result.order, version: result.version, actions: result.actions, audit: result.audit.slice(0, 20) };
  }
  function renderOrderDetail() {
    const detail = selectedOrderDetail;
    if (!detail) return;
    const order = detail.order;
    const fields = [['支付订单号', order.id], ['产品订单号', order.productOrderId], ['平台', order.clientId], ['支付方式', providerLabel(order.provider)], ['商品代码', order.sku], ['商品', order.subject],
      ['订单金额', orderAmount(order)], ['订单状态', statusLabel(order.status)], ['产品通知', order.status !== 'PAID' ? '尚未付款' : order.fulfillmentStatus === 'delivered' ? '已送达' : '待送达'],
      ['创建时间', orderTime(order.createdAt)], ['付款截止', orderTime(order.expiresAt)], ['付款时间', orderTime(order.paidAt)], ['支付平台交易号', order.tradeNo || '—'], ['账本', order.mode === 'live' ? '正式' : '沙箱']];
    if (order.originalExpiresAt && order.originalExpiresAt !== order.expiresAt) fields.splice(10, 0, ['原付款截止', orderTime(order.originalExpiresAt)]);
    ui.orderDetailFields.replaceChildren(...fields.map(([label, value]) => { const row = element('div', ''); row.append(element('dt', '', label), element('dd', '', value || '—')); return row; }));
    const available = Object.values(detail.actions).some(Boolean);
    ui.orderActionButtons.hidden = !available; ui.orderActionHint.hidden = !available;
    ui.closePaymentOrderButton.hidden = !detail.actions.close; ui.reopenPaymentOrderButton.hidden = !detail.actions.reopen;
    ui.reconcilePaymentOrderButton.hidden = !detail.actions.reconcile;
    const warnings = [];
    if (order.operation && !order.operation.expired) warnings.push(`这笔订单正在处理，请稍后点击“刷新状态”查看结果。处理窗口截止 ${orderTime(order.operation.expiresAt)}。`);
    if (order.operation?.expired) warnings.push('上一次订单操作未能完成，请先核实付款结果后再继续操作。');
    if (order.mayStillPayUntil && Date.parse(order.mayStillPayUntil) > Date.now()) warnings.push(`此前已发出的支付平台付款入口仍可能在 ${orderTime(order.mayStillPayUntil)} 前完成付款，请先核实付款结果，再决定后续操作。`);
    if (order.cleanupPending) warnings.push('这笔订单已确认付款，仍有其他付款记录待关闭。请点击“核实付款并补记”核实并关闭剩余未付款记录，避免重复付款。系统不会重复开通权益。');
    if (Array.isArray(order.duplicatePayments) && order.duplicatePayments.length) {
      warnings.push(`发现 ${order.duplicatePayments.length} 笔额外到账记录，系统不会重复开通权益。请人工核对到账并处理退款。`);
      for (const payment of order.duplicatePayments) warnings.push(`交易号 ${payment.tradeNo || '—'} · 金额 ${orderAmount(payment)} · 付款 ${orderTime(payment.paidAt)}`);
    }
    message(ui.orderPaymentWarning, warnings.join('\n'), 'error');
    const attempts = Array.isArray(order.paymentAttempts) ? order.paymentAttempts : [];
    ui.orderAttemptsSection.hidden = attempts.length === 0;
    ui.orderAttemptsList.replaceChildren(...attempts.map((attempt, index) => {
      const row = element('article', 'order-attempt-row'), heading = element('div', 'audit-row-heading');
      heading.append(element('strong', '', `第 ${index + 1} 次付款`), element('span', 'admin-badge', statusLabel(attempt.status)));
      if (attempt.id === order.activeAttempt?.id) heading.append(element('span', 'field-hint', '当前记录'));
      row.append(heading, element('p', 'order-history-meta', `付款截止 ${orderTime(attempt.expiresAt)}${attempt.paidAt ? ` · 付款 ${orderTime(attempt.paidAt)}` : ''}`));
      row.append(element('p', 'order-history-meta', attempt.id)); return row;
    }));
    const actionLabels = { close: '提前关闭', reopen: '重新启用', reconcile: '核实付款并补记' };
    const resultLabels = { running: '处理中', completed: '已完成', failed: '未完成' };
    ui.orderAuditList.replaceChildren(...detail.audit.map((entry) => {
      const row = element('article', 'audit-row'), heading = element('div', 'audit-row-heading');
      heading.append(element('strong', '', actionLabels[entry.action] || '订单操作'), element('span', 'admin-badge', resultLabels[entry.status] || '已记录'), element('time', '', orderTime(entry.completedAt || entry.startedAt)));
      row.append(heading, element('p', 'order-history-meta', `${entry.actor || '管理员'} · ${statusLabel(entry.beforeStatus)}${entry.afterStatus ? ` → ${statusLabel(entry.afterStatus)}` : ''}`), element('p', 'order-audit-reason', entry.reason || '—'));
      if (entry.message) row.append(element('p', 'order-history-meta', entry.message));
      return row;
    }));
    ui.orderAuditEmpty.hidden = detail.audit.length !== 0;
    ui.orderDetails.hidden = false; syncControls();
  }
  async function loadOrderDetails(id, scroll = false) {
    clearOrderDetails(); selectedOrderId = id; ui.orderDetails.hidden = false;
    message(ui.orderDetailMessage, '正在核对最新订单状态…');
    if (scroll) ui.orderDetails.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    try {
      selectedOrderDetail = readOrderDetail(await request(`/orders/${encodeURIComponent(id)}`), id);
      renderOrderDetail(); message(ui.orderDetailMessage, '');
    } catch (error) { report(error, ui.orderDetailMessage); }
  }
  function beginOrderAction(action) {
    if (busy || !selectedOrderDetail?.actions[action] || pendingOrderAction) return;
    clearOrderCheckout(); pendingOrderAction = { action, submission: null };
    const order = selectedOrderDetail.order;
    const copy = {
      close: ['提前关闭这笔订单', '将先核实当前付款结果，再停止这笔订单继续付款。若支付宝已确认成功，会按实际付款入账。', '已发出的支付平台付款入口可能仍需等待原付款期限结束。', '确认关闭'],
      reopen: ['重新启用这笔订单', '为原产品订单开启新的 10 分钟付款期限，保留原金额、商品和全部历史记录。', '生成新链接后，请重新发送给这位用户。', '确认重新启用'],
      reconcile: ['核实付款并补记', '向支付宝查询这笔订单的实际付款结果。只有确认付款成功，才补记账本并发送产品通知。', '无法通过人工勾选将未付款订单改为已付款。', '确认核实付款'],
    }[action];
    ui.orderActionTitle.textContent = `${copy[0]} · ${orderAmount(order)}`;
    ui.orderActionDescription.textContent = `${copy[1]} 产品订单号：${order.productOrderId}。`;
    ui.orderActionConfirmationHint.textContent = copy[2]; ui.confirmOrderActionButton.textContent = copy[3];
    ui.cancelOrderActionButton.textContent = '取消'; ui.orderActionForm.reset(); ui.orderActionForm.hidden = false;
    message(ui.orderDetailMessage, ''); syncControls(); ui.orderActionReason.focus();
  }
  function showOrderCheckout(url, order) {
    clearOrderCheckout();
    if (typeof url !== 'string') return;
    let parsed;
    try { parsed = new URL(url); } catch { /* A malformed link must never enter the clipboard. */ }
    const remaining = Date.parse(order.expiresAt) - Date.now();
    if (!parsed || parsed.protocol !== 'https:' || parsed.pathname !== `/checkout/${order.id}` || parsed.hash.length < 2 || !Number.isFinite(remaining) || remaining <= 0) {
      message(ui.orderDetailMessage, '订单状态已更新，但付款链接暂时无法使用，请刷新状态后核对。', 'error'); return;
    }
    ui.orderCheckoutUrl.value = parsed.href; ui.orderCheckoutPanel.hidden = false;
    ui.orderCheckoutMessage.textContent = `付款截止 ${orderTime(order.expiresAt)} · 请及时复制并重新发送给用户。`;
    orderCheckoutTimer = window.setTimeout(() => { clearOrderCheckout(); message(ui.orderDetailMessage, '本次付款期限已结束，请刷新订单状态。'); syncControls(); }, remaining);
  }
  async function submitOrderAction() {
    if (!pendingOrderAction || !selectedOrderDetail || (!pendingOrderAction.submission && !ui.orderActionAcknowledged.checked)) return;
    if (!pendingOrderAction.submission) {
      const reason = ui.orderActionReason.value.trim();
      if (!reason || reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(reason)) { ui.orderActionReason.focus(); message(ui.orderDetailMessage, '请填写 1 至 500 字的操作原因。', 'error'); return; }
      pendingOrderAction.submission = { expectedVersion: selectedOrderDetail.version, requestId: crypto.randomUUID(), reason };
    }
    const action = pendingOrderAction.action, id = selectedOrderId, submission = pendingOrderAction.submission;
    ui.cancelOrderActionButton.textContent = '停止重试'; syncControls();
    message(ui.orderDetailMessage, '正在核实并处理这笔订单，请稍候…');
    try {
      const result = await request(`/orders/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: submission });
      const detail = readOrderDetail(result, id);
      selectedOrderDetail = detail; pendingOrderAction = null; ui.orderActionForm.reset(); ui.orderActionForm.hidden = true;
      const index = orderItems.findIndex((order) => order.id === id);
      if (index >= 0) orderItems[index] = { ...orderItems[index], ...detail.order };
      summaryLoaded = false; ordersLoaded = false; billsLoaded = false; renderOrders(); renderOrderDetail();
      message(ui.orderDetailMessage, result.message || { close: '已核实并处理关闭请求。', reopen: '已重新启用，请复制新链接并重新发送给用户。', reconcile: '付款核实已完成，当前结果见订单状态。' }[action], 'success');
      if (action === 'reopen' && result.checkoutUrl) showOrderCheckout(result.checkoutUrl, detail.order);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![401, 429].includes(error.status)) {
        pendingOrderAction = null; ui.orderActionForm.hidden = true;
        selectedOrderDetail.actions = { close: false, reopen: false, reconcile: false }; renderOrderDetail();
        message(ui.orderDetailMessage, {
          ORDER_VERSION_CONFLICT: '订单已被其他操作或付款通知更新。请点击“刷新状态”核对后重新操作。',
          ORDER_ALREADY_PAID: '这笔订单已有确认付款记录。请刷新状态查看最新结果。',
          ORDER_NOT_REOPENABLE: '这笔订单当前不能重新启用。请刷新状态查看最新结果。',
          PREVIOUS_PAYMENT_WINDOW_OPEN: '此前的支付平台付款入口仍可能完成付款。请等待原付款期限结束，再刷新状态并核实付款。',
          ORDER_REOPEN_UNSAFE: '此前的支付平台付款入口仍可能完成付款。请等待原付款期限结束，再刷新状态并核实付款。',
          ORDER_ACTION_NOT_ALLOWED: '这笔订单当前不允许此操作。请刷新状态查看最新结果。',
          ORDER_ACTION_FAILED: '上一次操作未完成。请刷新状态核对结果，再重新填写原因并确认。',
          ORDER_OPERATION_IN_PROGRESS: '这笔订单正在处理。请稍后点击“刷新状态”核对结果，避免重复操作。',
          ORDER_ATTEMPT_LIMIT: '这笔订单已达到重新启用次数上限。请让产品创建新的业务订单。',
          CLIENT_DISABLED: '这笔订单所属平台已停用，当前无法重新启用。请核对平台配置后刷新状态。',
          SKU_DISABLED: '这笔订单的商品已停售，当前无法重新启用。请核对商品配置后刷新状态。',
        }[error.code] || '本次操作未能完成。请刷新订单状态，核对结果后重新操作。', 'error');
      } else {
        report(error, ui.orderDetailMessage);
        if (session && pendingOrderAction) {
          ui.orderDetailMessage.textContent += ' 本次结果可能尚未确定；请保留当前页面，使用同一次请求重试，避免重复处理。';
          ui.confirmOrderActionButton.textContent = '重试并核对结果';
        }
      }
    }
  }
  function renderOrders() {
    ui.ordersRows.replaceChildren(...orderItems.map((order) => {
      const row = element('tr', '');
      const identity = element('td', 'order-identity'); identity.append(element('strong', '', order.subject), element('span', '', order.id), element('span', '', `产品单号 ${order.productOrderId}`));
      const platform = element('td', ''); platform.append(element('span', '', clients.find((client) => client.id === order.clientId)?.name || order.clientId), element('small', '', `${order.clientId} · ${providerLabel(order.provider)}`));
      const amount = element('td', 'order-amount', money(order.amountCents));
      const status = element('td', ''); status.append(element('span', `admin-badge ${order.status === 'PAID' ? 'paid-status' : ''}`, statusLabel(order.status)), element('small', '', order.status !== 'PAID' ? '尚未付款' : order.fulfillmentStatus === 'delivered' ? '通知已送达' : '通知待送达'));
      const dates = element('td', 'order-dates'); dates.append(element('span', '', `创建 ${orderTime(order.createdAt)}`), element('small', '', order.paidAt ? `付款 ${orderTime(order.paidAt)}` : '北京时间'));
      const detail = element('td', ''); const button = element('button', 'admin-text-button', '查看'); button.type = 'button'; button.setAttribute('data-busy-lock', ''); button.addEventListener('click', () => { void operation(button, '正在读取…', () => loadOrderDetails(order.id, true)); }); detail.append(button);
      row.append(identity, platform, amount, status, dates, detail); return row;
    }));
    ui.ordersEmpty.hidden = orderItems.length !== 0;
    ui.ordersEmpty.textContent = orderNextCursor ? '本批扫描未找到匹配订单，可点击“下一页”继续查看。' : '当前筛选下没有订单。';
    ui.ordersPageLabel.textContent = `第 ${orderPageIndex + 1} 页 · 本页 ${orderItems.length} 笔`;
    syncControls();
  }
  async function loadOrders(reset = false, targetPage = orderPageIndex) {
    message(ui.ordersMessage, '正在读取订单…');
    try {
      if (reset) {
        loadedOrderFilters = { month: validMonth(ui.ordersMonth.value, true), clientId: ui.ordersClient.value, status: ui.ordersStatus.value };
        orderCursors = [null]; targetPage = 0; orderPageIndex = 0; orderItems = []; orderNextCursor = null; renderOrders(); clearOrderDetails();
      }
      const query = new URLSearchParams({ limit: '20' });
      for (const [key, value] of Object.entries(loadedOrderFilters || {})) if (value) query.set(key, value);
      if (orderCursors[targetPage]) query.set('cursor', orderCursors[targetPage]);
      const result = await request(`/reports/orders?${query}`);
      if (!Array.isArray(result.items) || result.items.length > 25 || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new ApiError(502, 'INVALID_REPORT', '订单列表暂时无法读取。');
      for (const order of result.items) { money(order.amountCents); extraPaymentTotal(order); if (!['PENDING', 'PAID', 'CLOSED'].includes(order.status)) throw new ApiError(502, 'INVALID_REPORT', '订单状态暂时无法读取。'); }
      orderItems = result.items; orderNextCursor = result.nextCursor; orderPageIndex = targetPage; ordersLoaded = true;
      setCoverage(result.coverage); renderOrders(); clearOrderDetails(); message(ui.ordersMessage, '');
    } catch (error) { report(error, ui.ordersMessage); }
  }
  function clearBills() {
    billsLoaded = false; billItems = []; billNextCursor = null; billCursors = [null]; billPageIndex = 0;
    loadedBillFilters = null; billRevision = null; billTotals = null;
    ui.billsAmount.textContent = '—'; ui.billsCount.textContent = '—';
    ui.billsCoverage.textContent = '等待查询账单。';
    renderBills();
  }
  function syncBillProvider() {
    ui.billsAlipayButton.setAttribute('aria-pressed', String(billsProvider === 'alipay'));
    ui.billsWechatButton.setAttribute('aria-pressed', String(billsProvider === 'wechat'));
    ui.billsAmountLabel.textContent = `${providerLabel(billsProvider)} · 当月实收`;
  }
  function billQuery(filters, cursor = null) {
    const query = new URLSearchParams({ ...filters, limit: '25' });
    if (cursor) query.set('cursor', cursor);
    return `/reports/bills?${query}`;
  }
  function readBillReport(result, filters) {
    const invalid = () => { throw new ApiError(502, 'INVALID_REPORT', '账单数据不完整，请刷新查询。'); };
    if (!result || !Array.isArray(result.items) || result.items.length > 25
      || !(result.nextCursor === null || (typeof result.nextCursor === 'string' && result.nextCursor.length > 0))
      || result.provider !== filters.provider || result.month !== filters.month
      || (result.clientId || '') !== (filters.clientId || '')
      || result.currency !== 'CNY' || result.basis !== 'payment-confirmed' || result.timezone !== 'Asia/Shanghai'
      || typeof result.revision !== 'string' || !result.revision
      || result.coverage?.complete !== true || result.coverage?.source !== 'canonical') invalid();
    count(result.paidCount); money(result.paidAmountCents);
    for (const item of result.items) {
      if (!item || item.provider !== filters.provider || item.currency !== 'CNY'
        || !['primary', 'duplicate'].includes(item.kind)
        || !['orderId', 'clientId', 'productOrderId', 'sku', 'subject', 'tradeNo', 'paidAt'].every((key) => typeof item[key] === 'string')
        || !Number.isFinite(Date.parse(item.paidAt)) || (filters.clientId && item.clientId !== filters.clientId)) invalid();
      money(item.amountCents);
      if (item.amount !== `${Math.floor(item.amountCents / 100)}.${String(item.amountCents % 100).padStart(2, '0')}`) invalid();
    }
    return result;
  }
  function renderBills() {
    ui.billsRows.replaceChildren(...billItems.map((item) => {
      const row = element('tr', '');
      const date = element('td', 'order-dates', orderTime(item.paidAt));
      const identity = element('td', 'order-identity');
      identity.append(element('strong', '', item.productOrderId), element('span', '', item.orderId));
      if (item.kind === 'duplicate') identity.append(element('small', '', '额外到账 · 不重复开通权益'));
      const product = element('td', 'order-identity');
      product.append(element('strong', '', clients.find((client) => client.id === item.clientId)?.name || item.clientId),
        element('span', '', `${item.subject} · ${item.sku}`), element('small', '', item.clientId));
      const trade = element('td', 'bill-trade-number', item.tradeNo || '—');
      const amount = element('td', 'order-amount', money(item.amountCents));
      const delivery = element('td', '');
      delivery.append(element('span', `admin-badge${item.fulfillmentStatus === 'delivered' ? ' paid-status' : ''}`, item.fulfillmentStatus === 'delivered' ? '通知已送达' : '通知待送达'));
      row.append(date, identity, product, trade, amount, delivery); return row;
    }));
    ui.billsEmpty.hidden = billItems.length !== 0;
    ui.billsEmpty.textContent = billsLoaded ? '当前筛选下没有已确认付款。' : '选择月份与平台后查询账单。';
    ui.billsPageLabel.textContent = `第 ${billPageIndex + 1} 页 · 本页 ${billItems.length} 笔`;
    syncBillProvider(); syncControls();
  }
  async function loadBills(reset = false, targetPage = billPageIndex) {
    message(ui.billsMessage, '正在读取确认付款账单…');
    try {
      if (reset) {
        const filters = { provider: billsProvider, month: validMonth(ui.billsMonth.value), ...(ui.billsClient.value ? { clientId: ui.billsClient.value } : {}) };
        clearBills(); loadedBillFilters = filters; targetPage = 0;
      }
      const result = readBillReport(await request(billQuery(loadedBillFilters, billCursors[targetPage])), loadedBillFilters);
      if (!reset && result.revision !== billRevision) throw new ApiError(409, 'REPORTING_SNAPSHOT_CHANGED', '请点击“刷新数据”重新读取账单。');
      billRevision = result.revision; billItems = result.items; billNextCursor = result.nextCursor; billPageIndex = targetPage;
      billTotals = { paidCount: result.paidCount, paidAmountCents: result.paidAmountCents }; billsLoaded = true;
      ui.billsAmount.textContent = money(result.paidAmountCents); ui.billsCount.textContent = count(result.paidCount);
      ui.billsCoverage.textContent = `${loadedBillFilters.month} · ${providerLabel(loadedBillFilters.provider)} · 已核对原始账本全部订单 · 金额与笔数为所选月份全部记录`;
      renderBills(); message(ui.billsMessage, '');
    } catch (error) { report(error, ui.billsMessage); }
  }
  async function exportBills() {
    if (!loadedBillFilters || !billsLoaded || !billTotals?.paidCount) return;
    const filters = { ...loadedBillFilters }, seenCursors = new Set(), seenPayments = new Set();
    const items = []; let cursor = null, expectedRevision = billRevision, expectedCount = billTotals.paidCount, expectedAmount = billTotals.paidAmountCents;
    try {
      do {
        const result = readBillReport(await request(billQuery(filters, cursor)), filters);
        if (expectedRevision !== null && (result.revision !== expectedRevision || result.paidCount !== expectedCount || result.paidAmountCents !== expectedAmount)) {
          throw new ApiError(409, 'REPORTING_SNAPSHOT_CHANGED', '导出期间账本发生变更，请点击“刷新数据”后重新导出。');
        }
        expectedRevision = result.revision; expectedCount = result.paidCount; expectedAmount = result.paidAmountCents;
        for (const item of result.items) {
          const identity = `${item.orderId}:${item.kind}:${item.attemptId || ''}:${item.tradeNo}`;
          if (seenPayments.has(identity)) throw new InputError('账单分页出现重复记录，未生成文件，请点击“刷新数据”后导出。');
          seenPayments.add(identity); items.push(item);
        }
        if (items.length > expectedCount || (result.nextCursor && !result.items.length)) throw new InputError('账单分页结果与月份汇总不一致，未生成文件，请点击“刷新数据”后重试。');
        message(ui.billsMessage, `正在读取完整月份账单… 已读取 ${count(items.length)} / ${count(expectedCount)} 笔。`);
        cursor = result.nextCursor;
        if (cursor && seenCursors.has(cursor)) throw new InputError('账单分页游标重复，未生成文件，请点击“刷新数据”后导出。');
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      if (items.length !== expectedCount || items.reduce((sum, item) => sum + item.amountCents, 0) !== expectedAmount) {
        throw new InputError('账单明细与月份汇总不一致，未生成文件，请点击“刷新数据”后重试。');
      }
      const rows = [['支付方式', '付款时间（北京时间）', '产品订单号', '支付订单号', '平台', '商品代码', '商品', '支付平台交易号', '实收金额（元）', '到账类型', '产品通知'],
        ...items.map((item) => [providerLabel(item.provider), orderTime(item.paidAt), item.productOrderId, item.orderId, item.clientId, item.sku, item.subject, item.tradeNo, item.amount, item.kind === 'duplicate' ? '额外到账' : '首次到账', item.fulfillmentStatus === 'delivered' ? '通知已送达' : '通知待送达'])];
      downloadCsv(rows, `brclio-pay-${filters.provider}-${filters.month}${filters.clientId ? `-${filters.clientId}` : ''}.csv`);
      message(ui.billsMessage, `已完整导出 ${filters.month} ${providerLabel(filters.provider)}账单，共 ${count(items.length)} 笔，实收 ${money(expectedAmount)}。`, 'success');
    } catch (error) { invalidateReadCache(); clearBills(); report(error, ui.billsMessage); }
  }
  function environmentText(value) {
    return typeof value === 'string' ? value : Array.isArray(value) ? value.filter((item) => typeof item === 'string').join('\n') : '';
  }
  function renderEnvironment() {
    if (!environmentGuide) return;
    const term = ui.environmentSearch.value.trim().toLocaleLowerCase(), groupId = ui.environmentGroup.value;
    let visibleCount = 0;
    const sections = environmentGuide.groups.filter((group) => !groupId || group.id === groupId).map((group) => {
      const variables = group.variables.filter((variable) => !term || Object.values(variable).map(environmentText).join(' ').toLocaleLowerCase().includes(term));
      if (!variables.length) return null;
      visibleCount += variables.length;
      const section = element('section', 'environment-group'), heading = element('div', 'environment-group-heading');
      heading.append(element('h3', '', group.title)); if (group.description) heading.append(element('p', 'admin-muted', group.description));
      section.append(heading);
      for (const variable of variables) {
        const article = element('article', 'environment-variable'), title = element('div', 'environment-variable-heading');
        title.append(element('h4', '', variable.name), element('span', 'environment-label', variable.label));
        const state = environmentStatuses.get(variable.name);
        title.append(element('span', `admin-badge${state?.configured ? ' paid-status' : ''}`, state ? state.configured ? '已配置' : '未配置' : '状态未提供'));
        article.append(title, element('p', 'environment-description', variable.description));
        const fields = element('dl', 'environment-fields');
        const values = [['维护方式', state?.storageType === 'binding' ? 'Cloudflare 资源绑定' : state?.storageType === 'Text' ? 'Cloudflare Text（明文）' : '请查配置位置'],
          ['是否必需', variable.required ? '必需' : '按使用场景配置'], ['配置位置', variable.location], ['修改与生效', variable.changeNotes], ['维护注意', variable.maintenance], ['格式示例', variable.example]];
        for (const [label, value] of values) {
          if (!environmentText(value)) continue;
          const row = element('div', ''); row.append(element('dt', '', label), element('dd', '', environmentText(value))); fields.append(row);
        }
        article.append(fields); section.append(article);
      }
      return section;
    }).filter(Boolean);
    ui.environmentGroups.replaceChildren(...sections); ui.environmentEmpty.hidden = visibleCount > 0;
    ui.environmentCount.textContent = `显示 ${count(visibleCount)} 个变量 · 配置状态仅检查是否已提供，维护方式按维护约定显示`;
  }
  async function loadEnvironment({ fresh = false } = {}) {
    environmentLoaded = false; environmentGuide = null; environmentStatuses.clear();
    ui.environmentGroups.replaceChildren(); ui.environmentIntro.replaceChildren(); ui.environmentNotes.replaceChildren();
    ui.environmentSource.textContent = ''; ui.environmentCount.textContent = ''; ui.environmentEmpty.hidden = true;
    message(ui.environmentMessage, '正在从私有数据仓库读取维护说明…');
    try {
      const result = await request('/environment', { fresh }), guide = result.document;
      if (!guide || guide.schema !== 1 || typeof guide.title !== 'string' || !Number.isFinite(Date.parse(guide.updatedAt))
        || !Array.isArray(guide.intro) || !Array.isArray(guide.notes) || !Array.isArray(guide.groups)
        || !Array.isArray(result.variables) || typeof result.source?.repository !== 'string' || typeof result.source?.path !== 'string'
        || typeof result.source?.revision !== 'string') throw new ApiError(502, 'INVALID_ENVIRONMENT_GUIDE', '环境变量说明暂时无法读取，请重试。');
      for (const group of guide.groups) {
        if (!group || !['id', 'title'].every((key) => typeof group[key] === 'string') || !Array.isArray(group.variables)) throw new ApiError(502, 'INVALID_ENVIRONMENT_GUIDE', '环境变量分类不完整，请检查数据仓库说明。');
        for (const variable of group.variables) if (!variable || !['name', 'label', 'description', 'location', 'changeNotes', 'maintenance', 'example'].every((key) => typeof variable[key] === 'string')) throw new ApiError(502, 'INVALID_ENVIRONMENT_GUIDE', '环境变量条目不完整，请检查数据仓库说明。');
      }
      environmentGuide = guide;
      // Deliberately retain only status fields; runtime values never enter the page.
      environmentStatuses = new Map(result.variables.filter((item) => item && typeof item.name === 'string' && typeof item.configured === 'boolean' && ['Text', 'binding'].includes(item.storageType))
        .map((item) => [item.name, { configured: item.configured, storageType: item.storageType }]));
      ui.environmentTitle.textContent = guide.title;
      ui.environmentSource.textContent = `说明来源：${result.source.repository} / ${result.source.path} · 更新于 ${orderTime(guide.updatedAt)} · 修订 ${result.source.revision.slice(0, 12)}`;
      if (typeof result.source.url === 'string') {
        let sourceUrl;
        try { sourceUrl = new URL(result.source.url); } catch { /* The source label remains available without a link. */ }
        if (sourceUrl?.protocol === 'https:' && !sourceUrl.username && !sourceUrl.password && sourceUrl.hostname === 'github.com' && sourceUrl.pathname.startsWith('/BrclioData/BrclioPay-Data/blob/')) {
          const link = element('a', 'quiet-link', '在数据仓库查看说明 ↗'); link.href = sourceUrl.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; ui.environmentSource.append(link);
        }
      }
      ui.environmentIntro.replaceChildren(...guide.intro.filter((text) => typeof text === 'string').map((text) => element('p', 'admin-muted', text)));
      ui.environmentNotes.replaceChildren(...guide.notes.filter((text) => typeof text === 'string').map((text) => element('p', 'field-hint', text)));
      const selected = ui.environmentGroup.value, first = element('option', '', '全部分类'); first.value = '';
      ui.environmentGroup.replaceChildren(first, ...guide.groups.map((group) => { const option = element('option', '', group.title); option.value = group.id; return option; }));
      ui.environmentGroup.value = guide.groups.some((group) => group.id === selected) ? selected : '';
      environmentLoaded = true; renderEnvironment(); message(ui.environmentMessage, '');
    } catch (error) { report(error, ui.environmentMessage); }
  }
  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }
  function downloadCsv(rows, filename) {
    const blob = new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = element('a', ''); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function extraPaymentTotal(order) {
    const payments = Array.isArray(order.duplicatePayments) ? order.duplicatePayments : [];
    const amountCents = payments.reduce((total, payment) => {
      orderAmount(payment);
      return total + (Number.isSafeInteger(payment.amountCents) ? payment.amountCents : Number(payment.amount.replace('.', '')));
    }, 0);
    money(amountCents);
    return { count: payments.length, amount: `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}` };
  }
  function exportCurrentOrders() {
    if (!orderItems.length) return;
    const rows = [['支付订单号', '产品订单号', '平台', '商品代码', '商品', '金额（元）', '额外实付笔数', '额外实付金额（元）', '状态', '产品通知', '创建时间（北京时间）', '付款时间（北京时间）', '支付平台交易号', '支付方式', '账本'],
      ...orderItems.map((order) => { const extra = extraPaymentTotal(order); return [order.id, order.productOrderId, order.clientId, order.sku, order.subject, order.amount, extra.count, extra.amount, statusLabel(order.status), order.fulfillmentStatus, orderTime(order.createdAt), orderTime(order.paidAt), order.tradeNo || '', providerLabel(order.provider), order.mode]; })];
    const blob = new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = element('a', ''); link.href = url; link.download = `brclio-pay-orders-current-page-${orderPageIndex + 1}.csv`;
    document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    message(ui.ordersMessage, `已导出当前第 ${orderPageIndex + 1} 页，共 ${orderItems.length} 笔；不是全量账本导出。`, 'success');
  }

  ui.loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!ui.loginForm.reportValidity()) return;
    void operation(ui.loginButton, '正在登录…', async () => {
      try {
        message(ui.loginMessage, '');
        const data = await request('/login', { method: 'POST', body: { email: ui.loginEmail.value.trim(), password: ui.loginPassword.value } });
        showDashboard(data);
        try { await loadActiveReport(); } catch (error) { ui.clientsLoading.hidden = true; report(error, ui.globalMessage); }
      } catch (error) { ui.loginPassword.value = ''; report(error, ui.loginMessage); }
    });
  });
  ui.logoutButton.addEventListener('click', () => {
    void operation(ui.logoutButton, '正在退出…', async () => {
      try { await request('/logout', { method: 'POST' }); showLogin(); }
      catch (error) { report(error, ui.globalMessage); }
    });
  });
  ui.skillVariant.addEventListener('change', () => { clearOutput(); syncSkillChoice(); });
  syncSkillChoice();
  ui.grantForm.addEventListener('submit', (event) => { event.preventDefault(); void generateGrant(); });
  ui.resetGrantButton.addEventListener('click', resetGrant);
  ui.copySkillButton.addEventListener('click', () => {
    void operation(ui.copySkillButton, '正在读取 Skill…', async () => {
      try {
        const result = await request(`/skill?variant=${selectedSkillVariant()}`);
        if (typeof result.content !== 'string' || !result.content) throw new ApiError(502, 'INVALID_SKILL', 'Skill 内容暂时无法读取。');
        setOutput(result.content, { title: `${skillLabels[selectedSkillVariant()]}接入 Skill`, meta: '通用说明，不含平台凭据。具体平台授权由上方接入任务提供。', kind: 'skill' });
        await copyOutput();
        message(ui.grantMessage, '所选 Skill 已准备好。配合单平台短期授权任务即可交给项目 AI。', 'success');
      } catch (error) { report(error, ui.grantMessage); }
    });
  });
  ui.copyOutputButton.addEventListener('click', () => { void copyOutput(); });
  ui.clearOutputButton.addEventListener('click', () => { clearOutput(); syncControls(); });
  ui.reloadClientsButton.addEventListener('click', () => {
    void operation(ui.reloadClientsButton, '正在刷新…', async () => {
      try { message(ui.globalMessage, ''); await loadClients({ fresh: true }); await loadActiveReport(); }
      catch (error) { ui.clientsLoading.hidden = true; report(error, ui.globalMessage); }
    });
  });
  ui.reloadGrantsButton.addEventListener('click', () => {
    void operation(ui.reloadGrantsButton, '正在刷新…', async () => {
      try { await loadGrants({ fresh: true }); } catch (error) { report(error, ui.grantsMessage); }
    });
  });
  ui.newClientButton.addEventListener('click', () => { editingProducts = false; ui.manualSection.classList.remove('products-mode'); ui.platformEditorHost.append(ui.manualSection); resetEditor(); ui.manualSection.open = true; });
  ui.addSkuButton.addEventListener('click', () => { addSku(); invalidatePreview(); });
  ui.clientForm.addEventListener('input', invalidatePreview);
  ui.clientForm.addEventListener('change', invalidatePreview);
  ui.clientForm.addEventListener('submit', (event) => { event.preventDefault(); if (ui.clientForm.reportValidity()) previewConfig(); });
  ui.cancelPreviewButton.addEventListener('click', invalidatePreview);
  ui.saveClientButton.addEventListener('click', () => {
    if (!pendingSave) return;
    void operation(ui.saveClientButton, '正在保存此平台…', async () => {
      const submission = pendingSave;
      try {
        const result = await request('/clients', { method: 'POST', body: submission });
        const saved = publicClient(result.client);
        const existing = clients.findIndex((client) => client.id === saved.id);
        if (existing < 0) clients.push(saved); else clients[existing] = saved;
        auditLoaded = false; renderClients(); openEditor(saved, editingProducts);
        message(ui.editMessage, editingProducts ? '商品配置已保存。已接入目录读取的产品会读取新价；权益规则仍需同步产品实现，历史订单保留原金额和权益。' : '此平台配置已保存，其它平台保持不变。', 'success');
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          invalidatePreview(); ui.conflictNotice.hidden = false;
          message(ui.editMessage, '版本发生冲突，本次修改没有覆盖服务器配置。', 'error');
        } else { report(error, ui.editMessage); }
      }
    });
  });
  ui.reloadCurrentButton.addEventListener('click', () => {
    const id = editingClient?.id || ui.clientId.value.trim();
    void operation(ui.reloadCurrentButton, '正在加载最新配置…', async () => {
      try {
        await loadClients({ fresh: true });
        const latest = clients.find((client) => client.id === id);
        if (!latest) throw new InputError('该平台当前不存在，请重新选择平台或注册新平台。');
        openEditor(latest, editingProducts); message(ui.editMessage, '已加载最新配置，请重新编辑并预览。');
      } catch (error) { ui.clientsLoading.hidden = true; report(error, ui.editMessage); }
    });
  });

  document.querySelectorAll('[data-page-link]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault(); if (busy) return; activatePage(link.dataset.pageLink);
    if (session) void operation(null, null, async () => { try { await loadActiveReport(); } catch (error) { report(error, ui.globalMessage); } });
  }));
  window.addEventListener('hashchange', () => { activatePage(location.hash.slice(1), false); if (session) void operation(null, null, async () => { try { await loadActiveReport(); } catch (error) { report(error, ui.globalMessage); } }); });
  ui.reloadAuditButton.addEventListener('click', () => { void operation(ui.reloadAuditButton, '正在刷新…', () => loadAudit({ fresh: true })); });
  ui.refreshDataButton.addEventListener('click', () => {
    void operation(ui.refreshDataButton, '正在获取最新数据…', async () => {
      invalidateReadCache();
      try {
        message(ui.globalMessage, ''); await ensureSession(true);
        if (activePage === 'orders') clearOrderDetails();
        await loadActiveReport();
      } catch (error) { report(error, ui.globalMessage); }
    });
  });
  ui.grantDomainMode.addEventListener('change', syncGrantModes); ui.grantPricingMode.addEventListener('change', syncGrantModes);
  ui.summaryFilters.addEventListener('change', () => { clearSummaryView(); message(ui.summaryMessage, '筛选条件已更改，点击“查看统计”读取对应数据。'); });
  ui.orderFilters.addEventListener('change', () => {
    ordersLoaded = false; orderItems = []; orderNextCursor = null; orderCursors = [null]; orderPageIndex = 0; renderOrders(); clearOrderDetails();
    ui.ordersEmpty.textContent = '筛选条件已更改，点击“查询订单”读取对应记录。'; message(ui.ordersMessage, '筛选条件已更改，之前的订单页已清除。');
  });
  ui.summaryFilters.addEventListener('submit', (event) => { event.preventDefault(); if (ui.summaryFilters.reportValidity()) void operation(ui.refreshSummaryButton, '正在读取…', loadSummary); });
  ui.orderFilters.addEventListener('submit', (event) => { event.preventDefault(); void operation(ui.searchOrdersButton, '正在查询…', () => loadOrders(true)); });
  ui.nextOrdersButton.addEventListener('click', () => { if (!orderNextCursor) return; orderCursors[orderPageIndex + 1] = orderNextCursor; void operation(ui.nextOrdersButton, '正在读取…', () => loadOrders(false, orderPageIndex + 1)); });
  ui.previousOrdersButton.addEventListener('click', () => { if (orderPageIndex > 0) void operation(ui.previousOrdersButton, '正在读取…', () => loadOrders(false, orderPageIndex - 1)); });
  ui.exportOrdersButton.addEventListener('click', exportCurrentOrders);
  ui.billsFilters.addEventListener('change', () => {
    clearBills(); message(ui.billsMessage, '筛选条件已更改，点击“查询账单”读取对应月份。');
  });
  ui.billsFilters.addEventListener('submit', (event) => {
    event.preventDefault(); if (ui.billsFilters.reportValidity()) void operation(ui.searchBillsButton, '正在查询…', () => loadBills(true));
  });
  for (const [provider, button] of [['alipay', ui.billsAlipayButton], ['wechat', ui.billsWechatButton]]) button.addEventListener('click', () => {
    if (busy || billsProvider === provider) return;
    billsProvider = provider; clearBills(); void operation(button, '正在读取…', () => loadBills(true));
  });
  ui.nextBillsButton.addEventListener('click', () => {
    if (!billNextCursor) return;
    billCursors[billPageIndex + 1] = billNextCursor;
    void operation(ui.nextBillsButton, '正在读取…', () => loadBills(false, billPageIndex + 1));
  });
  ui.previousBillsButton.addEventListener('click', () => {
    if (billPageIndex > 0) void operation(ui.previousBillsButton, '正在读取…', () => loadBills(false, billPageIndex - 1));
  });
  ui.exportBillsButton.addEventListener('click', () => { void operation(ui.exportBillsButton, '正在导出完整月份…', exportBills); });
  ui.reloadEnvironmentButton.addEventListener('click', () => { void operation(ui.reloadEnvironmentButton, '正在读取…', () => loadEnvironment({ fresh: true })); });
  ui.environmentFilters.addEventListener('submit', (event) => { event.preventDefault(); renderEnvironment(); });
  ui.environmentSearch.addEventListener('input', renderEnvironment);
  ui.environmentGroup.addEventListener('change', renderEnvironment);
  ui.closeOrderDetailsButton.addEventListener('click', () => { clearOrderDetails(); syncControls(); });
  ui.reloadOrderDetailsButton.addEventListener('click', () => { const id = selectedOrderId; if (id) void operation(ui.reloadOrderDetailsButton, '正在刷新…', () => loadOrderDetails(id)); });
  ui.closePaymentOrderButton.addEventListener('click', () => beginOrderAction('close'));
  ui.reopenPaymentOrderButton.addEventListener('click', () => beginOrderAction('reopen'));
  ui.reconcilePaymentOrderButton.addEventListener('click', () => beginOrderAction('reconcile'));
  ui.orderActionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pendingOrderAction?.submission && !ui.orderActionForm.reportValidity()) return;
    void operation(ui.confirmOrderActionButton, '正在处理…', submitOrderAction);
  });
  ui.cancelOrderActionButton.addEventListener('click', () => {
    const sent = !!pendingOrderAction?.submission;
    pendingOrderAction = null; ui.orderActionForm.reset(); ui.orderActionForm.hidden = true;
    if (sent && selectedOrderDetail) {
      selectedOrderDetail.actions = { close: false, reopen: false, reconcile: false }; renderOrderDetail();
      message(ui.orderDetailMessage, '已停止重试。服务器上的操作不会因此撤销，请刷新状态核对处理结果。');
    }
    syncControls();
  });
  ui.copyOrderCheckoutButton.addEventListener('click', () => {
    if (!ui.orderCheckoutUrl.value) return;
    void operation(ui.copyOrderCheckoutButton, '正在复制…', async () => {
      try { await navigator.clipboard.writeText(ui.orderCheckoutUrl.value); ui.orderCheckoutMessage.textContent = '新链接已复制，请重新发送给这位用户；10 分钟付款期限不会因复制而延长。'; }
      catch { ui.orderCheckoutUrl.focus(); ui.orderCheckoutUrl.select(); ui.orderCheckoutMessage.textContent = '自动复制未完成，请手动复制上方完整链接并重新发送给用户。'; }
    });
  });
  window.addEventListener('pagehide', () => { clearOrderCheckout(); clearOutput(); invalidateReadCache(); });
  ui.rebuildButton.addEventListener('click', () => {
    void operation(ui.rebuildButton, '正在补建本批…', async () => {
      try {
        const result = await request('/reports/rebuild', { method: 'POST', body: { limit: 5, ...(rebuildCursor ? { cursor: rebuildCursor } : {}) } });
        rebuildCursor = result.nextCursor; setCoverage(result.coverage);
        summaryLoaded = false; ordersLoaded = false; billsLoaded = false; await loadActiveReport();
        message(activePage === 'orders' ? ui.ordersMessage : ui.summaryMessage,
          `本批已补建 ${count(result.processed)} 笔。${result.coverage.complete ? '历史索引已完整。' : '已暂停；点击“补建下一批”继续。'}`, 'success');
      } catch (error) { report(error, activePage === 'orders' ? ui.ordersMessage : ui.summaryMessage); }
    });
  });
  ui.productClient.addEventListener('change', () => {
    const client = clients.find((item) => item.id === ui.productClient.value);
    if (client) openEditor(client, true); else { ui.platformEditorHost.append(ui.manualSection); resetEditor(); }
    syncControls();
  });
  ui.productAiButton.addEventListener('click', () => { const client = clients.find((item) => item.id === ui.productClient.value); if (!client) return; activatePage('ai'); selectGrantClient(client); void generateGrant(ui.generateGrantButton); });

  const initialMonth = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
  ui.summaryMonth.value = initialMonth;
  ui.ordersMonth.value = initialMonth;
  ui.billsMonth.value = initialMonth;
  syncBillProvider();
  syncGrantModes();
  resetEditor();
  void operation(null, null, async () => {
    try {
      showDashboard(await request('/session'));
      try { await loadActiveReport(); } catch (error) { ui.clientsLoading.hidden = true; report(error, ui.globalMessage); }
    } catch (error) {
      showLogin();
      if (!(error instanceof ApiError && error.status === 401)) report(error, ui.loginMessage);
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    clearOutput(); clearOrderDetails();
    void operation(null, null, async () => {
      try { invalidateReadCache(); showDashboard(await request('/session')); await loadActiveReport(); }
      catch (error) { showLogin('请重新确认登录状态。'); if (!(error instanceof ApiError && error.status === 401)) report(error, ui.loginMessage); }
    });
  });
  window.addEventListener('focus', () => {
    if (!session || busy) return;
    void operation(null, null, async () => { try { await ensureSession(true); } catch (error) { report(error, ui.globalMessage); } });
  });
})();
