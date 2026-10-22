#!/usr/bin/env node
/** First install for a new account. Existing production deployment scripts stay separate. */
import {createHash, createHmac, createPrivateKey, createPublicKey, pbkdf2Sync, randomBytes, sign} from 'node:crypto';
import {chmod, lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {chmodSync} from 'node:fs';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validateEnvironmentGuide} from './sync-environment-guide.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE_PATH = 'maintenance/environment/guide.json';
const PRODUCTION = {account: 'cacceff607775c81f667b7a951d4639f', worker: 'brclio-pay-unified', repository: 'BrclioData/BrclioPay-Data'};
const PUBLIC_NAMES = new Set(['PAY_BASE_URL', 'PAYMENT_MODE', 'PAYMENT_ENABLED', 'ALIPAY_CHANNELS', 'WECHAT_CHANNELS', 'ALIPAY_APP_ID', 'ALIPAY_GATEWAY', 'WECHAT_MCH_ID', 'WECHAT_APP_ID', 'WECHAT_PUBLIC_KEY_ID', 'GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_REPOSITORY', 'GITHUB_BRANCH', 'REGISTRY_STORAGE_MODE', 'CLIENTS_JSON']);
const SECRET_NAMES = new Set(['GITHUB_APP_PRIVATE_KEY', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY', 'ALIPAY_SELLER_ID', 'WECHAT_PRIVATE_KEY', 'WECHAT_SERIAL_NO', 'WECHAT_API_V3_KEY', 'WECHAT_PUBLIC_KEYS_JSON', 'ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD_PEPPER', 'ADMIN_SESSION_SECRET', 'CHECKOUT_SECRET']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => {throw new Error(code);};
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha = value => createHash('sha256').update(value).digest('hex');
const randomSecret = () => randomBytes(32).toString('hex');
const keys = (value, allowed, required = allowed) => {
  if (!plain(value) || Object.keys(value).some(name => !allowed.includes(name)) || required.some(name => !Object.hasOwn(value, name))) fail('INVALID_SETUP_FIELDS');
};
const string = (value, pattern, code) => {if (typeof value !== 'string' || !pattern.test(value)) fail(code);return value;};

export function parseSetupArguments(argv) {
  const options = {output: 'secrets/setup-generated', deploy: false, pages: false, help: false};
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (seen.has(arg)) fail('DUPLICATE_ARGUMENT');
    seen.add(arg);
    if (arg === '--help') options.help = true;
    else if (arg === '--deploy') options.deploy = true;
    else if (arg === '--pages') options.pages = true;
    else if (['--input', '--output'].includes(arg) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[arg.slice(2)] = argv[++index];
    else fail('INVALID_ARGUMENT');
  }
  if (!options.help && ((!options.input && !options.deploy) || (options.input && options.deploy) || (options.pages && !options.deploy))) fail('PREPARE_THEN_DEPLOY_SEPARATELY');
  return options;
}

export function validateSetupInput(input) {
  keys(input, ['providerMode', 'cloudflare', 'github', 'admin', 'alipay', 'wechat'], ['providerMode', 'cloudflare', 'github', 'admin']);
  if (!['dual', 'alipay', 'wechat'].includes(input.providerMode)) fail('INVALID_PROVIDER_MODE');
  keys(input.cloudflare, ['accountId', 'workerName', 'baseUrl', 'pagesProjectName'], ['accountId', 'workerName', 'baseUrl']);
  string(input.cloudflare.accountId, /^[a-f0-9]{32}$/, 'INVALID_CLOUDFLARE_ACCOUNT');
  string(input.cloudflare.workerName, /^[a-z0-9][a-z0-9-]{0,62}$/, 'INVALID_WORKER_NAME');
  if (input.cloudflare.pagesProjectName !== undefined) string(input.cloudflare.pagesProjectName, /^[a-z0-9][a-z0-9-]{0,62}$/, 'INVALID_PAGES_NAME');
  let base;
  try {base = new URL(input.cloudflare.baseUrl);} catch {fail('INVALID_PAY_BASE_URL');}
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' || base.port) fail('INVALID_PAY_BASE_URL');
  keys(input.github, ['appId', 'installationId', 'repository', 'branch', 'privateKeyFile'], ['appId', 'installationId', 'repository', 'privateKeyFile']);
  string(input.github.appId, /^\d+$/, 'INVALID_GITHUB_APP_ID');
  string(input.github.installationId, /^\d+$/, 'INVALID_GITHUB_INSTALLATION_ID');
  string(input.github.repository, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/, 'INVALID_PRIVATE_REPOSITORY');
  if (input.github.branch !== undefined) string(input.github.branch, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/, 'INVALID_GITHUB_BRANCH');
  if (input.github.branch?.includes('..') || input.github.branch?.includes('//') || input.github.branch?.endsWith('/') || input.github.branch?.endsWith('.lock')) fail('INVALID_GITHUB_BRANCH');
  if (input.cloudflare.accountId === PRODUCTION.account || input.cloudflare.workerName === PRODUCTION.worker || input.github.repository.toLowerCase() === PRODUCTION.repository.toLowerCase()) fail('FIRST_INSTALL_CANNOT_TARGET_EXISTING_PRODUCTION');
  keys(input.admin, ['email', 'passwordFile'], ['email']);
  string(input.admin.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'INVALID_ADMIN_EMAIL');
  const hasAlipay = input.providerMode !== 'wechat', hasWechat = input.providerMode !== 'alipay';
  if (hasAlipay) {
    keys(input.alipay, ['appId', 'sellerId', 'privateKeyFile', 'publicKeyFile', 'gateway', 'channels'], ['appId', 'sellerId', 'privateKeyFile', 'publicKeyFile']);
    string(input.alipay.appId, /^20\d{14}$/, 'INVALID_ALIPAY_APP_ID');
    string(input.alipay.sellerId, /^2088\d{12}$/, 'INVALID_ALIPAY_SELLER_ID');
    if (input.alipay.gateway !== undefined && input.alipay.gateway !== 'https://openapi.alipay.com/gateway.do') fail('ONLY_LIVE_ALIPAY_GATEWAY_SUPPORTED');
    if (input.alipay.channels !== undefined) {
      const channels = typeof input.alipay.channels === 'string' ? input.alipay.channels.split(',') : input.alipay.channels;
      if (!Array.isArray(channels) || !channels.length || channels.some(value => !['page', 'wap'].includes(value)) || new Set(channels).size !== channels.length) fail('INVALID_ALIPAY_CHANNELS');
    }
  } else if (input.alipay !== undefined) fail('UNSELECTED_ALIPAY_INPUT');
  if (hasWechat) {
    keys(input.wechat, ['merchantId', 'appId', 'serialNo', 'privateKeyFile', 'apiV3KeyFile', 'publicKeyId', 'publicKeyFile']);
    string(input.wechat.merchantId, /^\d{6,20}$/, 'INVALID_WECHAT_MERCHANT_ID');
    string(input.wechat.appId, /^wx[A-Za-z0-9]{16}$/, 'INVALID_WECHAT_APP_ID');
    string(input.wechat.serialNo, /^[A-Fa-f0-9]{16,64}$/, 'INVALID_WECHAT_SERIAL');
    string(input.wechat.publicKeyId, /^PUB_KEY_ID_[A-Za-z0-9_]+$/, 'INVALID_WECHAT_PUBLIC_KEY_ID');
  } else if (input.wechat !== undefined) fail('UNSELECTED_WECHAT_INPUT');
  for (const value of [input.github.privateKeyFile, input.admin.passwordFile, input.alipay?.privateKeyFile, input.alipay?.publicKeyFile, input.wechat?.privateKeyFile, input.wechat?.apiV3KeyFile, input.wechat?.publicKeyFile].filter(value => value !== undefined)) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\r\n\0]/.test(value)) fail('INVALID_INPUT_FILE_PATH');
  }
  return input;
}

