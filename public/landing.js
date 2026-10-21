(() => {
  'use strict';
  const state = document.getElementById('serviceState');
  if (!state) return;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  fetch('/api/health', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error('Health unavailable');
      const health = await response.json();
      if (health.ready !== true) {
        state.textContent = '服务配置中 · 暂未开放收款';
      } else if (health.mode === 'sandbox') {
        state.textContent = '沙箱测试环境 · 非真实收款';
      } else if (health.acceptingPayments === true) {
        state.textContent = '已配置 · 收款已开启';
        state.dataset.state = 'live';
      } else {
        state.textContent = '服务已配置 · 收款暂未开启';
      }
    })
    .catch(() => { state.textContent = '服务状态暂不可用 · 请稍后查看'; })
    .finally(() => window.clearTimeout(timeout));
})();
