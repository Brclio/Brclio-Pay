import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {createHmac, generateKeyPairSync, pbkdf2Sync} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

const source = () => import(new URL('../scripts/setup-deployment.mjs', import.meta.url).href);
let root: string;
let privateKey: string;
let publicKey: string;
let sequence = 0;
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'brclio-setup-test-'));
  const pair = generateKeyPairSync('rsa', {modulusLength: 2048, privateKeyEncoding: {format: 'pem', type: 'pkcs8'}, publicKeyEncoding: {format: 'pem', type: 'spki'}});
  privateKey = pair.privateKey;publicKey = pair.publicKey;
  await mkdir(resolve(root, 'merchant'));
  await writeFile(resolve(root, 'merchant/private.pem'), privateKey);
  await writeFile(resolve(root, 'merchant/public.pem'), publicKey);
  await writeFile(resolve(root, 'merchant/api-v3.txt'), 't'.repeat(32) + '\n');
  await writeFile(resolve(root, 'merchant/password.txt'), 'a test password longer than 12\n');
});
afterAll(async () => {await rm(root, {recursive: true, force: true});});

function fixture(providerMode = 'dual'): any {
  return {providerMode, cloudflare: {accountId: 'a'.repeat(32), workerName: 'my-test-pay', baseUrl: 'https://pay.example.test'},
    github: {appId: '12345', installationId: '67890', repository: 'sample-owner/private-payment-data', privateKeyFile: './merchant/private.pem'},
    admin: {email: 'Admin@example.test'},
    ...(providerMode !== 'wechat' ? {alipay: {appId: '2021000000000001', sellerId: '2088000000000001', privateKeyFile: './merchant/private.pem', publicKeyFile: './merchant/public.pem'}} : {}),
    ...(providerMode !== 'alipay' ? {wechat: {merchantId: '1234567890', appId: 'wx1234567890abcdef', serialNo: 'A'.repeat(40), privateKeyFile: './merchant/private.pem', apiV3KeyFile: './merchant/api-v3.txt', publicKeyId: 'PUB_KEY_ID_TEST', publicKeyFile: './merchant/public.pem'}} : {}),
  };
}

async function prepared(input = fixture()) {
  const {prepareSetup, readPreparedSetup} = await source();
  const output = 'secrets/generated-' + sequence++;
  await prepareSetup(input, {root, inputDirectory: root, output});
  return readPreparedSetup(output, {root});
}

function githubFetcher(overrides: {private?: boolean; existingGuide?: boolean; selection?: string} = {}) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, method = init.method || 'GET';
    let value: any;
    if (path.endsWith('/installation') && method === 'GET') value = {id: 67890, app_id: 12345, permissions: {contents: 'write'}, repository_selection: overrides.selection || 'selected'};
    else if (path.endsWith('/access_tokens')) value = {token: 'fake-test-installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {contents: 'write'}};
    else if (path === '/installation/token') return new Response(null, {status: 204});
    else if (path.endsWith('/branches/main')) value = {commit: {sha: 'b'.repeat(40)}};
    else if (path.includes('/contents/maintenance/environment/guide.json')) {
      if (method === 'GET' && !overrides.existingGuide) return new Response('{}', {status: 404});
      value = method === 'PUT' ? {content: {sha: 'c'.repeat(40)}} : {sha: 'c'.repeat(40)};
    } else if (path === '/repos/sample-owner/private-payment-data') value = {private: overrides.private !== false, full_name: 'sample-owner/private-payment-data'};
    else throw new Error('Unexpected fake GitHub request');
    return new Response(JSON.stringify(value), {status: 200});
  });
}

