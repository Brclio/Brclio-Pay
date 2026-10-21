import { readdir, readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ignored = new Set(['.git', '.codex', '.agents', 'node_modules', 'vendor', 'dist', 'dist-pages', 'build', 'out', 'artifacts',
  '.next', '.nuxt', '.output', '.svelte-kit', '.vercel', '.wrangler', '.turbo', '.cache', 'coverage', '.venv', 'venv']);
const sensitive = name => /^\.env(?:\.|$)/i.test(name) || /(?:secret|credential|password|private[-_]?key|token)/i.test(name)
  || /\.(?:pem|key|p12|pfx|crt|keystore|sqlite|db|log)$/i.test(name);
const source = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|php|rb|vue|svelte|json|md|mdx|ya?ml|toml|sql|prisma)$/i;
const providers = { alipay: /alipay|支付宝/i, stripe: /stripe/i, paddle: /paddle/i, lemonsqueezy: /lemon.?squeezy/i, wechat: /wechat.?pay|weixin.?pay|微信支付/i, paypal: /paypal/i };
const capabilities = { authentication: /auth|session|login|登录/i, orders: /order|checkout|订单/i, entitlements: /entitlement|subscription|license|membership|权益/i, webhook: /webhook|callback|notify|回调/i };
const catalogPath = /catalog|plan|pricing|price|product|sku|billing|subscription|membership|套餐|价格/i;
const catalogIdentifier = /\b(?:skus?|products?|plans?|packages?|tiers?|product_?id|plan_?(?:id|code))\b|套餐|商品编号/i;
const catalogAmount = /\b(?:amount|prices?|cents|unit_?amount|monthly_?price|yearly_?price)\b|价格|金额|售价/i;
const catalogEntitlement = /\b(?:entitlements?|credits?|quota|duration|validity|expiry|expires|features?|interval|period|days?|months?|years?|limits?)\b|权益|有效期|额度|次数/i;
const catalogCurrency = /\b(?:currency|cny|rmb|usd|eur|gbp|hkd)\b|人民币|美元|港币|欧元|[¥￥$]/i;
const nonBusinessCatalog = /(?:^|\/)(?:__tests__|tests?|fixtures?|examples?|artifacts|mocks?)(?:\/|\.)|(?:^|\/)(?:package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock)$/i;

function catalogKind(filename) {
  if (/\.(?:sql|prisma)$/i.test(filename) || /(?:^|\/)(?:schema|migrations?)(?:\/|\.)/i.test(filename)) return 'data-schema';
  if (/\.(?:md|mdx)$/i.test(filename)) return 'documentation';
  if (/\.(?:vue|svelte|tsx|jsx)$/i.test(filename) || /(?:^|\/)(?:components?|pages?|views?|ui)(?:\/|\.)/i.test(filename)) return 'display';
  if (/\.(?:json|ya?ml|toml)$/i.test(filename) || /(?:^|\/)(?:server|api|config|catalog|lib)(?:\/|\.)/i.test(filename)) return 'server-config';
  return 'source';
}

// Locations are hints for the AI to read, never extracted prices or authoritative claims.
function locateCatalog(filename, content) {
  if (nonBusinessCatalog.test(filename)) return [];
  const lines = content.split(/\r?\n/);
  const locations = [];
  for (let index = 0; index < lines.length; index++) {
    if (!catalogAmount.test(lines[index])) continue;
    const nearby = lines.slice(Math.max(0, index - 4), index + 5).join('\n');
    if (!catalogPath.test(filename) && !catalogIdentifier.test(nearby)) continue;
    const signals = ['amount'];
    if (catalogIdentifier.test(nearby)) signals.push('catalog');
    if (catalogEntitlement.test(nearby)) signals.push('entitlement');
    if (catalogCurrency.test(nearby)) signals.push('currency');
    locations.push({ path: filename, line: index + 1, kind: catalogKind(filename), signals });
  }
  return locations;
}

export async function inspectPlatform(directory) {
  const root = await realpath(directory);
  const files = [];
  let skippedSensitive = 0;
  let truncated = false;
  async function walk(current, depth) {
    if (depth > 16 || files.length >= 5000) { truncated = true; return; }
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      if (sensitive(entry.name)) { skippedSensitive++; continue; }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else if (entry.isFile() && source.test(entry.name)) {
        if (files.length >= 5000) { truncated = true; break; }
        files.push({ absolute, relative: path.relative(root, absolute).split(path.sep).join('/') });
      }
    }
  }
  await walk(root, 0);
  const matches = [];
  const catalogCandidates = [];
  let catalogTruncated = false;
  let packageDependencies = [];
  for (const file of files) {
    if ((await lstat(file.absolute)).size > 256 * 1024) continue;
    const content = await readFile(file.absolute, 'utf8');
    const candidates = locateCatalog(file.relative, content);
    if (catalogCandidates.length + candidates.length > 200) catalogTruncated = true;
    catalogCandidates.push(...candidates);
    const priority = { 'server-config': 0, 'data-schema': 1, documentation: 2, display: 3, source: 4 };
    catalogCandidates.sort((a, b) => priority[a.kind] - priority[b.kind] || a.path.localeCompare(b.path) || a.line - b.line);
    catalogCandidates.length = Math.min(200, catalogCandidates.length);
    const foundProviders = Object.entries(providers).filter(([, pattern]) => pattern.test(content)).map(([name]) => name);
    const foundCapabilities = Object.entries(capabilities).filter(([, pattern]) => pattern.test(file.relative)).map(([name]) => name);
    if (foundProviders.length || foundCapabilities.length) matches.push({ path: file.relative, providers: foundProviders, capabilities: foundCapabilities });
    if (file.relative === 'package.json') {
      try {
        const pkg = JSON.parse(content);
        packageDependencies = [...new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})])].sort();
      } catch { /* Inventory must not print malformed file contents. */ }
    }
  }
  return { filesScanned: files.length, skippedSensitive, truncated, packageDependencies, matches, catalogCandidates, catalogTruncated };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error();
    process.stdout.write(JSON.stringify(await inspectPlatform(process.argv[2]), null, 2) + '\n');
  } catch { process.stderr.write('Unable to inspect repository. Supply one readable product repository path.\n'); process.exitCode = 1; }
}
