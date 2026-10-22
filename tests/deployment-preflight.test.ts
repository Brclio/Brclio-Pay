import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentSkillMarkdown, deploymentSkillZip, skillMarkdown, skillZip, SKILL_VARIANTS } from '../src/skill';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const source = () => import(new URL('../scripts/deployment-preflight.mjs', import.meta.url).href);
const html = '<!doctype html><form id="loginForm"></form><script src="/admin.js" defer></script>';
const javascript = 'document.getElementById("loginForm");';
const secureHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000',
};
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const expected = (paymentEnabled = false) => ({ version: '0.3.0', paymentMode: 'live', paymentEnabled,
  workerUrl: 'https://worker.example', publicUrl: 'https://pay.example', adminPageHash: digest(html), adminScriptHash: digest(javascript) });

function response(url: URL, overrides: Record<string, unknown> = {}) {
  if (url.pathname === '/api/health') return new Response(JSON.stringify({ service: 'Brclio Pay', version: '0.3.0',
    mode: 'live', ready: false, acceptingPayments: false, ...overrides }), { headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/admin') return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  if (url.pathname === '/admin.js') return new Response(javascript, { headers: { 'content-type': 'application/javascript;charset=utf-8' } });
  if (url.pathname.startsWith('/api/admin/')) return new Response('{"error":{"code":"ADMIN_LOGIN_REQUIRED"}}', { status: 401 });
  if (url.pathname.startsWith('/skills/')) return new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 });
  throw new Error('Unexpected fixture route');
}