describe('first-install review artifacts', () => {
  it.each(['dual', 'alipay', 'wechat'])('prepares %s without unselected credentials, network calls or active payments', async mode => {
    const network = vi.spyOn(globalThis, 'fetch');
    const result = await prepared(fixture(mode));
    expect(network).not.toHaveBeenCalled();network.mockRestore();
    expect(result.config.vars.PAYMENT_ENABLED).toBe('false');
    expect(result.config.vars.ALIPAY_CHANNELS).toBe(mode === 'wechat' ? '' : 'page,wap');
    expect(result.config.vars.WECHAT_CHANNELS).toBe(mode === 'alipay' ? '' : 'native');
    expect(result.secrets.ALIPAY_PRIVATE_KEY !== undefined).toBe(mode !== 'wechat');
    expect(result.secrets.WECHAT_PRIVATE_KEY !== undefined).toBe(mode !== 'alipay');
    expect(result.config.vars.GITHUB_REPOSITORY).toBe('sample-owner/private-payment-data');
    const configText = result.files['wrangler.json'];
    expect(configText).not.toContain('PRIVATE KEY');expect(configText).not.toContain(result.secrets.CHECKOUT_SECRET);
    expect(configText).not.toContain('GITHUB_TOKEN');expect(configText).not.toContain('REGISTRY_ENCRYPTION_KEY');
    expect(configText).not.toMatch(/d1_databases|kv_namespaces|r2_buckets|durable_objects/);
    expect(result.files['environment-guide.json']).not.toContain('pay.bornforthis.cn');
    expect(result.files['environment-guide.json']).not.toContain('BrclioData/BrclioPay-Data');
    for (const name of [...Object.keys(result.plan.files), 'deployment-plan.json']) expect((await stat(resolve(result.output, name))).mode & 0o777).toBe(0o600);
    expect((await stat(result.output)).mode & 0o777).toBe(0o700);
  });

  it('hashes the generated admin password with the same PBKDF2/HMAC contract as runtime', async () => {
    const result = await prepared(fixture('wechat'));
    const login = JSON.parse(result.files['admin-login.json']);
    expect(login.password.length).toBeGreaterThanOrEqual(24);
    const [, iterations, salt, expected] = result.secrets.ADMIN_PASSWORD_HASH.split('$');
    const material = createHmac('sha256', result.secrets.ADMIN_PASSWORD_PEPPER).update(login.password).digest('hex');
    expect(pbkdf2Sync(material, Buffer.from(salt, 'hex'), Number(iterations), 32, 'sha256').toString('hex')).toBe(expected);
    expect(result.files['worker-secrets.json']).not.toContain(login.password);
    expect(result.secrets.ADMIN_EMAIL).toBe('admin@example.test');
    expect(new Set([result.secrets.CHECKOUT_SECRET, result.secrets.ADMIN_PASSWORD_PEPPER, result.secrets.ADMIN_SESSION_SECRET]).size).toBe(3);
  });

  it('uses supplied admin password without copying plaintext and permits an approved Alipay channel subset', async () => {
    const input = fixture('alipay');input.admin.passwordFile = './merchant/password.txt';input.alipay.channels = ['page'];
    const result = await prepared(input);
    expect(result.config.vars.ALIPAY_CHANNELS).toBe('page');
    expect(result.files['admin-login.json']).not.toContain('a test password');
    expect(result.files['worker-secrets.json']).not.toContain('a test password');
  });

  it('never overwrites generated service credentials and blocks altered review artifacts', async () => {
    const {prepareSetup, readPreparedSetup} = await source();
    const result = await prepared();
    const original = await readFile(resolve(result.output, 'worker-secrets.json'), 'utf8');
    await expect(prepareSetup(fixture(), {root, inputDirectory: root, output: result.output})).rejects.toThrow('SETUP_OUTPUT_ALREADY_EXISTS_NO_OVERWRITE');
    expect(await readFile(resolve(result.output, 'worker-secrets.json'), 'utf8')).toBe(original);
    await writeFile(resolve(result.output, 'worker-secrets.json'), original + ' ');
    await expect(readPreparedSetup(result.output, {root})).rejects.toThrow('REVIEWED_SETUP_CHANGED_NO_DEPLOY');
  });

  it('rejects production targets, inline credential fields and invalid channel/merchant input', async () => {
    const {validateSetupInput, parseSetupArguments} = await source();
    const production = fixture();production.cloudflare.accountId = 'cacceff607775c81f667b7a951d4639f';
    expect(() => validateSetupInput(production)).toThrow('FIRST_INSTALL_CANNOT_TARGET_EXISTING_PRODUCTION');
    const raw = fixture();raw.admin.password = 'should not accept inline password';
    expect(() => validateSetupInput(raw)).toThrow('INVALID_SETUP_FIELDS');
    const invalid = fixture();invalid.alipay.channels = ['page', 'page'];
    expect(() => validateSetupInput(invalid)).toThrow('INVALID_ALIPAY_CHANNELS');
    const wrong = fixture('wechat');wrong.wechat.publicKeyId = 'merchant-certificate-serial';
    expect(() => validateSetupInput(wrong)).toThrow('INVALID_WECHAT_PUBLIC_KEY_ID');
    expect(() => parseSetupArguments(['--input', 'x', '--deploy'])).toThrow('PREPARE_THEN_DEPLOY_SEPARATELY');
    expect(parseSetupArguments(['--deploy', '--output', 'secrets/reviewed', '--pages'])).toMatchObject({deploy: true, output: 'secrets/reviewed', pages: true});
  });

  it('rejects output outside ignored secrets and symlinked output directories', async () => {
    const {prepareSetup} = await source();
    await expect(prepareSetup(fixture(), {root, inputDirectory: root, output: 'public/credentials'})).rejects.toThrow('OUTPUT_MUST_BE_UNDER_SECRETS');
    await symlink(resolve(root, 'merchant'), resolve(root, 'secrets/linked'));
    await expect(prepareSetup(fixture(), {root, inputDirectory: root, output: 'secrets/linked/generated'})).rejects.toThrow('OUTPUT_DIRECTORY_MUST_NOT_BE_SYMLINK');
  });
});

