#!/usr/bin/env node
/** Terminal historical orders only. No POST, refresh, payment creation or delivery retry. */
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch, ProxyAgent } from 'undici';
import { installationGithub, TARGET_REPOSITORY } from './migrate-data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hmac = (secret, value) => createHmac('sha256', secret).update(value, 'utf8').digest('hex');
function check(condition, code) { if (!condition) { const error = new Error(code); error.code = code; throw error; } }
function cents(amount) {
  check(typeof amount === 'string' && /^(?:0|[1-9]\d*)\.\d{2}$/.test(amount), 'CANONICAL_AMOUNT_INVALID');
  const [yuan, fen] = amount.split('.'), result = Number(yuan) * 100 + Number(fen);
  check(Number.isSafeInteger(result) && result > 0, 'CANONICAL_AMOUNT_INVALID');
  return result;
}
function origin(value) {
  let url;
  try { url = new URL(value); } catch { check(false, 'INVALID_HTTPS_ORIGIN'); }
  check(url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash, 'INVALID_HTTPS_ORIGIN');
  return url.origin;
}
function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { check(false, 'INVALID_JSON_RESPONSE'); }
}
function signed(path, client) {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
  const clientId = client.legacyWechat?.id || client.id;
  check(typeof client.apiSecret === 'string' && client.apiSecret.length >= 32, 'CLIENT_CREDENTIAL_MISSING');
  return {
    'X-Brclio-Client': clientId,
    'X-Brclio-Timestamp': timestamp,
    'X-Brclio-Nonce': nonce,
    'X-Brclio-Signature': hmac(client.apiSecret, `GET\n${path}\n${timestamp}\n${nonce}\n\n`),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node scripts/verify-legacy-live.mjs [https://paywc.bornforthis.cn]\nRead-only GET verification of terminal migrated WeChat orders, legacy signatures, checkout HTML and token exchange. Reports contain counts and metadata only; credentials and fragment URLs are withheld.\n');
    return;
  }
  check(args.length <= 1, 'INVALID_ARGUMENT');
  const runtime = parseJson(await readFile(resolve(ROOT, 'secrets/runtime-vars.json')));
  const wrangler = parseJson(await readFile(resolve(ROOT, 'wrangler.jsonc')));
  const env = { ...runtime, ...wrangler.vars };
  const base = origin(args[0] || env.LEGACY_WECHAT_BASE_URL || 'https://paywc.bornforthis.cn');
  check(base === origin(env.LEGACY_WECHAT_BASE_URL || 'https://paywc.bornforthis.cn'), 'LEGACY_ORIGIN_MISMATCH');
  check(typeof env.LEGACY_WECHAT_CHECKOUT_SECRET === 'string' && env.LEGACY_WECHAT_CHECKOUT_SECRET.length >= 32, 'LEGACY_CHECKOUT_SECRET_MISSING');
  check(typeof env.CHECKOUT_SECRET === 'string' && env.CHECKOUT_SECRET.length >= 32, 'CHECKOUT_SECRET_MISSING');
  const dispatcher = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
  let maxReadMs = 0, requests = 0;
  async function get(path, headers = {}) {
    // Deliberately no method argument: this program can only issue GET requests.
    check(path.startsWith('/') && !path.includes('#') && !path.includes('?'), 'INVALID_VERIFICATION_PATH');
    const started = Date.now();
    let response;
    try {
      response = await fetch(base + path, { method: 'GET', headers, dispatcher, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    } catch { check(false, 'LIVE_GET_FAILED'); }
    const length = response.headers.get('content-length');
    check(!length || !/^\d+$/.test(length) || Number(length) <= 1024 * 1024, 'LIVE_RESPONSE_TOO_LARGE');
    const reader = response.body?.getReader(), chunks = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) { await reader.cancel(); check(false, 'LIVE_RESPONSE_TOO_LARGE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    requests++; maxReadMs = Math.max(maxReadMs, Date.now() - started);
    return { status: response.status, headers: response.headers, bytes: Buffer.concat(chunks, size) };
  }
  try {
    const { github } = await installationGithub();
    const snapshot = await github.snapshot(TARGET_REPOSITORY, env.GITHUB_BRANCH || 'main');
    const load = async file => parseJson(await github.bytes(TARGET_REPOSITORY, file));
    const clients = await Promise.all(snapshot.files.filter(file => /^registry\/clients\/[^/]+\.json$/.test(file.path)).map(load));
    const allOrders = await Promise.all(snapshot.files.filter(file => /^orders\/\d{4}\/\d{2}\/pay_[a-f0-9]{32}\.json$/.test(file.path)).map(load));
    const orders = allOrders.filter(order => order.provider === 'wechat');
    check(orders.length > 0, 'NO_CANONICAL_WECHAT_ORDERS');
    // Legacy GET can reconcile expired pending orders or schedule unpaid delivery.
    // Refuse those states to guarantee this audit cannot trigger a business write.
    check(orders.every(order => ['PAID', 'CLOSED'].includes(order.status)), 'NON_TERMINAL_ORDER_READONLY_GUARD');
    check(orders.every(order => order.status !== 'PAID' || order.fulfillmentStatus === 'delivered'), 'PENDING_DELIVERY_READONLY_GUARD');
    const skipped = [], clientIds = new Set();
    let verified = 0, paidVerified = 0, paidAmountCents = 0, htmlVerified = 0, exchangesVerified = 0, unifiedCheckoutVerified = 0;
    let firstOldId;
    for (const order of orders) {
      const client = clients.find(candidate => candidate.id === order.clientId);
      if (!client) {
        // Orphaned CLOSED verification records are checked via admin separately.
        check(order.status === 'CLOSED' && order.clientId === 'deployment-verification', 'UNEXPECTED_ORPHAN_ORDER');
        skipped.push({ clientId: order.clientId, provider: 'wechat', status: order.status, reason: 'historical-client-missing-admin-verified-separately' });
        continue;
      }
      check(client.providers?.includes('wechat') && client.legacyWechat?.id, 'LEGACY_CLIENT_MARKER_MISSING');
      const oldId = order.wechatOrderId || order.id.slice(4);
      check(/^[a-f0-9]{32}$/.test(oldId) && order.id === 'pay_' + oldId, 'CANONICAL_LEGACY_ID_MISMATCH');
      firstOldId ||= oldId;
      const amount = cents(order.amount), path = `/api/v1/orders/${oldId}`;
      const result = await get(path, signed(path, client));
      check(result.status === 200, 'LEGACY_ORDER_GET_FAILED');
      check(/\bno-store\b/i.test(result.headers.get('cache-control') || ''), 'LEGACY_ORDER_CACHE_BOUNDARY_FAILED');
      const view = parseJson(result.bytes);
      check(view.id === oldId && view.clientId === client.legacyWechat.id && view.merchantOrderId === order.productOrderId, 'LEGACY_ORDER_IDENTITY_MISMATCH');
      check(view.sku === order.sku && view.quantity === (order.wechatQuantity || 1), 'LEGACY_ORDER_PRODUCT_MISMATCH');
      check(view.status === (order.status === 'PAID' ? 'SUCCESS' : 'CLOSED'), 'LEGACY_ORDER_STATUS_MISMATCH');
      check(view.amount?.total === amount && view.amount?.currency === 'CNY', 'LEGACY_ORDER_AMOUNT_MISMATCH');
      check((view.transactionId || null) === (order.tradeNo || null) && (view.paidAt || null) === (order.paidAt || null), 'LEGACY_ORDER_PAYMENT_MISMATCH');
      const oldToken = hmac(env.LEGACY_WECHAT_CHECKOUT_SECRET, 'checkout:v1:' + oldId);
      let oldCheckout;
      try { oldCheckout = new URL(view.checkoutUrl); } catch { check(false, 'LEGACY_CHECKOUT_LINK_INVALID'); }
      check(oldCheckout.origin === base && oldCheckout.pathname === '/checkout/' + oldId && !oldCheckout.search && !oldCheckout.username && !oldCheckout.password && oldCheckout.hash === '#token=' + oldToken, 'LEGACY_CHECKOUT_LINK_MISMATCH');
      const html = await get('/checkout/' + oldId);
      check(html.status === 200 && /text\/html/i.test(html.headers.get('content-type') || ''), 'LEGACY_CHECKOUT_HTML_FAILED');
      const htmlText = html.bytes.toString('utf8');
      check(htmlText.includes('legacyMessage') && htmlText.includes('/legacy-checkout.js'), 'LEGACY_CHECKOUT_BRIDGE_HTML_MISSING');
      htmlVerified++;
      const exchanged = await get(`/api/legacy/wechat/checkout/${oldId}/exchange`, { Authorization: 'Bearer ' + oldToken });
      check(exchanged.status === 200, 'LEGACY_CHECKOUT_EXCHANGE_FAILED');
      check(/\bno-store\b/i.test(exchanged.headers.get('cache-control') || ''), 'LEGACY_EXCHANGE_CACHE_BOUNDARY_FAILED');
      let destination;
      try { destination = new URL(parseJson(exchanged.bytes).checkoutUrl); } catch { check(false, 'EXCHANGE_DESTINATION_INVALID'); }
      const newToken = hmac(env.CHECKOUT_SECRET, 'brclio-checkout-v1:' + order.id);
      check(destination.origin === base && destination.pathname === '/checkout/' + order.id && !destination.search && !destination.username && !destination.password && destination.hash === '#token=' + newToken, 'EXCHANGE_DESTINATION_MISMATCH');
      exchangesVerified++;
      const unified = await get('/api/checkout/' + order.id, { Authorization: 'Bearer ' + newToken });
      check(unified.status === 200, 'EXCHANGED_CHECKOUT_READ_FAILED');
      const unifiedView = parseJson(unified.bytes);
      check(unifiedView.id === order.id && unifiedView.provider === 'wechat' && unifiedView.status === order.status && unifiedView.amount === order.amount, 'EXCHANGED_CHECKOUT_ORDER_MISMATCH');
      unifiedCheckoutVerified++;
      verified++; clientIds.add(client.id);
      if (order.status === 'PAID') { paidVerified++; paidAmountCents += amount; }
    }
    check(verified > 0 && firstOldId, 'NO_VERIFIABLE_LEGACY_ORDERS');
    const bridgeScript = await get('/legacy-checkout.js');
    check(bridgeScript.status === 200 && bridgeScript.bytes.toString('utf8').includes('/api/legacy/wechat/checkout/') && bridgeScript.bytes.toString('utf8').includes('history.replaceState'), 'LEGACY_BRIDGE_SCRIPT_FAILED');
    check((await get('/api/v1/orders/' + firstOldId)).status === 401, 'LEGACY_ANONYMOUS_QUERY_NOT_REJECTED');
    check((await get(`/api/legacy/wechat/checkout/${firstOldId}/exchange`)).status === 401, 'LEGACY_ANONYMOUS_EXCHANGE_NOT_REJECTED');
    const latest = await github.revision(TARGET_REPOSITORY, snapshot.branch);
    check(latest === snapshot.revision, 'TARGET_REVISION_CHANGED_DURING_AUDIT');
    const report = {
      kind: 'legacy-wechat-live-readonly', baseOrigin: base, at: new Date().toISOString(), repositoryRevision: snapshot.revision,
      readOnly: true, paymentCreationAttempted: false, refreshAttempted: false, deliveryRetryAttempted: false,
      canonicalWechatOrders: orders.length, legacyOrdersVerified: verified, legacyClientsVerified: clientIds.size,
      paidOrdersVerified: paidVerified, paidAmountCents, historicalClientMissingSkipped: skipped.length, skipped,
      legacyCheckoutHtmlVerified: htmlVerified, tokenExchangesVerified: exchangesVerified, exchangedCheckoutReadsVerified: unifiedCheckoutVerified,
      bridgeScriptVerified: true, anonymousQueriesRejected: true, anonymousExchangesRejected: true,
      repositoryRevisionUnchanged: true, requests, maxReadMs,
    };
    const folder = resolve(ROOT, 'secrets/verification');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const reportPath = resolve(folder, 'legacy-' + new URL(base).hostname + '.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await chmod(reportPath, 0o600);
    // Never include response bodies, signatures, tokens or checkout URLs in output.
    process.stdout.write(JSON.stringify({ ...report, report: reportPath }, null, 2) + '\n');
  } finally { await dispatcher?.close().catch(() => {}); }
}

main().catch(error => {
  process.stderr.write(`Legacy live verification failed: ${/^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'UNEXPECTED_ERROR'}. Credentials, response bodies and checkout fragments withheld.\n`);
  process.exitCode = 1;
});