describe('read-only deployment verification', () => {
  it('checks both published entry points, exact administrator assets and anonymous access boundaries without credentials or writes', async () => {
    const { runDeploymentPreflight } = await source();
    const fetcher = vi.fn(async (url: URL, options: RequestInit) => {
      if (url.pathname === '/api/admin/environment/value') {
        expect(options.method).toBe('POST');
        expect(options.body).toBe('{"name":"PAY_BASE_URL"}');
        expect(new Headers(options.headers).get('Content-Type')).toBe('application/json');
      } else {
        expect(options.method).toBe('GET');
        expect(options.body).toBeUndefined();
      }
      expect(options.redirect).toBe('manual');
      expect(options.signal).toBeDefined();
      const headers = new Headers(options.headers);
      expect(headers.has('Authorization')).toBe(false);
      expect(headers.has('Cookie')).toBe(false);
      expect(headers.get('Cache-Control')).toBe('no-cache');
      return response(url);
    });
    const result = await runDeploymentPreflight({ expected: expected(), fetcher, attempts: 1, now: Date.UTC(2026, 9, 14, 17) });
    expect(result.deploymentPreflight).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(18);
    const requests = fetcher.mock.calls.map(([url]) => url);
    expect(new Set(requests.map(url => url.origin))).toEqual(new Set(['https://worker.example', 'https://pay.example']));
    expect(requests.filter(url => url.pathname === '/api/admin/reports/summary').map(url => url.search))
      .toEqual(['?month=2026-10', '?month=2026-10']);
    expect(result.worker.anonymousSummary.status).toBe(401);
    expect(result.domain.anonymousOrders.status).toBe(401);
    expect(result.worker.staticSkill.status).toBe(404);
    expect(result.worker.anonymousEnvironment.status).toBe(401);
    expect(result.domain.anonymousEnvironmentValue.status).toBe(401);
    expect(result.worker.health.paymentEnabledMatches).toBe(true);
  });

  it('supports a configured, ready production payment switch instead of requiring payments to remain disabled', async () => {
    const { runDeploymentPreflight } = await source();
    const fetcher = async (url: URL) => response(url, { ready: true, acceptingPayments: true });
    expect((await runDeploymentPreflight({ expected: expected(true), fetcher, attempts: 1 })).deploymentPreflight).toBe(true);
    const notReady = await runDeploymentPreflight({ expected: expected(true), fetcher: async (url: URL) => response(url), attempts: 1 });
    expect(notReady.deploymentPreflight).toBe(false);
    expect(notReady.worker.health.paymentEnabledMatches).toBe(false);
    const unexpectedEnable = await runDeploymentPreflight({ expected: expected(), fetcher, attempts: 1 });
    expect(unexpectedEnable.deploymentPreflight).toBe(false);
  });

  it('retries stale release assets and versions a bounded number of times for propagation', async () => {
    const { runDeploymentPreflight } = await source();
    const attempts = new Map<string, number>();
    const sleep = vi.fn(async () => {});
    const fetcher = async (url: URL) => {
      const attempt = (attempts.get(url.href) ?? 0) + 1;
      attempts.set(url.href, attempt);
      if (url.pathname === '/api/health' && attempt < 3) return response(url, { version: '0.2.0' });
      if (url.pathname === '/admin.js' && attempt === 1) return new Response('old deployment', { headers: { 'content-type': 'application/javascript' } });
      return response(url);
    };
    const result = await runDeploymentPreflight({ expected: expected(), fetcher, sleep });
    expect(result.deploymentPreflight).toBe(true);
    expect(attempts.get('https://worker.example/api/health')).toBe(3);
    expect(attempts.get('https://pay.example/admin.js')).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(sleep).toHaveBeenCalledWith(4000);
    expect(Math.max(...attempts.values())).toBe(3);
  });

  it('fails on environment drift, wrong access boundaries or stale administrator code and prints no response content', async () => {
    const { runDeploymentPreflight } = await source();
    const sensitive = 'DO_NOT_PRINT_RESPONSE_BODY_OR_SECRET';
    const fetcher = async (url: URL) => {
      if (url.hostname === 'worker.example' && url.pathname === '/api/health') return response(url, { mode: 'sandbox', extra: sensitive });
      if (url.hostname === 'pay.example' && url.pathname === '/admin') return new Response(sensitive, { headers: { 'content-type': 'text/html' } });
      if (url.pathname === '/api/admin/reports/orders') return new Response(sensitive, { status: 200 });
      if (url.pathname === '/api/admin/skill.zip') return new Response(sensitive, { status: 302 });
      if (url.pathname === '/api/admin/environment/value') return new Response(sensitive, { status: 200 });
      return response(url);
    };
    const result = await runDeploymentPreflight({ expected: expected(), fetcher, attempts: 1 });
    expect(result.deploymentPreflight).toBe(false);
    expect(result.worker.health.modeMatches).toBe(false);
    expect(result.domain.adminPage.passed).toBe(false);
    expect(result.domain.anonymousOrders.passed).toBe(false);
    expect(result.worker.anonymousSkill.status).toBe(302);
    expect(result.worker.anonymousEnvironmentValue.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain(sensitive);
    function checkLeaves(value: unknown) {
      if (value && typeof value === 'object') for (const child of Object.values(value)) checkLeaves(child);
      else expect(typeof value === 'boolean' || (Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599)).toBe(true);
    }
    checkLeaves(result);
  });

  it('bounds failures and response bodies and rejects non-HTTPS origins before fetching', async () => {
    const { runDeploymentPreflight } = await source();
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/api/health') throw new Error('Secret network diagnostic that must not escape');
      if (url.pathname === '/admin.js') return new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'application/javascript' } });
      return response(url);
    });
    const result = await runDeploymentPreflight({ expected: expected(), fetcher, sleep: async () => {} });
    expect(result.deploymentPreflight).toBe(false);
    expect(result.worker.health).toEqual({ passed: false });
    expect(result.domain.adminScript).toEqual({ passed: false, status: 200 });
    expect(JSON.stringify(result)).not.toContain('Secret network diagnostic');
    expect(fetcher.mock.calls.filter(([url]) => url.pathname === '/api/health')).toHaveLength(6);
    await expect(runDeploymentPreflight({ expected: { ...expected(), workerUrl: 'http://worker.example' }, fetcher })).rejects.toThrow();
    await expect(runDeploymentPreflight({ expected: expected(), fetcher, attempts: 4 })).rejects.toThrow();
  });

  it('verifies direct static bytes, MIME, security and freshness while checkout capabilities remain required', async () => {
    const { runDeploymentPreflight } = await source();
    const configured = { ...expected(), checkoutPageHash: digest(html), publicAssets: {
      '/checkout.js': { hash: digest(javascript), type: 'js' }, '/styles.css': { hash: digest('body{}'), type: 'css' },
    } };
    const fetcher = async (url: URL) => {
      if (url.pathname.startsWith('/api/checkout/')) return new Response('{}', { status: 401 });
      if (url.pathname.startsWith('/checkout/')) return new Response(html, { headers: { ...secureHeaders, 'Content-Type': 'text/html' } });
      if (url.pathname === '/checkout.js') return new Response(javascript, { headers: { ...secureHeaders, 'Content-Type': 'application/javascript' } });
      if (url.pathname === '/styles.css') return new Response('body{}', { headers: { ...secureHeaders, 'Content-Type': 'text/css' } });
      return response(url);
    };
    const good = await runDeploymentPreflight({ expected: configured, fetcher, attempts: 1 });
    expect(good.deploymentPreflight).toBe(true);
    for (const change of ['bytes', 'mime', 'headers', 'checkout-auth']) {
      const bad = await runDeploymentPreflight({ expected: configured, attempts: 1, fetcher: async (url: URL) => {
        if (change === 'checkout-auth' && url.pathname.startsWith('/api/checkout/')) return new Response('{}');
        if (url.pathname === '/checkout.js') return new Response(change === 'bytes' ? 'stale' : javascript, {
          headers: { ...(change === 'headers' ? {} : secureHeaders), 'Content-Type': change === 'mime' ? 'text/html' : 'application/javascript' },
        });
        return fetcher(url);
      } });
      expect(bad.deploymentPreflight).toBe(false);
    }
    await expect(runDeploymentPreflight({ expected: { ...configured, publicAssets: { '/api/private.js': { hash: digest(javascript), type: 'js' } } }, fetcher })).rejects.toThrow();
  });

  it('verifies all four public Skill ZIP and Markdown downloads and deployment docs against their exact released bytes', async () => {
    const { loadDeploymentExpectations, runDeploymentPreflight } = await source();
    const publicDownloads = loadDeploymentExpectations().publicDownloads;
    const bodies: Record<string, string | Uint8Array> = {};
    for (const name of [...SKILL_VARIANTS, 'brclio-pay-deploy'] as const) {
      bodies[`/api/skills/${name}.zip`] = name === 'brclio-pay-deploy' ? deploymentSkillZip() : skillZip(name);
      bodies[`/api/skills/${name}/SKILL.md`] = name === 'brclio-pay-deploy' ? deploymentSkillMarkdown() : skillMarkdown(name);
    }
    for (const name of ['deployment', 'environment-variables', 'merchant-setup']) {
      bodies[`/docs/${name}.md`] = await readFile(fileURLToPath(new URL(`../public/docs/${name}.md`, import.meta.url).href), 'utf8');
    }
    expect(Object.keys(publicDownloads)).toHaveLength(11);
    for (const [route, body] of Object.entries(bodies)) expect(publicDownloads[route].hash).toBe(digest(body));
    const fetcher = vi.fn(async (url: URL) => {
      const body = bodies[url.pathname];
      if (body !== undefined) return new Response(body as BodyInit, { headers: { ...secureHeaders,
        'Content-Type': url.pathname.endsWith('.zip') ? 'application/zip' : 'text/markdown;charset=utf-8',
        ...(url.pathname.endsWith('.zip') ? { 'Content-Disposition': `attachment; filename="${url.pathname.split('/').at(-1)}"` } : {}),
      } });
      return response(url);
    });
    const configured = { ...expected(), publicDownloads };
    const good = await runDeploymentPreflight({ expected: configured, fetcher, attempts: 1 });
    expect(good.deploymentPreflight).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(40);
    for (const change of ['bytes', 'mime', 'disposition', 'headers', 'missing']) {
      const bad = await runDeploymentPreflight({ expected: configured, attempts: 1, fetcher: async (url: URL) => {
        const route = change === 'bytes' ? '/docs/environment-variables.md' : '/api/skills/brclio-pay-deploy.zip';
        if (url.pathname !== route) return fetcher(url);
        const original = await fetcher(url);
        const headers = new Headers(change === 'headers' ? {} : original.headers);
        if (change === 'mime') headers.set('Content-Type', 'text/html');
        if (change === 'disposition') headers.set('Content-Disposition', 'inline');
        return new Response(change === 'bytes' ? 'stale release' : bodies[route] as BodyInit, { status: change === 'missing' ? 404 : 200, headers });
      } });
      expect(bad.deploymentPreflight).toBe(false);
    }
    for (const invalid of [{}, { ...publicDownloads, '/api/admin/private': { hash: digest('private'), type: 'markdown' } }]) {
      await expect(runDeploymentPreflight({ expected: { ...expected(), publicDownloads: invalid }, fetcher })).rejects.toThrow('Invalid public download verification');
    }
  });
});