async function fileText(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024) fail('INVALID_INPUT_FILE');
    return await readFile(path, 'utf8');
  } catch {fail('INPUT_FILE_UNAVAILABLE');}
}

function rsaKey(value, privateKey) {
  try {
    const text = !privateKey && !value.includes('-----BEGIN') ? '-----BEGIN PUBLIC KEY-----\n' + value.replace(/\s/g, '') + '\n-----END PUBLIC KEY-----\n' : value;
    const key = privateKey ? createPrivateKey(text) : createPublicKey(text);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) fail('INVALID_RSA_KEY');
    return key.export({format: 'pem', type: privateKey ? 'pkcs8' : 'spki'}).toString();
  } catch {fail(privateKey ? 'INVALID_RSA_PRIVATE_KEY_FILE' : 'INVALID_RSA_PUBLIC_KEY_FILE');}
}

/** Outputs must resolve beneath the ignored secrets directory, including through symlinks. */
async function outputDirectory(path, root, create) {
  root = await realpath(root);
  const secrets = resolve(root, 'secrets');
  await mkdir(secrets, {recursive: true, mode: 0o700});
  if (!(await lstat(secrets)).isDirectory() || (await realpath(secrets)) !== secrets) fail('SECRETS_DIRECTORY_MUST_NOT_BE_SYMLINK');
  await chmod(secrets, 0o700);
  const output = resolve(root, path), sub = relative(secrets, output);
  if (!sub || sub.startsWith('..' + sep) || sub === '..' || isAbsolute(sub)) fail('OUTPUT_MUST_BE_UNDER_SECRETS');
  let current = secrets;
  for (const part of sub.split(sep)) {
    current = resolve(current, part);
    if (create && current === output) {
      try {await mkdir(current, {mode: 0o700});} catch (error) {if (error?.code === 'EEXIST') fail('SETUP_OUTPUT_ALREADY_EXISTS_NO_OVERWRITE');throw error;}
    } else {
      if (create) await mkdir(current, {recursive: false, mode: 0o700}).catch(error => {if (error?.code !== 'EEXIST') throw error;});
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('OUTPUT_DIRECTORY_MUST_NOT_BE_SYMLINK');
    }
  }
  return output;
}

