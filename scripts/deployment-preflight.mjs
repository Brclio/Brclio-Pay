// Read-only release checks. No credentials, login, orders, or mutations are used.
// The anonymous environment-value POST only tests that its read is denied.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { fetch, ProxyAgent } from 'undici';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_URL = 'https://brclio-pay-unified.aiyuechuang.workers.dev';
const MAX_ATTEMPTS = 3;
const MAX_BODY_BYTES = 512 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const publicAssetNames = ['styles.css', 'admin.css', 'admin.js', 'checkout.js', 'landing.js'];
const skillNames = ['brclio-pay-integrate', 'brclio-alipay-integrate', 'brclio-wechatpay-integrate', 'brclio-pay-deploy'];
const deploymentDocNames = ['deployment', 'environment-variables', 'merchant-setup'];
const publicDownloadRoutes = new Set([
  ...skillNames.flatMap(name => [`/api/skills/${name}.zip`, `/api/skills/${name}/SKILL.md`]),
  ...deploymentDocNames.map(name => `/docs/${name}.md`),
]);
const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function secureAsset(response) {
  return response.headers.get('Cache-Control') === 'no-store'
    && response.headers.get('X-Content-Type-Options') === 'nosniff'
    && response.headers.get('Referrer-Policy') === 'no-referrer'
    && response.headers.get('Content-Security-Policy') === contentSecurityPolicy
    && response.headers.get('Permissions-Policy') === 'camera=(), microphone=(), geolocation=()'
    && response.headers.get('Strict-Transport-Security') === 'max-age=31536000';
}

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid deployment origin');
  return url.origin;
}

// Read only the generated JSON object initializers, never execute the source file.
function bundledSkillFiles(root) {
  const source = ts.createSourceFile('skill-data.ts', readFileSync(path.join(root, 'src/skill-data.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const bundles = {};
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(source);
      if (!['skillVariants', 'deploymentSkillFiles'].includes(name)) continue;
      if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) throw new Error('Invalid public Skill bundle');
      bundles[name] = JSON.parse(declaration.initializer.getText(source));
    }
  }
  return Object.fromEntries(skillNames.map(name => {
    const files = name === 'brclio-pay-deploy' ? bundles.deploymentSkillFiles : bundles.skillVariants?.[name];
    if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length
      || typeof files[`${name}/SKILL.md`] !== 'string'
      || Object.entries(files).some(([entry, value]) => !entry.startsWith(`${name}/`) || !/^[A-Za-z0-9_./-]+$/.test(entry)
        || entry.split('/').some(part => part === '..' || !part) || typeof value !== 'string')) throw new Error('Invalid public Skill bundle');
    return [name, files];
  }));
}