describe('repository and Cloudflare authorization', () => {
  it('requests only one repository with Contents write and refuses public data repositories', async () => {
    const {authorizeSetupRepository} = await source(), result = await prepared();
    const fetcher = githubFetcher();
    const github = await authorizeSetupRepository(result.config, result.secrets, {fetcher});
    const issued = fetcher.mock.calls.find(([url]) => url.endsWith('/access_tokens'));
    expect(JSON.parse(issued![1].body as string)).toEqual({repositories: ['private-payment-data'], permissions: {contents: 'write'}});
    await github.revoke();
    const publicRepo = githubFetcher({private: false});
    await expect(authorizeSetupRepository(result.config, result.secrets, {fetcher: publicRepo})).rejects.toThrow('GITHUB_DATA_REPOSITORY_MUST_BE_PRIVATE');
    expect(publicRepo.mock.calls.some(([url, init]) => url.endsWith('/installation/token') && init.method === 'DELETE')).toBe(true);
    await expect(authorizeSetupRepository(result.config, result.secrets, {fetcher: githubFetcher({selection: 'all'})})).rejects.toThrow('GITHUB_APP_REQUIRES_SELECTED_PRIVATE_REPOSITORY_CONTENTS_WRITE');
  });

  it('only creates a missing guide and preserves existing metadata and all business data', async () => {
    const {authorizeSetupRepository, initializeSetupGuide} = await source(), result = await prepared();
    const fetcher = githubFetcher(), github = await authorizeSetupRepository(result.config, result.secrets, {fetcher});
    expect(await initializeSetupGuide(github, result)).toMatchObject({operation: 'created'});
    const put = fetcher.mock.calls.find(([, init]) => init.method === 'PUT')!;
    const written = JSON.parse(put[1].body as string);
    expect(Buffer.from(written.content, 'base64').toString('utf8')).toBe(result.files['environment-guide.json']);
    expect(written).not.toHaveProperty('sha');
    expect(put[0]).toContain('/contents/maintenance/environment/guide.json');
    await github.revoke();
    const existing = githubFetcher({existingGuide: true}), existingGithub = await authorizeSetupRepository(result.config, result.secrets, {fetcher: existing});
    expect(await initializeSetupGuide(existingGithub, result)).toMatchObject({operation: 'preserved'});
    expect(existing.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false);await existingGithub.revoke();
  });

  it('refuses an existing Worker before requesting a GitHub token or uploading any secrets', async () => {
    const {deployPreparedSetup} = await source(), result = await prepared();
    const spawn = vi.fn(() => ({status: 0, stdout: '[]', stderr: ''})), fetcher = githubFetcher();
    await expect(deployPreparedSetup(result, {root, spawn, fetcher})).rejects.toThrow('WORKER_ALREADY_EXISTS_USE_MAINTENANCE_DEPLOYMENT');
    expect(fetcher).not.toHaveBeenCalled();expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls.some((call: any[]) => call[1].includes('--secrets-file'))).toBe(false);
  });

  it('requires confirmed not-found and authenticated account, then uploads secrets atomically and records evidence limits', async () => {
    const {deployPreparedSetup} = await source(), result = await prepared();
    const version = '11111111-2222-3333-4444-555555555555';
    const spawn = vi.fn((_cmd: string, args: string[]) => args.includes('versions') ? {status: 1, stdout: '', stderr: '[code: 10007] Worker not found'} : {status: 0, stdout: args.includes('deploy') ? 'Current Version ID: ' + version : '{}', stderr: ''});
    const receipt = await deployPreparedSetup(result, {root, spawn, fetcher: githubFetcher()});
    expect(receipt).toMatchObject({version, paymentEnabled: false, domainVerified: false, realPaymentVerified: false, fulfillmentVerified: false});
    const deploy = spawn.mock.calls.find(([, args]) => args.includes('--secrets-file'))!;
    expect(deploy[1]).toContain(resolve(result.output, 'worker-secrets.json'));
    expect(deploy[1]).toContain(resolve(result.output, 'wrangler.json'));
    expect(JSON.stringify(deploy)).not.toContain(result.secrets.CHECKOUT_SECRET);
    const args = spawn.mock.calls.flatMap(([, command]) => command);
    expect(args).not.toContain('--var');expect(args).not.toContain('--routes');expect(args).not.toContain('--domains');
    const recorded = JSON.parse(await readFile(resolve(result.output, 'deployment-receipt.json'), 'utf8'));
    expect(recorded.version).toBe(version);
  });

  it('builds an optional Pages gateway with only a service binding to the selected Worker', async () => {
    const input = fixture('wechat');input.cloudflare.pagesProjectName = 'my-test-gateway';
    const result = await prepared(input);
    const pages = JSON.parse(result.files['pages/wrangler.json']);
    expect(pages).toMatchObject({name: 'my-test-gateway', services: [{binding: 'PAYMENT_BACKEND', service: 'my-test-pay'}]});
    expect(pages.vars).toBeUndefined();expect(pages.account_id).toBeUndefined();
    expect(result.files['pages/public/_worker.js']).toContain('env.PAYMENT_BACKEND.fetch(request)');
  });
});
