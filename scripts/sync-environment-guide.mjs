#!/usr/bin/env node
/** Publish explanatory metadata only. Default is read-only; never copy runtime values. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, installationGithub, TARGET_REPOSITORY } from './migrate-data.mjs';

export const GUIDE_PATH = 'maintenance/environment/guide.json';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'main';
const textFields = ['name', 'label', 'description', 'example', 'location', 'changeNotes', 'maintenance'];
const knownVariables = new Set([
  'PAY_BASE_URL', 'PAYMENT_MODE', 'PAYMENT_ENABLED', 'CHECKOUT_SECRET',
  'ALIPAY_APP_ID', 'ALIPAY_CHANNELS', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY', 'ALIPAY_SELLER_ID', 'ALIPAY_GATEWAY',
  'WECHAT_MCH_ID', 'WECHAT_APP_ID', 'WECHAT_CHANNELS', 'WECHAT_SERIAL_NO', 'WECHAT_PRIVATE_KEY', 'WECHAT_API_V3_KEY', 'WECHAT_PUBLIC_KEYS_JSON', 'WECHAT_PUBLIC_KEY_ID',
  'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_REPOSITORY', 'GITHUB_BRANCH', 'REGISTRY_STORAGE_MODE', 'CLIENTS_JSON',
  'ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD_PEPPER', 'ADMIN_SESSION_SECRET',
  'LEGACY_WECHAT_BASE_URL', 'LEGACY_WECHAT_CHECKOUT_SECRET',
  'GITHUB_TOKEN', 'REGISTRY_ENCRYPTION_KEY',
  'ASSETS', 'ADMIN_LOGIN_LIMITER', 'INTEGRATION_LIMITER', 'PAYMENT_API_LIMITER',
]);
const fail = code => { throw new Error(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textList = value => Array.isArray(value) && value.length > 0 && value.length <= 30 && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 3000);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

export function validateEnvironmentGuide(value, { requireComplete = true } = {}) {
  if (!plain(value) || value.schema !== 1 || typeof value.title !== 'string' || !value.title || value.title.length > 160
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || !textList(value.intro) || !textList(value.notes) || !Array.isArray(value.groups) || !value.groups.length || value.groups.length > 20
    || Object.keys(value).some(key => !['schema', 'title', 'updatedAt', 'intro', 'groups', 'notes'].includes(key))) fail('INVALID_ENVIRONMENT_GUIDE');
  const names = new Set(), groupIds = new Set();
  for (const group of value.groups) {
    if (!plain(group) || !/^[a-z][a-z0-9-]{0,63}$/.test(group.id) || groupIds.has(group.id)
      || typeof group.title !== 'string' || !group.title || group.title.length > 160
      || typeof group.description !== 'string' || !group.description || group.description.length > 3000
      || !Array.isArray(group.variables) || !group.variables.length || group.variables.length > 40
      || Object.keys(group).some(key => !['id', 'title', 'description', 'variables'].includes(key))) fail('INVALID_ENVIRONMENT_GUIDE_GROUP');
    groupIds.add(group.id);
    for (const variable of group.variables) {
      if (!plain(variable) || !knownVariables.has(variable.name) || names.has(variable.name)
        || textFields.some(key => typeof variable[key] !== 'string' || !variable[key] || variable[key].length > 3000)
        || typeof variable.required !== 'boolean' || typeof variable.sensitive !== 'boolean'
        || ['generation', 'scope'].some(key => variable[key] !== undefined && (typeof variable[key] !== 'string' || !variable[key] || variable[key].length > 3000))
        || Object.keys(variable).some(key => ![...textFields, 'required', 'sensitive', 'generation', 'scope'].includes(key))) fail('INVALID_ENVIRONMENT_GUIDE_VARIABLE');
      // PEM bodies and runtime credentials do not belong in explanatory metadata.
      if (/-----BEGIN [A-Z ]+-----\s*[A-Za-z0-9+/]{48}/.test(variable.example)
        || /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/.test(variable.example)
        || ['ALIPAY_PRIVATE_KEY', 'WECHAT_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY', 'WECHAT_API_V3_KEY', 'CHECKOUT_SECRET', 'LEGACY_WECHAT_CHECKOUT_SECRET', 'ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD_PEPPER', 'ADMIN_SESSION_SECRET'].includes(variable.name) && !variable.example.includes('<')) fail('RUNTIME_VALUE_NOT_ALLOWED_IN_GUIDE');
      names.add(variable.name);
    }
  }
  if (requireComplete && (names.size !== knownVariables.size || [...knownVariables].some(name => !names.has(name)))) fail('ENVIRONMENT_GUIDE_VARIABLES_INCOMPLETE');
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) fail('ENVIRONMENT_GUIDE_TOO_LARGE');
  return value;
}

/** An immutable parent plus a non-forced ref update rejects concurrent writers. */
export async function synchronizeEnvironmentGuide(github, guide, options = {}) {
  validateEnvironmentGuide(guide);
  const documentDigest = digest(guide);
  const snapshot = await github.snapshot(TARGET_REPOSITORY, BRANCH);
  const existing = snapshot.files.find(file => file.path === GUIDE_PATH);
  let current;
  if (existing) {
    // Earlier schema-1 guides lack newly documented legacy fields. They remain
    // reviewable without bypassing revision/digest protections on replacement.
    try { current = validateEnvironmentGuide(JSON.parse((await github.bytes(TARGET_REPOSITORY, existing)).toString('utf8')), { requireComplete: false }); }
    catch { fail('EXISTING_GUIDE_INVALID_REQUIRES_REVIEW'); }
  }
  const identical = !!current && canonical(current) === canonical(guide);
  const report = { repository: TARGET_REPOSITORY, branch: BRANCH, path: GUIDE_PATH, operation: identical ? 'unchanged' : existing ? 'update' : 'create', documentDigest, expectedHead: snapshot.revision, remoteBlobSha: existing?.sha || null, variableCount: knownVariables.size, applied: false };
  if (!options.apply || identical) return report;
  if (!/^[a-f0-9]{40}$/.test(options.expectedHead || '') || options.expectedHead !== snapshot.revision) fail('EXPECTED_HEAD_MISMATCH_NO_WRITE');
  if (!/^[a-f0-9]{64}$/.test(options.expectedDigest || '') || options.expectedDigest !== documentDigest) fail('EXPECTED_DOCUMENT_MISMATCH_NO_WRITE');
  if (existing && (!options.update || options.expectedRemoteSha !== existing.sha)) fail('EXISTING_GUIDE_REQUIRES_UPDATE_AND_EXPECTED_SHA');
  if (!existing && (options.update || options.expectedRemoteSha)) fail('GUIDE_DOES_NOT_EXIST_NO_WRITE');
  if (current && Date.parse(guide.updatedAt) <= Date.parse(current.updatedAt)) fail('UPDATED_AT_MUST_ADVANCE_NO_WRITE');
  // Metadata only: one fixed path in one fixed private repository.
  const blob = await github.request(`/repos/${TARGET_REPOSITORY}/git/blobs`, 'POST', { content: JSON.stringify(guide, null, 2) + '\n', encoding: 'utf-8' });
  const tree = await github.request(`/repos/${TARGET_REPOSITORY}/git/trees`, 'POST', { base_tree: snapshot.tree, tree: [{ path: GUIDE_PATH, mode: '100644', type: 'blob', sha: blob.sha }] });
  const commit = await github.request(`/repos/${TARGET_REPOSITORY}/git/commits`, 'POST', { message: 'Document payment Worker environment maintenance', tree: tree.sha, parents: [snapshot.revision] });
  if (await github.revision(TARGET_REPOSITORY, BRANCH) !== snapshot.revision) fail('DATA_BRANCH_CHANGED_NO_REF_WRITE');
  // GitHub rejects this if the branch advances between the fresh read and PATCH.
  await github.request(`/repos/${TARGET_REPOSITORY}/git/refs/heads/${BRANCH}`, 'PATCH', { sha: commit.sha, force: false });
  const verified = await github.snapshot(TARGET_REPOSITORY, BRANCH);
  const written = verified.files.find(file => file.path === GUIDE_PATH);
  if (!written || digest(JSON.parse((await github.bytes(TARGET_REPOSITORY, written)).toString('utf8'))) !== documentDigest) fail('GUIDE_POST_WRITE_VERIFICATION_FAILED');
  return { ...report, applied: true, commit: commit.sha, verifiedRevision: verified.revision };
}

function parseArguments(argv) {
  const options = {};
  const flags = new Map([['--expected-head', 'expectedHead'], ['--expected-document', 'expectedDigest'], ['--expected-remote-sha', 'expectedRemoteSha']]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--dry-run') options.apply = false;
    else if (argv[i] === '--update') options.update = true;
    else if (argv[i] === '--help') options.help = true;
    else if (flags.has(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[flags.get(argv[i])] = argv[++i];
    else fail('INVALID_ARGUMENT');
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log('Usage: node scripts/sync-environment-guide.mjs [--dry-run]\nApply reviewed output: --apply --expected-head HEAD_SHA --expected-document DOCUMENT_SHA256\nReplacing an existing document additionally requires --update --expected-remote-sha REMOTE_BLOB_SHA and a later updatedAt.\nWrites only explanatory metadata at BrclioData/BrclioPay-Data:maintenance/environment/guide.json. No runtime values are copied.');
    return;
  }
  const guide = validateEnvironmentGuide(JSON.parse(await readFile(resolve(ROOT, 'resources/environment-guide.json'), 'utf8')));
  const { github } = await installationGithub();
  console.log(JSON.stringify(await synchronizeEnvironmentGuide(github, guide, options)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}