// Match the runtime's deterministic stored UTF-8 ZIP without importing runtime TS.
function bundledZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const filename = Buffer.from(name), data = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const record = Buffer.alloc(30 + filename.length), directory = Buffer.alloc(46 + filename.length);
    record.writeUInt32LE(0x04034b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(0x0800, 6);
    record.writeUInt16LE(0x0021, 12); record.writeUInt32LE(crc, 14); record.writeUInt32LE(data.length, 18);
    record.writeUInt32LE(data.length, 22); record.writeUInt16LE(filename.length, 26); filename.copy(record, 30);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(0x0021, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42); filename.copy(directory, 46);
    local.push(record, data); central.push(directory); offset += record.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(central.reduce((sum, item) => sum + item.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export function loadDeploymentExpectations(root = ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
  const vars = parsed.config?.vars;
  if (parsed.error || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
    || !['live', 'sandbox'].includes(vars?.PAYMENT_MODE) || !['true', 'false'].includes(vars?.PAYMENT_ENABLED)) throw new Error('Invalid deployment configuration');
  const bundles = bundledSkillFiles(root);
  return {
    version: manifest.version,
    paymentMode: vars.PAYMENT_MODE,
    paymentEnabled: vars.PAYMENT_ENABLED === 'true',
    workerUrl: WORKER_URL,
    publicUrl: httpsOrigin(vars.PAY_BASE_URL),
    adminPageHash: hash(readFileSync(path.join(root, 'public/admin.html'))),
    adminScriptHash: hash(readFileSync(path.join(root, 'public/admin.js'))),
    checkoutPageHash: hash(readFileSync(path.join(root, 'public/checkout.html'))),
    publicAssets: Object.fromEntries(publicAssetNames.map(name => ['/' + name, {
      hash: hash(readFileSync(path.join(root, 'public', name))), type: name.endsWith('.css') ? 'css' : 'js',
    }])),
    publicDownloads: Object.fromEntries([
      ...Object.entries(bundles).flatMap(([name, files]) => [
        [`/api/skills/${name}.zip`, { hash: hash(bundledZip(files)), type: 'zip', filename: `${name}.zip` }],
        [`/api/skills/${name}/SKILL.md`, { hash: hash(files[`${name}/SKILL.md`]), type: 'markdown' }],
      ]),
      ...deploymentDocNames.map(name => [`/docs/${name}.md`, {
        hash: hash(readFileSync(path.join(root, 'public/docs', `${name}.md`))), type: 'markdown',
      }]),
    ]),
  };
}

async function boundedBytes(response) {
  if (Number(response.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error('Deployment response too large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('Deployment response too large'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally { reader.releaseLock(); }
}

async function probe(baseUrl, route, validate, { fetcher, dispatcher, sleep, attempts }, request = {}) {
  let last = { passed: false };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(attempt * 2000);
    try {
      const response = await fetcher(new URL(route, baseUrl), {
        method: request.method || 'GET', ...(request.body ? { body: request.body } : {}),
        redirect: 'manual', dispatcher, signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/json, text/html, application/javascript, text/markdown, application/zip',
          'Cache-Control': 'no-cache', ...(request.body ? { 'Content-Type': 'application/json' } : {}) },
      });
      // Keep diagnostic values to booleans and valid HTTP status codes only.
      last = { passed: false, ...(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? { status: response.status } : {}) };
      const bytes = await boundedBytes(response);
      last = { ...last, ...validate(response, bytes) };
      if (last.passed) return last;
    } catch { last = { ...last, passed: false }; }
  }
  return last;
}

export async function runDeploymentPreflight({ expected, fetcher = fetch, dispatcher, sleep = pause, attempts = MAX_ATTEMPTS, now = Date.now() }) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS
    || typeof expected?.version !== 'string' || !['live', 'sandbox'].includes(expected.paymentMode)
    || typeof expected.paymentEnabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(expected.adminPageHash)
    || !/^[a-f0-9]{64}$/.test(expected.adminScriptHash)) throw new Error('Invalid preflight configuration');
  if (expected.publicAssets !== undefined && (!expected.publicAssets || typeof expected.publicAssets !== 'object'
    || Array.isArray(expected.publicAssets) || !Object.keys(expected.publicAssets).length
    || !/^[a-f0-9]{64}$/.test(expected.checkoutPageHash)
    || Object.entries(expected.publicAssets).some(([route, asset]) => !publicAssetNames.includes(route.slice(1))
      || route !== '/' + route.slice(1) || !asset || !/^[a-f0-9]{64}$/.test(asset.hash)
      || asset.type !== (route.endsWith('.css') ? 'css' : 'js')))) throw new Error('Invalid public asset verification');
  if (expected.publicDownloads !== undefined && (!expected.publicDownloads || typeof expected.publicDownloads !== 'object'
    || Array.isArray(expected.publicDownloads) || Object.keys(expected.publicDownloads).length !== publicDownloadRoutes.size
    || Object.entries(expected.publicDownloads).some(([route, asset]) => !publicDownloadRoutes.has(route) || !asset
      || !/^[a-f0-9]{64}$/.test(asset.hash) || asset.type !== (route.endsWith('.zip') ? 'zip' : 'markdown')
      || (asset.type === 'zip' ? asset.filename !== route.split('/').at(-1) : asset.filename !== undefined)))) throw new Error('Invalid public download verification');
  const targets = { worker: httpsOrigin(expected.workerUrl), domain: httpsOrigin(expected.publicUrl) };
  const month = new Date(now + 8 * 3600000).toISOString().slice(0, 7);
  const options = { fetcher, dispatcher, sleep, attempts };
  const validStatus = status => response => ({ passed: response.status === status });
  const endpoints = {
    health: ['/api/health', (response, bytes) => {
      const data = JSON.parse(bytes.toString('utf8'));
      const healthSchema = response.status === 200 && data?.service === 'Brclio Pay'
        && typeof data.ready === 'boolean' && typeof data.acceptingPayments === 'boolean';
      const versionMatches = data?.version === expected.version;
      const modeMatches = data?.mode === expected.paymentMode;
      const paymentEnabledMatches = expected.paymentEnabled
        ? data?.ready === true && data?.acceptingPayments === true
        : data?.acceptingPayments === false;
      return { passed: healthSchema && versionMatches && modeMatches && paymentEnabledMatches,
        healthSchema, versionMatches, modeMatches, paymentEnabledMatches };
    }],
    adminPage: ['/admin', (response, bytes) => ({ passed: response.status === 200
      && /text\/html/i.test(response.headers.get('content-type') || '') && hash(bytes) === expected.adminPageHash })],
    adminScript: ['/admin.js', (response, bytes) => ({ passed: response.status === 200
      && /(?:application|text)\/javascript/i.test(response.headers.get('content-type') || '') && hash(bytes) === expected.adminScriptHash })],
    anonymousSummary: [`/api/admin/reports/summary?month=${month}`, validStatus(401)],
    anonymousOrders: ['/api/admin/reports/orders?limit=1', validStatus(401)],
    anonymousSkill: ['/api/admin/skill.zip', validStatus(401)],
    anonymousEnvironment: ['/api/admin/environment', validStatus(401)],
    anonymousEnvironmentValue: ['/api/admin/environment/value', validStatus(401), { method: 'POST', body: '{"name":"PAY_BASE_URL"}' }],
    staticSkill: ['/skills/brclio-pay-integrate.zip', validStatus(404)],
  };
  if (expected.publicAssets) {
    endpoints.checkoutPage = ['/checkout/pay_00000000000000000000000000000001', (response, bytes) => ({
      passed: response.status === 200 && /text\/html/i.test(response.headers.get('content-type') || '')
        && hash(bytes) === expected.checkoutPageHash && secureAsset(response),
    })];
    endpoints.checkoutWithoutToken = ['/api/checkout/pay_00000000000000000000000000000001', validStatus(401)];
    for (const [route, asset] of Object.entries(expected.publicAssets)) {
      endpoints['publicAsset:' + route] = [route, (response, bytes) => ({
        passed: response.status === 200 && hash(bytes) === asset.hash && secureAsset(response)
          && (asset.type === 'css' ? /text\/css/i : /(?:application|text)\/javascript/i).test(response.headers.get('content-type') || ''),
      })];
    }
  }
  for (const [route, asset] of Object.entries(expected.publicDownloads || {})) {
    endpoints['publicDownload:' + route] = [route, (response, bytes) => ({
      passed: response.status === 200 && hash(bytes) === asset.hash && secureAsset(response)
        && (asset.type === 'zip' ? /^application\/zip(?:;|$)/i : /^text\/markdown(?:;|$)/i).test(response.headers.get('content-type') || '')
        && (asset.type !== 'zip' || response.headers.get('content-disposition') === `attachment; filename="${asset.filename}"`),
    })];
  }
  const results = await Promise.all(Object.entries(targets).map(async ([label, base]) => [label,
    Object.fromEntries(await Promise.all(Object.entries(endpoints).map(async ([name, [route, validate, request]]) => [name,
      await probe(base, route, validate, options, request)])))]));
  const checks = Object.fromEntries(results);
  const deploymentPreflight = results.every(([, value]) => Object.values(value).every(check => check.passed));
  return { deploymentPreflight, configurationValid: true, ...checks };
}

export async function main() {
  let dispatcher;
  try {
    const expected = loadDeploymentExpectations();
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
    const result = await runDeploymentPreflight({ expected, dispatcher });
    console.log(JSON.stringify(result));
    if (!result.deploymentPreflight) process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ deploymentPreflight: false, configurationValid: false }));
    process.exitCode = 1;
  } finally {
    try { await dispatcher?.close(); }
    catch { console.error(JSON.stringify({ deploymentPreflight: false, transportClosed: false })); process.exitCode = 1; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