function newWorkerConfig(input, root) {
  return {
    $schema: resolve(root, 'node_modules/wrangler/config-schema.json'),
    name: input.cloudflare.workerName, account_id: input.cloudflare.accountId,
    main: resolve(root, 'src/index.ts'), compatibility_date: '2026-10-13', compatibility_flags: ['nodejs_compat'],
    alias: {'node:util': resolve(root, 'src/safe-node-util.ts')}, workers_dev: true, preview_urls: false, keep_vars: true,
    assets: {directory: resolve(root, 'public'), binding: 'ASSETS', run_worker_first: ['/*', '!/styles.css', '!/admin.css', '!/admin.js', '!/checkout.js', '!/landing.js']},
    vars: {
      PAY_BASE_URL: new URL(input.cloudflare.baseUrl).origin, PAYMENT_MODE: 'live', PAYMENT_ENABLED: 'false',
      ALIPAY_CHANNELS: input.providerMode === 'wechat' ? '' : Array.isArray(input.alipay.channels) ? input.alipay.channels.join(',') : input.alipay.channels || 'page,wap', WECHAT_CHANNELS: input.providerMode === 'alipay' ? '' : 'native',
      GITHUB_APP_ID: input.github.appId, GITHUB_APP_INSTALLATION_ID: input.github.installationId,
      GITHUB_REPOSITORY: input.github.repository, GITHUB_BRANCH: input.github.branch || 'main', REGISTRY_STORAGE_MODE: 'plain', CLIENTS_JSON: '[]',
      ...(input.alipay ? {ALIPAY_APP_ID: input.alipay.appId, ...(input.alipay.gateway ? {ALIPAY_GATEWAY: input.alipay.gateway} : {})} : {}),
      ...(input.wechat ? {WECHAT_MCH_ID: input.wechat.merchantId, WECHAT_APP_ID: input.wechat.appId, WECHAT_PUBLIC_KEY_ID: input.wechat.publicKeyId} : {}),
    },
    triggers: {crons: ['* * * * *']},
    ratelimits: [
      {name: 'ADMIN_LOGIN_LIMITER', namespace_id: String(randomBytes(4).readUInt32BE()), simple: {limit: 5, period: 60}},
      {name: 'INTEGRATION_LIMITER', namespace_id: String(randomBytes(4).readUInt32BE()), simple: {limit: 30, period: 60}},
      {name: 'PAYMENT_API_LIMITER', namespace_id: String(randomBytes(4).readUInt32BE()), simple: {limit: 120, period: 60}},
    ], observability: {enabled: false},
  };
}

