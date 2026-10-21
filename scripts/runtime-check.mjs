import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
import { createHash, createHmac, createSign, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
let runtime;
let checks;
let diagnostic;
let phase = 'bundle';
let responseStatus;
let sdkLogCount = 0;
let nativeQueryCalls = 0;
let nativeCloseCalls = 0;
try {
  // Mirror Wrangler's builtin-module shims so CommonJS SDK dependencies import
  // workerd's native Node modules instead of leaving dynamic require() calls.
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ['tests/runtime-worker.ts'],
    bundle: true,
    write: false,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    mainFields: ['browser', 'module', 'main'],
    conditions: ['workerd', 'worker', 'browser'],
    logLevel: 'silent',
    plugins: [{
      name: 'workerd-node-builtins',
      setup(context) {
        context.onResolve({ filter: /./ }, args => {
          const name = args.path.replace(/^node:/, '');
          // Prefix-only modules (for example node:sqlite) are valid builtins
          // even when omitted from builtinModules on a supported Node release.
          if (!isBuiltin(args.path)) return undefined;
          if (args.namespace === 'workerd-node-builtins') return { path: `node:${name}`, external: true };
          if (args.path === 'node:util') return { path: fileURLToPath(new URL('../src/safe-node-util.ts', import.meta.url)) };
          return { path: name, namespace: 'workerd-node-builtins' };
        });
        context.onLoad({ filter: /./, namespace: 'workerd-node-builtins' }, args => ({
          contents: `import * as builtin from ${JSON.stringify(`node:${args.path}`)}; module.exports = builtin.default ?? builtin;`,
          loader: 'js',
        }));
      },
    }],
  });
  phase = 'fixtures';
  const app = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sellerId = '2088123456789012';
  const queryData = JSON.stringify({
    code: '10000', msg: 'Success', out_trade_no: 'pay_runtime',
    trade_no: '2026101322001400000000000000', trade_status: 'TRADE_SUCCESS', total_amount: '1.00', seller_id: sellerId,
  }, null, 2);
  const querySignature = createSign('RSA-SHA256').update(queryData, 'utf8').sign(provider.privateKey, 'base64');
  const queryResponse = `{"alipay_trade_query_response":${queryData},"sign":${JSON.stringify(querySignature)}}`;
  const closeData = JSON.stringify({
    code: '10000', msg: 'Success', out_trade_no: 'pay_runtime', trade_no: '2026101322001400000000000000',
  }, null, 2);
  const closeSignature = createSign('RSA-SHA256').update(closeData, 'utf8').sign(provider.privateKey, 'base64');
  const closeResponse = `{"alipay_trade_close_response":${closeData},"sign":${JSON.stringify(closeSignature)}}`;
  const notification = {
    app_id: '2021007109602288', seller_id: sellerId, out_trade_no: 'pay_runtime',
    subject: '中文 100% + 商品', total_amount: '1.00', trade_status: 'TRADE_SUCCESS',
  };
  const canonical = Object.keys(notification).sort().map(key => `${key}=${notification[key]}`).join('&');
  const notificationSignature = createSign('RSA-SHA256').update(canonical, 'utf8').sign(provider.privateKey, 'base64');
  const hmacSecret = randomBytes(32).toString('hex');
  const runtimeToken = randomBytes(32).toString('hex');
  const message = 'runtime\n中文 + 100%';
  phase = 'runtime-config';
  runtime = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1',
    port: 0,
    log: new Log(LogLevel.NONE),
    handleStructuredLogs: entry => {
      if (/alipay-sdk/i.test(entry.message)) sdkLogCount++;
    },
    workers: [{
      name: 'brclio-pay-runtime-check',
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-10-13',
      compatibilityFlags: ['nodejs_compat'],
      outboundService:async request=>{
        const url=new URL(request.url);
        assert.equal(url.origin,'https://openapi-sandbox.dl.alipaydev.com');
        const method=url.searchParams.get('method');
        assert.ok(['alipay.trade.query','alipay.trade.close'].includes(method));
        assert.deepEqual(JSON.parse(url.searchParams.get('biz_content')), {out_trade_no:'pay_runtime'});
        const fields=new URLSearchParams(url.searchParams);const signature=fields.get('sign');fields.delete('sign');
        const content=[...fields].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('&');
        assert.equal(createVerify('RSA-SHA256').update(content,'utf8').verify(app.publicKey,signature,'base64'),true);
        if(method==='alipay.trade.close')nativeCloseCalls++;
        else nativeQueryCalls++;
        return new Response(method==='alipay.trade.close'?closeResponse:queryResponse,{headers:{'Content-Type':'application/json'}});
      },
      bindings: {
      RUNTIME_TOKEN: runtimeToken,
      ALIPAY_APP_ID: '2021007109602288',
      ALIPAY_SELLER_ID: sellerId,
      ALIPAY_PRIVATE_KEY: app.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ALIPAY_PUBLIC_KEY: provider.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      PAYMENT_MODE: 'sandbox',
      QUERY_RESPONSE: queryResponse,
      BAD_QUERY_RESPONSE: queryResponse.replace('TRADE_SUCCESS', 'TRADE_FINISHED'),
      CLOSE_RESPONSE: closeResponse,
      BAD_CLOSE_RESPONSE: closeResponse.replace('pay_runtime', 'pay_other'),
      NOTIFICATION_FORM: new URLSearchParams({ ...notification, sign_type: 'RSA2', sign: notificationSignature }).toString(),
      HMAC_SECRET: hmacSecret,
      HMAC_EXPECTED: createHmac('sha256', hmacSecret).update(message, 'utf8').digest('hex'),
      HASH_EXPECTED: createHash('sha256').update(message, 'utf8').digest('hex'),
      },
    }],
  }));
  phase = 'runtime-dispatch';
  const response = await runtime.dispatchFetch('http://runtime.test/', {
    method: 'POST', headers: { authorization: `Bearer ${runtimeToken}` },
  });
  responseStatus = response.status;
  phase = 'response-json';
  const result = await response.json();
  checks = result.checks;
  diagnostic = result.diagnostic;
  phase = 'worker-checks';
  assert.equal(response.status, 200);
  for (const passed of Object.values(result.checks)) assert.equal(passed, true);
  phase = 'payment-signature';
  const payment = new URL(result.paymentUrl);
  assert.equal(payment.hostname, 'openapi-sandbox.dl.alipaydev.com');
  const signature = payment.searchParams.get('sign');
  const params = new URLSearchParams(payment.searchParams);
  params.delete('sign');
  const signContent = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
  assert.equal(createVerify('RSA-SHA256').update(signContent, 'utf8').verify(app.publicKey, signature, 'base64'), true);
  phase = 'payment-timestamp';
  const timestamp = Date.parse(`${payment.searchParams.get('timestamp').replace(' ', 'T')}+08:00`);
  assert.equal(Math.abs(timestamp - Date.now()) < 10_000, true);
  phase = 'runtime-final-checks';
  assert.equal(sdkLogCount, 0);
  assert.equal(nativeQueryCalls,1);
  assert.equal(nativeCloseCalls,1);
  console.log(JSON.stringify({ workerdRuntime: true, ...result.checks, nativeQueryRequestSignature:true, nativeCloseRequestSignature:true, paymentRequestSignature: true, chinaTimestamp: true, sdkLogsSuppressed: true }));
} catch (error) {
  // Avoid printing provider errors, full signed URLs, bindings, or ephemeral keys.
  const errorTypes = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AssertionError']);
  const allowedCodes = new Set(['ERR_RUNTIME_FAILURE', 'ERR_ADDRESS_IN_USE', 'ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_BUILTIN_MODULE', 'ENOENT', 'EACCES', 'ECONNREFUSED', 'ERR_ASSERTION']);
  const errorCode = allowedCodes.has(error?.code) ? error.code : allowedCodes.has(error?.cause?.code) ? error.cause.code : 'UNKNOWN';
  // Classify esbuild's known unresolved-builtin failure without exposing text.
  const unresolvedBuiltin = phase === 'bundle' && Array.isArray(error?.errors)
    && error.errors.some(item => typeof item?.text === 'string' && /Could not resolve ["']node:[a-z_]+["']/.test(item.text));
  console.error(JSON.stringify({ workerdRuntime: false, phase,
    errorType: errorTypes.has(error?.name) ? error.name : 'Error', errorCode,
    ...(unresolvedBuiltin ? { unresolvedBuiltin: true } : {}),
    ...(Number.isInteger(responseStatus) ? { responseStatus } : {}), ...checks, diagnostic }));
  process.exitCode = 1;
} finally {
  try { await runtime?.dispose(); } catch { process.exitCode = 1; }
}