describe('deployment expectation loading', () => {
  it('reads package version and JSONC environment switches without any credential files', async () => {
    const { loadDeploymentExpectations } = await source();
    const root = await mkdtemp(path.join(tmpdir(), 'brclio-deploy-test-')); temporary.push(root);
    await mkdir(path.join(root, 'public'));
    await mkdir(path.join(root, 'public/docs'));
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'package.json'), '{"version":"1.2.3"}');
    await writeFile(path.join(root, 'wrangler.jsonc'), '// Deployment configuration\n{"vars":{"PAY_BASE_URL":"https://pay.example", "PAYMENT_MODE":"sandbox", "PAYMENT_ENABLED":"true",},}');
    await writeFile(path.join(root, 'public/admin.html'), html);
    await writeFile(path.join(root, 'public/admin.js'), javascript);
    await writeFile(path.join(root, 'public/checkout.html'), html);
    for (const name of ['styles.css', 'admin.css', 'checkout.js', 'landing.js']) await writeFile(path.join(root, 'public', name), name.endsWith('.css') ? 'body{}' : javascript);
    for (const name of ['deployment', 'environment-variables', 'merchant-setup']) await writeFile(path.join(root, 'public/docs', `${name}.md`), `# ${name}\n`);
    const variants = Object.fromEntries(SKILL_VARIANTS.map(name => [name, { [`${name}/SKILL.md`]: `# ${name}\n` }]));
    await writeFile(path.join(root, 'src/skill-data.ts'), `export const skillVariants: Record<string, Record<string, string>> = ${JSON.stringify(variants)};\nexport const deploymentSkillFiles: Record<string, string> = {"brclio-pay-deploy/SKILL.md":"# deployment"};\n`);
    expect(loadDeploymentExpectations(root)).toMatchObject({ version: '1.2.3', paymentMode: 'sandbox', paymentEnabled: true,
      publicUrl: 'https://pay.example', workerUrl: 'https://brclio-pay-unified.aiyuechuang.workers.dev',
      adminPageHash: digest(html), adminScriptHash: digest(javascript) });
    expect(loadDeploymentExpectations(root).publicAssets['/styles.css']).toEqual({ hash: digest('body{}'), type: 'css' });
    expect(loadDeploymentExpectations(root).publicDownloads['/docs/deployment.md']).toEqual({ hash: digest('# deployment\n'), type: 'markdown' });
    expect(loadDeploymentExpectations(root).publicDownloads['/api/skills/brclio-pay-deploy/SKILL.md']).toEqual({ hash: digest('# deployment'), type: 'markdown' });
    await writeFile(path.join(root, 'src/skill-data.ts'), 'export const skillVariants = process.env;');
    expect(() => loadDeploymentExpectations(root)).toThrow('Invalid public Skill bundle');
    await writeFile(path.join(root, 'wrangler.jsonc'), '{"vars":{"PAY_BASE_URL":"https://pay.example","PAYMENT_MODE":"live","PAYMENT_ENABLED":"not-boolean"}}');
    expect(() => loadDeploymentExpectations(root)).toThrow();
  });
});