/** Offline only: read explicitly supplied files, generate service credentials once, and freeze the review artifacts. */
export async function prepareSetup(input, options = {}) {
  validateSetupInput(input);
  const root = await realpath(resolve(options.root || ROOT)), base = resolve(options.inputDirectory || root);
  const read = path => fileText(resolve(base, path));
  const password = input.admin.passwordFile ? (await read(input.admin.passwordFile)).replace(/\r?\n$/, '') : randomBytes(24).toString('base64url');
  if (password.length < 12 || password.length > 1024) fail('ADMIN_PASSWORD_MUST_BE_12_TO_1024_CHARACTERS');
  const pepper = randomSecret(), salt = randomSecret();
  const material = createHmac('sha256', pepper).update(password, 'utf8').digest('hex');
  const secrets = {
    GITHUB_APP_PRIVATE_KEY: rsaKey(await read(input.github.privateKeyFile), true),
    CHECKOUT_SECRET: randomSecret(), ADMIN_EMAIL: input.admin.email.trim().toLowerCase(),
    ADMIN_PASSWORD_HASH: `pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(material, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex')}`,
    ADMIN_PASSWORD_PEPPER: pepper, ADMIN_SESSION_SECRET: randomSecret(),
  };
  if (input.alipay) Object.assign(secrets, {ALIPAY_PRIVATE_KEY: rsaKey(await read(input.alipay.privateKeyFile), true), ALIPAY_PUBLIC_KEY: rsaKey(await read(input.alipay.publicKeyFile), false), ALIPAY_SELLER_ID: input.alipay.sellerId});
  if (input.wechat) {
    const apiKey = (await read(input.wechat.apiV3KeyFile)).trim();
    if (Buffer.byteLength(apiKey) !== 32) fail('WECHAT_API_V3_KEY_MUST_BE_32_BYTES');
    Object.assign(secrets, {WECHAT_PRIVATE_KEY: rsaKey(await read(input.wechat.privateKeyFile), true), WECHAT_SERIAL_NO: input.wechat.serialNo, WECHAT_API_V3_KEY: apiKey, WECHAT_PUBLIC_KEYS_JSON: JSON.stringify({[input.wechat.publicKeyId]: rsaKey(await read(input.wechat.publicKeyFile), false)})});
  }
  const config = newWorkerConfig(input, root);
  let guide = JSON.parse(await fileText(resolve(ROOT, 'resources/environment-guide.json')));
  // A fork gets explanatory metadata for its target rather than references to this project's production account.
  const replacements = [[PRODUCTION.worker, input.cloudflare.workerName], [PRODUCTION.repository, input.github.repository], ['5411175', input.github.appId], ['pay.bornforthis.cn', new URL(config.vars.PAY_BASE_URL).hostname], ['paywc.bornforthis.cn', new URL(config.vars.PAY_BASE_URL).hostname]];
  const replace = value => typeof value === 'string' ? replacements.reduce((text, [from, to]) => text.split(from).join(to), value) : Array.isArray(value) ? value.map(replace) : plain(value) ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, replace(entry)])) : value;
  guide = replace(guide);
  guide.intro = [
    `此服务由 ${input.cloudflare.workerName} 提供。公开配置使用服务端 Text 变量，商户私钥、GitHub App 私钥及管理员凭据使用服务端 Secret；不要将凭据填入本说明文档。`,
    '本说明保存变量名称、用途、生成方法与占位示例。实际运行值保留在自己的 Cloudflare 账户中，登录自己的后台后可逐项查看当前 Worker 生效值；首次配置文件只保存在本地忽略目录 secrets/。',
    `说明文档独立保存于私有数据仓库 ${input.github.repository} 的 ${GUIDE_PATH}。首次部署创建缺少的说明，不覆盖已有说明或业务数据。`,
    '首次部署保持 PAYMENT_ENABLED=false。完成商户身份、通知签名、订单金额和产品幂等交付验收后，再由维护者启用收款。',
  ];
  const maintenance = {
    PAY_BASE_URL: `此服务地址为 ${config.vars.PAY_BASE_URL}。更换前先准备新域名及商户回调；旧链接仍依赖原地址。`,
    PAYMENT_MODE: '首次安装使用 live。支付宝沙箱应部署独立测试服务，微信 Native 不支持沙箱。',
    ALIPAY_CHANNELS: config.vars.ALIPAY_CHANNELS ? `当前选择 ${config.vars.ALIPAY_CHANNELS}。仅启用已签约的支付宝产品。` : '此安装未启用支付宝新收款。',
    WECHAT_CHANNELS: config.vars.WECHAT_CHANNELS ? '当前选择 native。其他微信支付方式需先实现相应接口。' : '此安装未启用微信新收款。',
    GITHUB_APP_ID: `在自己账号或组织的 GitHub App 设置页核对 App ID ${input.github.appId}。`,
    GITHUB_REPOSITORY: `数据仓库为 ${input.github.repository}。保持私有；App 仅选择该仓库，安装令牌只请求该仓库的 Contents 读写。`,
  };
  for (const group of guide.groups) for (const variable of group.variables) {
    if (PUBLIC_NAMES.has(variable.name) || SECRET_NAMES.has(variable.name)) variable.location = `Cloudflare → Workers & Pages → ${config.name} → Settings → Variables and Secrets，类型选择 ${SECRET_NAMES.has(variable.name) ? 'Secret' : 'Text'}`;
    if (maintenance[variable.name]) variable.maintenance = maintenance[variable.name];
    if (variable.name === 'GITHUB_APP_ID') variable.generation = '在自己的账号或组织创建 GitHub App，从设置页获取 App ID；配置 Contents 读写、Metadata 只读，并仅安装到自己的私有数据仓库。';
    if (variable.name === 'GITHUB_REPOSITORY') variable.generation = '在自己的账号或组织创建私有数据仓库，初始化目标分支；安装 GitHub App 时只选择该仓库，然后填写 owner/repository。';
  }
  guide.notes = [
    '所有订单、事件、平台、授权、计划与审计独立存储在自己的私有 GitHub 数据仓库中，格式为明文 JSON。不要在开源代码仓库保存业务数据。',
    '首次部署保持收款关闭。完成渠道签约、商户验签、订单金额与通知回调检查后，再完成真实支付和产品幂等交付验收。',
    '保留本地部署目录中的服务签名材料，不要重新生成来进行日常代码发布。启用或停用渠道不迁移历史订单，也不改变已有订单的 provider。',
    '说明文档不包含实际凭据。通过自己的后台维护文档；原项目的 sync-environment-guide.mjs 仅面向原生产私仓，独立安装不要运行它。',
    '私密值默认隐藏，仅已登录管理员可逐项查看当前 Worker 运行值，临时产品接入授权无此权限。隐藏、离开维护页或退出登录会清除本页已查看值；不将实际值写入说明、公开资源或浏览器持久存储。',
  ];
  validateEnvironmentGuide(guide);
  const files = {
    'wrangler.json': json(config), 'worker-secrets.json': json(secrets),
    'admin-login.json': json({email: secrets.ADMIN_EMAIL, ...(input.admin.passwordFile ? {passwordSource: 'supplied passwordFile; original password not copied'} : {password})}),
    'environment-guide.json': json(guide),
  };
  if (input.cloudflare.pagesProjectName) {
    files['pages/wrangler.json'] = json({$schema: resolve(root, 'node_modules/wrangler/config-schema.json'), name: input.cloudflare.pagesProjectName, pages_build_output_dir: './public', compatibility_date: config.compatibility_date, services: [{binding: 'PAYMENT_BACKEND', service: config.name}]});
    files['pages/public/_worker.js'] = await fileText(resolve(ROOT, 'cloudflare/pages/_worker.js'));
    files['pages/public/_routes.json'] = await fileText(resolve(ROOT, 'cloudflare/pages/_routes.json'));
  }
  const output = await outputDirectory(options.output || 'secrets/setup-generated', root, true);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(resolve(output, name)), {recursive: true, mode: 0o700});
    await writeFile(resolve(output, name), content, {flag: 'wx', mode: 0o600});
  }
  const plan = {schema: 1, createdAt: new Date().toISOString(), providerMode: input.providerMode, accountId: config.account_id, workerName: config.name,
    baseUrl: config.vars.PAY_BASE_URL, repository: input.github.repository, branch: config.vars.GITHUB_BRANCH,
    pagesProjectName: input.cloudflare.pagesProjectName || null, paymentEnabled: false,
    publicBindingNames: Object.keys(config.vars).sort(), secretBindingNames: Object.keys(secrets).sort(),
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha(content)]))};
  await writeFile(resolve(output, 'deployment-plan.json'), json(plan), {flag: 'wx', mode: 0o600});
  return {output, plan};
}

