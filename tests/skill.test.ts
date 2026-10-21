import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { URL as NodeURL } from 'node:url';
import { skillMarkdown, skillZip, makeIntegrationPrompt } from '../src/skill';

const temporary: string[] = [];
async function workspace() {
  const directory = await mkdtemp(path.join(tmpdir(), 'brclio-skill-test-'));
  temporary.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const clientSecret = 'client_secret_fixture_'.repeat(3);
const webhookSecret = 'webhook_secret_fixture_'.repeat(3);
const grant = 'brp_int_' + 'a'.repeat(48);
const cliEnv = { BRCLIO_PAY_INTEGRATION_TOKEN: grant, BRCLIO_PAY_BASE_URL: 'https://pay.bornforthis.cn' };

async function integrationClient() {
  return (await import(new URL('../skills/brclio-pay-integrate/scripts/integration-client.mjs', import.meta.url).href)).runIntegrationClient;
}

describe('portable skill delivery', () => {
  it('builds a reproducible standard ZIP that unzip validates and extracts faithfully', async () => {
    const directory = await workspace();
    const archive = path.join(directory, 'skill.zip');
    const bytes = skillZip();
    expect(bytes).toEqual(skillZip());
    await writeFile(archive, bytes);
    execFileSync('unzip', ['-t', archive], { stdio: 'pipe' });
    execFileSync('unzip', ['-q', archive, '-d', path.join(directory, 'unpacked')], { stdio: 'pipe' });
    const base = path.join(directory, 'unpacked/brclio-pay-integrate');
    expect(await readFile(path.join(base, 'SKILL.md'), 'utf8')).toBe(skillMarkdown());
    for (const file of ['references/integration.md', 'scripts/inspect-platform.mjs', 'scripts/integration-client.mjs', 'assets/payment-client.mjs', 'assets/webhook-handler.mjs', 'assets/payment-completion.mjs']) {
      expect(await readFile(path.join(base, file), 'utf8')).toBe(await readFile(new NodeURL('../skills/brclio-pay-integrate/' + file, import.meta.url), 'utf8'));
    }
    expect(await readFile(path.join(base, 'assets/payment-client.mjs'), 'utf8')).toBe(await readFile(new NodeURL('../examples/payment-client.mjs', import.meta.url), 'utf8'));
    expect(await readFile(path.join(base, 'assets/webhook-handler.mjs'), 'utf8')).toBe(await readFile(new NodeURL('../examples/webhook-handler.mjs', import.meta.url), 'utf8'));
    const completion = path.join(base, 'assets/payment-completion.mjs');
    expect(await readFile(completion, 'utf8')).toBe(await readFile(new NodeURL('../examples/payment-completion.mjs', import.meta.url), 'utf8'));
    // The downloaded bundle supplies a working, client-safe module, not only instructions.
    expect(typeof (await import(new NodeURL('file://' + completion).href)).createPaymentCompletionWatcher).toBe('function');
  });

  it('puts the scoped token only into its requested per-task prompt', () => {
    const prompt = makeIntegrationPrompt({ clientId: 'one-product', mode: 'create', paymentMode: 'sandbox', token: grant, expiresAt: '2026-10-14T12:00:00Z', baseUrl: cliEnv.BRCLIO_PAY_BASE_URL });
    expect(prompt).toContain(grant);
    expect(prompt).toContain('one-product');
    expect(skillMarkdown()).not.toContain(grant);
    expect(new TextDecoder().decode(skillZip())).not.toContain(grant);
    expect(prompt).toContain('新增该产品接入');
    expect(prompt).toContain('支付环境：sandbox');
    expect(prompt).toContain(skillMarkdown());
    const bootstrapUrl = prompt.match(/https:\/\/[^\s]+\/api\/integration\/v1\/skill\.zip/)?.[0];
    expect(bootstrapUrl).toBe('https://pay.bornforthis.cn/api/integration/v1/skill.zip');
    expect(new URL(bootstrapUrl!).search).toBe('');
    expect(bootstrapUrl).not.toContain(grant);
    expect(() => makeIntegrationPrompt({ clientId: 'one-product', mode: 'update', token: grant + '\nInjected', expiresAt: '2026-10-14T12:00:00Z', baseUrl: cliEnv.BRCLIO_PAY_BASE_URL })).toThrow();
    expect(() => makeIntegrationPrompt({ clientId: 'one-product', mode: 'update', token: grant, expiresAt: 'invalid', baseUrl: 'http://pay.bornforthis.cn' })).toThrow();
  });

  it('selects project detection by default or explicit manual pricing independently of grant and payment modes', () => {
    const options = { clientId: 'one-product', mode: 'update' as const, paymentMode: 'live' as const,
      token: grant, expiresAt: '2026-10-14T12:00:00Z', baseUrl: cliEnv.BRCLIO_PAY_BASE_URL };
    const detected = makeIntegrationPrompt(options);
    const manual = makeIntegrationPrompt({ ...options, pricingMode: 'manual' });
    expect(detected).toContain('套餐来源模式：detect：');
    expect(manual).toContain('套餐来源模式：manual：');
    for (const prompt of [detected, manual]) {
      expect(prompt).toContain('操作类型：修改该产品现有接入');
      expect(prompt).toContain('支付环境：live');
      expect(prompt).toContain('context.allowedOrigins');
      expect(prompt).toContain('历史订单继续按创建时快照核对');
    }
    expect(() => makeIntegrationPrompt({ ...options, pricingMode: 'invent' as 'detect' })).toThrow();
  });

  it('distinguishes explicitly authorized automatic domains from legacy fixed scopes in self-contained tasks', () => {
    const options = { clientId: 'one-product', mode: 'create' as const, token: grant,
      expiresAt: '2026-10-14T12:00:00Z', baseUrl: cliEnv.BRCLIO_PAY_BASE_URL };
    const fixed = makeIntegrationPrompt(options);
    const auto = makeIntegrationPrompt({ ...options, domainMode: 'auto' });
    expect(fixed).toContain('域名授权模式：fixed：');
    expect(auto).toContain('域名授权模式：auto：');
    expect(auto).toContain('addedOrigins');
    expect(auto).toContain('不需逐个再次授权');
    expect(() => makeIntegrationPrompt({ ...options, domainMode: 'open' as 'auto' })).toThrow();
  });
});

describe('repository inspection forward fixture', () => {
  it('finds existing providers and business modules without reading or printing dotenv or private files', async () => {
    const directory = await workspace();
    await mkdir(path.join(directory, 'src/auth'), { recursive: true });
    await mkdir(path.join(directory, 'src/orders'), { recursive: true });
    await mkdir(path.join(directory, 'node_modules/hidden'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ dependencies: { next: '1', stripe: '1' } }));
    await writeFile(path.join(directory, 'src/auth/login.ts'), 'export const login = () => true;');
    await writeFile(path.join(directory, 'src/orders/webhook.ts'), 'import Stripe from "stripe"; const licenses = [];');
    await writeFile(path.join(directory, '.env.production'), 'DO_NOT_READ_ENV_SECRET=SUPER_SECRET_VALUE\nPAYMENT=paddle\n');
    await writeFile(path.join(directory, 'src/private-key.ts'), 'const secret = "DO_NOT_READ_PRIVATE_SECRET"; const provider = "paypal";');
    await writeFile(path.join(directory, 'node_modules/hidden/alipay.ts'), 'const hidden = "DO_NOT_SCAN_NODE_MODULES";');
    await symlink(path.join(directory, '.env.production'), path.join(directory, 'src/linked.ts'));
    const { inspectPlatform } = await import(new URL('../skills/brclio-pay-integrate/scripts/inspect-platform.mjs', import.meta.url).href);
    const result = await inspectPlatform(directory);
    expect(result.packageDependencies).toEqual(['next', 'stripe']);
    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/auth/login.ts', capabilities: ['authentication'] }),
      expect.objectContaining({ path: 'src/orders/webhook.ts', providers: ['stripe'], capabilities: ['orders', 'webhook'] }),
    ]));
    const output = JSON.stringify(result);
    for (const secret of ['SUPER_SECRET_VALUE', 'DO_NOT_READ_PRIVATE_SECRET', 'DO_NOT_SCAN_NODE_MODULES']) expect(output).not.toContain(secret);
    expect(output).not.toContain('paddle');
    expect(output).not.toContain('paypal');
    expect(result.skippedSensitive).toBe(2);
    expect(await inspectPlatform(directory)).toEqual(result);
    const executableOutput = execFileSync(process.execPath, [new URL('../skills/brclio-pay-integrate/scripts/inspect-platform.mjs', import.meta.url).pathname, directory], { encoding: 'utf8' });
    expect(JSON.parse(executableOutput)).toEqual(result);
  });

  it('locates plan evidence with file and line hints without extracting prices, fixtures or credentials', async () => {
    const directory = await workspace();
    for (const folder of ['src/server', 'src/pages', 'docs', 'prisma', 'tests/fixtures']) await mkdir(path.join(directory, folder), { recursive: true });
    const catalog = 'export const plans = {\n  monthly: { sku: "monthly", price: "123.45", currency: "USD", credits: 100 }\n};\n';
    await writeFile(path.join(directory, 'src/server/plans.ts'), catalog);
    await writeFile(path.join(directory, 'src/pages/pricing.tsx'), 'export const price = "123.45";\n');
    await writeFile(path.join(directory, 'docs/pricing.md'), '# Monthly plan\nPrice: 123.45\nValidity: 30 days\n');
    await writeFile(path.join(directory, 'prisma/schema.prisma'), 'model Plan {\n  id String @id\n  price Decimal\n}\n');
    await writeFile(path.join(directory, 'tests/fixtures/pricing.json'), '{"sku":"fake", "price":"987.65"}');
    await writeFile(path.join(directory, '.env.pricing'), 'PRIVATE_PRICE=666.66\nTOKEN=DO_NOT_READ');
    const { inspectPlatform } = await import(new URL('../skills/brclio-pay-integrate/scripts/inspect-platform.mjs', import.meta.url).href);
    const result = await inspectPlatform(directory);
    expect(result.catalogCandidates).toEqual(expect.arrayContaining([
      { path: 'src/server/plans.ts', line: 2, kind: 'server-config', signals: ['amount', 'catalog', 'entitlement', 'currency'] },
      expect.objectContaining({ path: 'src/pages/pricing.tsx', line: 1, kind: 'display' }),
      expect.objectContaining({ path: 'docs/pricing.md', line: 2, kind: 'documentation' }),
      expect.objectContaining({ path: 'prisma/schema.prisma', line: 3, kind: 'data-schema' }),
    ]));
    expect(result.catalogCandidates.some((item: { path: string }) => item.path.startsWith('tests/'))).toBe(false);
    const output = JSON.stringify(result);
    for (const value of ['123.45', '987.65', '666.66', 'DO_NOT_READ']) expect(output).not.toContain(value);
    expect(await readFile(path.join(directory, 'src/server/plans.ts'), 'utf8')).toBe(catalog);
    expect(result.catalogTruncated).toBe(false);
  });
});

