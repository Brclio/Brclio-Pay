import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const clients = ['alpha', 'beta'].map(id => ({
  id, name: id.toUpperCase(), apiSecret: `fixture-${id}-api-`.repeat(4), webhookSecret: `fixture-${id}-hook-`.repeat(4),
  webhookUrl: `https://${id}.brclio.com/api/payment`, returnOrigins: [`https://${id}.brclio.com`],
  skus: { pro: { subject: `${id} Pro`, amount: '9.90' } },
}));
let runtime;
try {
  const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/registry-runtime-worker.ts'],
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], logLevel: 'silent' });
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-13', compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0,
    log: new Log(LogLevel.NONE), handleStructuredLogs: () => {},
    bindings: { CLIENTS_JSON: JSON.stringify(clients), REGISTRY_ENCRYPTION_KEY: randomBytes(32).toString('hex') },
  }));
  const response = await runtime.dispatchFetch('http://registry-runtime.test/', { method: 'POST' });
  assert.equal(response.status, 200);
  const checks = await response.json();
  for (const passed of Object.values(checks)) assert.equal(passed, true);
  console.log(JSON.stringify({ registryWorkerd: true, ...checks }));
} catch (error) {
  console.error(JSON.stringify({ registryWorkerd: false, errorType: error?.name ?? 'Error' }));
  process.exitCode = 1;
} finally {
  try { await runtime?.dispose(); } catch { process.exitCode = 1; }
}