export async function readPreparedSetup(path, options = {}) {
  const root = await realpath(resolve(options.root || ROOT)), output = await outputDirectory(path, root, false);
  const plan = JSON.parse(await fileText(resolve(output, 'deployment-plan.json')));
  if (!plain(plan) || plan.schema !== 1 || plan.paymentEnabled !== false || !plain(plan.files)) fail('INVALID_DEPLOYMENT_PLAN');
  const expected = ['wrangler.json', 'worker-secrets.json', 'admin-login.json', 'environment-guide.json', ...(plan.pagesProjectName ? ['pages/wrangler.json', 'pages/public/_worker.js', 'pages/public/_routes.json'] : [])].sort();
  if (Object.keys(plan.files).sort().join('\n') !== expected.join('\n')) fail('INVALID_PLAN_FILE_LIST');
  const files = {};
  for (const name of expected) {
    files[name] = await fileText(resolve(output, name));
    if (sha(files[name]) !== plan.files[name]) fail('REVIEWED_SETUP_CHANGED_NO_DEPLOY');
  }
  const config = JSON.parse(files['wrangler.json']), secrets = JSON.parse(files['worker-secrets.json']);
  if (!plain(config.vars) || !plain(secrets) || Object.keys(config.vars).some(name => !PUBLIC_NAMES.has(name)) || Object.keys(secrets).some(name => !SECRET_NAMES.has(name))
    || config.vars.PAYMENT_ENABLED !== 'false' || config.vars.REGISTRY_STORAGE_MODE !== 'plain' || config.vars.CLIENTS_JSON !== '[]'
    || config.name !== plan.workerName || config.account_id !== plan.accountId || config.vars.GITHUB_REPOSITORY !== plan.repository || config.vars.GITHUB_BRANCH !== plan.branch
    || config.main !== resolve(root, 'src/index.ts') || config.assets?.directory !== resolve(root, 'public') || config.alias?.['node:util'] !== resolve(root, 'src/safe-node-util.ts')
    || config.account_id === PRODUCTION.account || config.name === PRODUCTION.worker || plan.repository?.toLowerCase() === PRODUCTION.repository.toLowerCase()
    || config.routes || config.d1_databases || config.kv_namespaces || config.r2_buckets || config.durable_objects || config.services) fail('UNSAFE_FIRST_INSTALL_CONFIGURATION');
  validateEnvironmentGuide(JSON.parse(files['environment-guide.json']));
  return {output, plan, config, secrets, files};
}