describe('scoped integration CLI', () => {
  const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
  const context = { clientId: 'one-product', mode: 'update', paymentMode: 'live', client: { id: 'one-product', version: 'a'.repeat(64) }, credentials: { apiSecret: clientSecret, webhookSecret }, expiresAt: '2026-10-14T12:00:00Z' };

  it('uses a scoped Authorization header and redacts credentials from normal output', async () => {
    const run = await integrationClient();
    const fetcher = vi.fn(async () => response(context));
    const output = vi.fn();
    await run({ argv: ['context'], env: cliEnv, fetcher, output });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe('https://pay.bornforthis.cn/api/integration/v1/context');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + grant);
    expect(init.redirect).toBe('error');
    expect(String(output.mock.calls[0][0])).not.toContain(clientSecret);
    expect(String(output.mock.calls[0][0])).not.toContain(webhookSecret);
    expect(String(output.mock.calls[0][0])).not.toContain(grant);
    expect(String(output.mock.calls[0][0])).toContain('[REDACTED]');
  });

  it('writes only target credentials to an explicit Git-ignored new 0600 file', async () => {
    const directory = await workspace();
    execFileSync('git', ['init', '-q', directory], { stdio: 'pipe' });
    await writeFile(path.join(directory, '.gitignore'), '.env.brclio-pay\n');
    const destination = path.join(directory, '.env.brclio-pay');
    const run = await integrationClient();
    const output = vi.fn();
    await run({ argv: ['context', '--credentials-file', destination], env: cliEnv, fetcher: async () => response(context), output });
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    const contents = await readFile(destination, 'utf8');
    expect(contents).toContain(clientSecret);
    expect(contents).toContain(webhookSecret);
    expect(contents).not.toContain(grant);
    expect(String(output.mock.calls[0][0])).not.toContain(clientSecret);
    await expect(run({ argv: ['context', '--credentials-file', destination], env: cliEnv, fetcher: async () => response(context), output })).rejects.toThrow();
    await expect(run({ argv: ['context', '--credentials-file', path.join(directory, 'tracked.env')], env: cliEnv, fetcher: async () => response(context), output })).rejects.toThrow();
  });

  it('supports credentials returned after new-product apply but does not persist its scoped token', async () => {
    const directory = await workspace();
    execFileSync('git', ['init', '-q', directory], { stdio: 'pipe' });
    await writeFile(path.join(directory, '.gitignore'), '.env.brclio-pay\n');
    const run = await integrationClient();
    const fetcher = vi.fn(async () => response({ client: context.client, credentials: context.credentials, appliedAt: '2026-10-14T10:00:00Z' }));
    await run({ argv: ['apply', 'plan_example123', '--credentials-file', path.join(directory, '.env.brclio-pay')], env: cliEnv, fetcher, output: vi.fn() });
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ planId: 'plan_example123' });
    expect(await readFile(path.join(directory, '.env.brclio-pay'), 'utf8')).not.toContain(grant);
  });

  it('plans with explicit version comparison and refuses credential-bearing plan files', async () => {
    const directory = await workspace();
    const filename = path.join(directory, 'plan.json');
    const payload = { config: { id: 'one-product', name: 'One', webhookUrl: 'https://one.example/webhook', returnOrigins: ['https://one.example'], skus: { pro: { subject: 'Pro', amount: '9.90' } }, enabled: true }, expectedVersion: 'absent' };
    await writeFile(filename, JSON.stringify(payload));
    const run = await integrationClient();
    const fetcher = vi.fn(async () => response({ planId: 'plan_example123', before: null, after: payload.config }));
    await run({ argv: ['plan', filename], env: cliEnv, fetcher, output: vi.fn() });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/integration/v1/plan');
    expect(JSON.parse(String(init.body))).toEqual(payload);
    await writeFile(filename, JSON.stringify({ ...payload, apiSecret: clientSecret }));
    await expect(run({ argv: ['plan', filename], env: cliEnv, fetcher, output: vi.fn() })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 409])('stops on authorization or version conflict HTTP %s without printing provider bodies', async status => {
    const run = await integrationClient();
    const fetcher = vi.fn(async () => response({ error: 'provider body ' + grant }, status));
    const output = vi.fn();
    await expect(run({ argv: ['apply', 'plan_example123'], env: cliEnv, fetcher, output })).rejects.toThrow(`Integration API HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();
  });
});
