import { readFile, realpath, open, constants } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const redact = value => Array.isArray(value) ? value.map(redact) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /secret|token|password|private.?key/i.test(key) ? '[REDACTED]' : redact(item)])) : value;

async function writeCredentials(destination, data) {
  const credentials = data.credentials;
  const clientId = data.clientId ?? data.client?.id ?? data.config?.id;
  if (typeof clientId !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(clientId)
    || typeof credentials?.apiSecret !== 'string' || typeof credentials?.webhookSecret !== 'string'
    || !/^[A-Za-z0-9_-]{32,512}$/.test(credentials.apiSecret) || !/^[A-Za-z0-9_-]{32,512}$/.test(credentials.webhookSecret)) throw new Error('Target credentials unavailable');
  const parent = await realpath(path.dirname(path.resolve(destination)));
  const filename = path.join(parent, path.basename(destination));
  try { execFileSync('git', ['check-ignore', '-q', '--', filename], { cwd: parent, stdio: 'ignore' }); }
  catch { throw new Error('Credential file must be untracked and Git-ignored'); }
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { await file.writeFile(`BRCLIO_PAY_CLIENT_ID=${clientId}\nBRCLIO_PAY_API_SECRET=${credentials.apiSecret}\nBRCLIO_PAY_WEBHOOK_SECRET=${credentials.webhookSecret}\n`); }
  finally { await file.close(); }
}

export async function runIntegrationClient({ argv, env = process.env, fetcher = fetch, output = value => process.stdout.write(value + '\n') }) {
  const [action, ...rest] = argv;
  let credentialsFile;
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--credentials-file') {
      if (credentialsFile || !rest[i + 1]) throw new Error('Invalid credential destination');
      credentialsFile = rest[++i];
    } else if (rest[i].startsWith('--')) throw new Error('Unknown option');
    else positionals.push(rest[i]);
  }
  if (!['context', 'plan', 'apply'].includes(action) || positionals.length !== (action === 'context' ? 0 : 1)
    || (credentialsFile && action === 'plan')) throw new Error('Usage: context [--credentials-file PATH] | plan PLAN.json | apply PLAN_ID [--credentials-file PATH]');
  const token = env.BRCLIO_PAY_INTEGRATION_TOKEN;
  if (typeof token !== 'string' || !/^brp_int_[A-Za-z0-9_-]{20,2000}$/.test(token)) throw new Error('Scoped integration token required in environment');
  const base = new URL(env.BRCLIO_PAY_BASE_URL || 'https://pay.bornforthis.cn');
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('HTTPS payment origin required');
  let payload;
  if (action === 'plan') {
    const raw = await readFile(positionals[0], 'utf8');
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('Plan file too large');
    payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.config || typeof payload.expectedVersion !== 'string'
      || /"(?:apiSecret|webhookSecret|token|password|privateKey)"\s*:/i.test(raw)) throw new Error('Plan must contain config and expectedVersion without credentials');
  } else if (action === 'apply') {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(positionals[0])) throw new Error('Invalid plan ID');
    payload = { planId: positionals[0] };
  }
  const response = await fetcher(new URL(`/api/integration/v1/${action}`, base), {
    method: action === 'context' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Integration API HTTP ${response.status}; refresh scoped context or request renewed authorization`); }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('Integration response too large');
  const data = JSON.parse(raw);
  if (credentialsFile) await writeCredentials(credentialsFile, data);
  output(JSON.stringify(redact(data), null, 2));
  return { credentialsWritten: !!credentialsFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runIntegrationClient({ argv: process.argv.slice(2) }); }
  catch (error) {
    // Provider error bodies and thrown network messages may include authenticated requests.
    const safe = error instanceof Error && /^(Usage:|Invalid credential|Unknown option|Scoped integration|HTTPS payment|Plan |Invalid plan|Integration API HTTP|Integration response|Target credentials|Credential file)/.test(error.message)
      ? error.message : 'Integration command failed; no credentials were printed.';
    process.stderr.write(safe + '\n'); process.exitCode = 1;
  }
}