/** GitHub App JWT and repository-restricted installation token never leave memory. */
export async function authorizeSetupRepository(config, secrets, options = {}) {
  const fetcher = options.fetcher || fetch;
  const request = async (path, token, method = 'GET', body, allowMissing = false) => {
    let response;
    try {response = await fetcher('https://api.github.com' + path, {method, headers: {authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'Brclio-Pay-Setup', 'x-github-api-version': '2022-11-28'}, ...(body ? {body: JSON.stringify(body)} : {}), redirect: 'manual', signal: AbortSignal.timeout(15_000)});} catch {fail('GITHUB_AUTHORIZATION_NETWORK_ERROR');}
    if (allowMissing && response.status === 404) {await response.body?.cancel();return null;}
    if (!response.ok) {await response.body?.cancel();fail('GITHUB_AUTHORIZATION_HTTP_' + response.status);}
    if (response.status === 204) return {};
    try {return await response.json();} catch {fail('GITHUB_INVALID_AUTHORIZATION_RESPONSE');}
  };
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({alg: 'RS256', typ: 'JWT'}) + '.' + encode({iat: now - 60, exp: now + 540, iss: config.vars.GITHUB_APP_ID});
  let jwt;
  try {jwt = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), createPrivateKey(secrets.GITHUB_APP_PRIVATE_KEY)).toString('base64url');} catch {fail('GITHUB_APP_PRIVATE_KEY_INVALID');}
  const repository = config.vars.GITHUB_REPOSITORY;
  const installation = await request('/repos/' + repository + '/installation', jwt);
  if (String(installation.id) !== config.vars.GITHUB_APP_INSTALLATION_ID || String(installation.app_id) !== config.vars.GITHUB_APP_ID || installation.permissions?.contents !== 'write' || installation.repository_selection !== 'selected' || installation.suspended_at) fail('GITHUB_APP_REQUIRES_SELECTED_PRIVATE_REPOSITORY_CONTENTS_WRITE');
  const issued = await request('/app/installations/' + config.vars.GITHUB_APP_INSTALLATION_ID + '/access_tokens', jwt, 'POST', {repositories: [repository.split('/')[1]], permissions: {contents: 'write'}});
  if (typeof issued.token !== 'string' || !issued.token || issued.permissions?.contents !== 'write' || Date.parse(issued.expires_at) <= Date.now() + 60_000 || !Number.isFinite(Date.parse(issued.expires_at))) fail('INVALID_SCOPED_GITHUB_INSTALLATION_TOKEN');
  const token = issued.token;
  const revoke = () => request('/installation/token', token, 'DELETE');
  try {
    const repo = await request('/repos/' + repository, token);
    if (repo.private !== true || repo.full_name?.toLowerCase() !== repository.toLowerCase()) fail('GITHUB_DATA_REPOSITORY_MUST_BE_PRIVATE');
    const branch = await request('/repos/' + repository + '/branches/' + encodeURIComponent(config.vars.GITHUB_BRANCH), token);
    if (!/^[a-f0-9]{40}$/.test(branch.commit?.sha || '')) fail('GITHUB_DATA_BRANCH_MUST_ALREADY_BE_INITIALIZED');
    return {request: (path, method, body, allowMissing) => request(path, token, method, body, allowMissing), revoke};
  } catch (error) {await revoke().catch(() => {});throw error;}
}

