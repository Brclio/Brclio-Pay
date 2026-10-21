import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
let runtime;
try {
  const password = randomBytes(32).toString('base64url');
  const pepper = randomBytes(32).toString('hex');
  const salt = randomBytes(32).toString('hex');
  const material = createHmac('sha256', pepper).update(password, 'utf8').digest('hex');
  const derived = pbkdf2Sync(material, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex');
  const token = randomBytes(32).toString('hex');
  const compiled = await build({ absWorkingDir: root, entryPoints: ['tests/admin-runtime-worker.ts'],
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], logLevel: 'silent' });
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: compiled.outputFiles[0].text,
    compatibilityDate: '2026-10-13', compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0,
    log: new Log(LogLevel.NONE), handleStructuredLogs: () => {},
    bindings: {
      ADMIN_EMAIL: 'runtime-admin@example.com',
      ADMIN_PASSWORD_HASH: `pbkdf2-sha256$100000$${salt}$${derived}`,
      ADMIN_PASSWORD_PEPPER: pepper,
      ADMIN_SESSION_SECRET: randomBytes(32).toString('hex'),
      TEST_PASSWORD: password,
      RUNTIME_TEST_TOKEN: token,
    },
  }));
  const response = await runtime.dispatchFetch('http://admin-runtime.test/', {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const checks = await response.json();
  for (const passed of Object.values(checks)) assert.equal(passed, true);
  console.log(JSON.stringify({ adminWorkerd: true, ...checks }));
} catch (error) {
  console.error(JSON.stringify({ adminWorkerd: false, errorType: error?.name ?? 'Error' }));
  process.exitCode = 1;
} finally {
  try { await runtime?.dispose(); } catch { process.exitCode = 1; }
}