export async function initializeSetupGuide(github, prepared) {
  const path = '/repos/' + prepared.plan.repository + '/contents/' + GUIDE_PATH;
  const existing = await github.request(path + '?ref=' + encodeURIComponent(prepared.plan.branch), 'GET', undefined, true);
  if (existing) return {operation: 'preserved', path: GUIDE_PATH};
  const created = await github.request(path, 'PUT', {message: 'Initialize environment maintenance guide', branch: prepared.plan.branch, content: Buffer.from(prepared.files['environment-guide.json']).toString('base64')});
  if (!/^[a-f0-9]{40}$/.test(created.content?.sha || '')) fail('GITHUB_GUIDE_INITIALIZATION_UNCONFIRMED');
  return {operation: 'created', path: GUIDE_PATH};
}

function runWrangler(args, prepared, options = {}) {
  const root = resolve(options.root || ROOT);
  const result = (options.spawn || spawnSync)(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
    cwd: root, env: {...process.env, CLOUDFLARE_ACCOUNT_ID: prepared.plan.accountId, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve(prepared.output, 'wrangler.log')}, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  try {chmodSync(resolve(prepared.output, 'wrangler.log'), 0o600);} catch { /* Wrangler may not create a log. */ }
  // Never forward child-process output, which can include configuration or authorization diagnostics.
  return {ok: !result.error && result.status === 0, output: (result.stdout || '') + '\n' + (result.stderr || '')};
}

export async function deployPreparedSetup(prepared, options = {}) {
  if (options.pages && !prepared.plan.pagesProjectName) fail('PAGES_PROJECT_NAME_REQUIRED_IN_REVIEWED_INPUT');
  const configPath = resolve(prepared.output, 'wrangler.json');
  if (!runWrangler(['whoami', '--json', '--account', prepared.plan.accountId, '--config', configPath], prepared, options).ok) fail('CLOUDFLARE_AUTHORIZATION_REQUIRED_RUN_WRANGLER_LOGIN');
  const existing = runWrangler(['versions', 'list', '--json', '--config', configPath], prepared, options);
  const receiptPath = resolve(prepared.output, 'deployment-receipt.json');
  let receipt;
  try {receipt = JSON.parse(await fileText(receiptPath));} catch {receipt = null;}
  // The first install must not rotate an existing Worker's merchant/service secrets.
  if (existing.ok && (!receipt || receipt.workerName !== prepared.plan.workerName || receipt.planDigest !== sha(json(prepared.plan)))) fail('WORKER_ALREADY_EXISTS_USE_MAINTENANCE_DEPLOYMENT');
  if (!existing.ok && !/\b(?:code:\s*|"code"\s*:\s*)10007\b/.test(existing.output)) fail('CLOUDFLARE_WORKER_ABSENCE_NOT_CONFIRMED');
  const github = await authorizeSetupRepository(prepared.config, prepared.secrets, options);
  let guide;
  try {guide = await initializeSetupGuide(github, prepared);} finally {await github.revoke().catch(() => {});}
  const deployment = runWrangler(['deploy', '--config', configPath, '--secrets-file', resolve(prepared.output, 'worker-secrets.json')], prepared, options);
  if (!deployment.ok) fail('WORKER_DEPLOYMENT_FAILED_VALUES_WITHHELD');
  const version = /Current Version ID:\s*([a-f0-9-]{36})/.exec(deployment.output)?.[1] || null;
  receipt = {workerName: prepared.plan.workerName, accountId: prepared.plan.accountId, planDigest: sha(json(prepared.plan)), deployedAt: new Date().toISOString(), version, guide, paymentEnabled: false, pages: receipt?.pages || false, pagesProjectCreated: receipt?.pagesProjectCreated || false, domainVerified: false, realPaymentVerified: false, fulfillmentVerified: false};
  await writeFile(receiptPath, json(receipt), {mode: 0o600});
  if (options.pages) {
    const pagesDirectory = resolve(prepared.output, 'pages');
    // Wrangler finds the generated service-binding config through --cwd, independent of production config.
    const created = runWrangler(['pages', 'project', 'create', prepared.plan.pagesProjectName, '--production-branch', 'main', '--cwd', pagesDirectory], prepared, options);
    if (!created.ok && !(receipt.pagesProjectCreated && /already exists|already being used/i.test(created.output))) fail('PAGES_PROJECT_CREATION_FAILED_OR_ALREADY_EXISTS');
    receipt.pagesProjectCreated = true;
    await writeFile(receiptPath, json(receipt), {mode: 0o600});
    const pages = runWrangler(['pages', 'deploy', resolve(pagesDirectory, 'public'), '--project-name', prepared.plan.pagesProjectName, '--branch', 'main', '--commit-dirty=true', '--cwd', pagesDirectory], prepared, options);
    if (!pages.ok) fail('PAGES_GATEWAY_DEPLOYMENT_FAILED');
    receipt.pages = true;
    await writeFile(receiptPath, json(receipt), {mode: 0o600});
  }
  return receipt;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseSetupArguments(argv);
  if (options.help) {
    console.log('Prepare offline: npm run setup:deployment -- --input secrets/setup-input.json [--output secrets/setup-generated]\nDeploy reviewed files: npm run setup:deployment -- --deploy --output secrets/setup-generated [--pages]\nInput example: examples/deployment/setup-input.example.json. File paths resolve relative to the input file.\nNo credentials are printed. Existing output files and production targets are never overwritten; PAYMENT_ENABLED remains false.\nDeployment requires Cloudflare login/API authorization and an installed GitHub App scoped to your initialized private data repository. DNS is configured separately.');
    return;
  }
  if (options.input) {
    const inputPath = resolve(ROOT, options.input);
    const result = await prepareSetup(JSON.parse(await fileText(inputPath)), {...options, inputDirectory: dirname(inputPath)});
    console.log(JSON.stringify({prepared: true, output: relative(ROOT, result.output), workerName: result.plan.workerName, providerMode: result.plan.providerMode, paymentEnabled: false, publicBindingNames: result.plan.publicBindingNames, secretBindingNames: result.plan.secretBindingNames, next: 'Review local files, then use --deploy --output with the same directory. Credentials remain local; no deployment has occurred.'}));
  } else {
    const prepared = await readPreparedSetup(options.output);
    const receipt = await deployPreparedSetup(prepared, options);
    console.log(JSON.stringify(receipt));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {console.error(JSON.stringify({error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SETUP_FAILED_VALUES_WITHHELD'}));process.exitCode = 1;});
}
