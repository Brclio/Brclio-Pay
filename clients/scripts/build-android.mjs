import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const android = path.join(root, 'clients/android');
const windows = process.platform === 'win32';
const args = new Set(process.argv.slice(2));
for (const arg of args) assert.ok(['--check', '--debug'].includes(arg) || /^--seed-version-(name|code)=/.test(arg), 'Unknown Android build option');
const settings = JSON.parse(readFileSync(path.join(root, 'clients/shared/release-settings.json'), 'utf8'));
const release = !args.has('--debug');
const seedOption = name => [...args].filter(arg => arg.startsWith(`--seed-version-${name}=`));
assert.ok(seedOption('name').length <= 1 && seedOption('code').length <= 1, 'Duplicate seed version options');
const seedName = seedOption('name')[0]?.split('=')[1], seedCode = seedOption('code')[0]?.split('=')[1];
const verificationSeed = Boolean(seedName || seedCode);
assert.ok(!verificationSeed || seedName && seedCode && release, 'A verification seed requires both name/code and a release signing identity');
const buildVersion = seedName || settings.version;
assert.match(buildVersion, /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/);
const parts = buildVersion.split('.').map(Number);
const versionCode = seedCode ? Number(seedCode) : parts[0] * 1000000 + parts[1] * 1000 + parts[2];
assert.ok(Number.isSafeInteger(versionCode) && versionCode > 0 && versionCode <= 2100000000, 'Invalid Android version code');
if (verificationSeed) assert.ok(versionCode < settings.version.split('.').map(Number).reduce((value, part, index) => value + part * [1000000, 1000, 1][index], 0), 'Verification seed must be older than the public release');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
assert.ok(sdk && existsSync(path.join(sdk, 'platforms/android-35/android.jar')), 'Set ANDROID_HOME to an SDK containing API 35');
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', windows ? 'java.exe' : 'java') : 'java';
function run(command, parameters, options = {}) {
  const result = spawnSync(command, parameters, { cwd: root, encoding: 'utf8', env: process.env, maxBuffer: 24 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error('Android tool verification/build failed: ' + (result.error?.message || result.stderr || result.stdout || result.status));
  return result.stdout;
}
run(java, ['-version'], { stdio: 'pipe' });
assert.ok(existsSync(path.join(process.env.JAVA_HOME || '', 'bin', windows ? 'javac.exe' : 'javac')), 'Set JAVA_HOME to a full JDK 17 or 21');
const buildTool = name => path.join(sdk, 'build-tools/35.0.0', name + (windows ? name === 'apksigner' ? '.bat' : '.exe' : ''));
for (const name of ['aapt', 'apksigner', 'zipalign']) assert.ok(existsSync(buildTool(name)), 'Missing Android build-tools 35.0.0');
const wrapperSha = createHash('sha256').update(readFileSync(path.join(android, 'gradle/wrapper/gradle-wrapper.jar'))).digest('hex');
assert.equal(wrapperSha, '2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046', 'Gradle wrapper verification failed');
if (args.has('--check')) { console.log('Android JDK/SDK/Gradle wrapper verified'); process.exit(0); }
if (release) for (const name of ['ANDROID_SIGNING_STORE_FILE', 'ANDROID_SIGNING_STORE_PASSWORD', 'ANDROID_SIGNING_KEY_ALIAS', 'ANDROID_SIGNING_KEY_PASSWORD'])
  assert.ok(process.env[name], `Release signing requires ${name}`);
const variant = release ? 'Release' : 'Debug';
const sourceRevision = run('git', ['rev-parse', 'HEAD']).trim();
const sourceDirty = Boolean(run('git', ['status', '--porcelain']).trim());
const seedProperties = verificationSeed ? [`-PclientVersionName=${buildVersion}`, `-PclientVersionCode=${versionCode}`] : [];
run(windows ? 'gradlew.bat' : './gradlew', [':app:test' + variant + 'UnitTest', ':app:lint' + variant, ':app:assemble' + variant, '--no-daemon', '--console=plain', ...seedProperties], { cwd: android, stdio: 'inherit', shell: windows });
const apk = path.join(android, 'app/build/outputs/apk', release ? 'release/app-release.apk' : 'debug/app-debug.apk');
assert.ok(existsSync(apk), 'Android APK build output missing');
const signature = run(buildTool('apksigner'), ['verify', '--verbose', '--print-certs', apk], { shell: windows });
const certs = [...signature.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f\d]{64})\r?$/gim)];
assert.equal(certs.length, 1, 'APK must have exactly one signing identity');
assert.ok(!release || !/certificate DN:.*CN=Android Debug/i.test(signature), 'Release APK cannot use the Android Debug signing identity');
const badging = run(buildTool('aapt'), ['dump', 'badging', apk]);
const identity = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
assert.ok(identity, 'APK identity missing');
assert.equal(identity[1], settings.applicationId + (release ? '' : '.debug'));
assert.equal(Number(identity[2]), versionCode); assert.equal(identity[3], buildVersion + (release ? '' : '-debug'));
assert.match(badging, /^sdkVersion:'26'$/m); assert.match(badging, /^targetSdkVersion:'35'$/m);
const output = path.join(root, 'dist-clients'); mkdirSync(output, { recursive: true });
const name = `Brclio-Pay-${buildVersion}-android-universal${release ? '' : '-debug'}.apk`;
const bytes = readFileSync(apk); const sha256 = createHash('sha256').update(bytes).digest('hex');
copyFileSync(apk, path.join(output, name));
writeFileSync(path.join(output, name + '.sha256'), `${sha256}  ${name}\n`);
assert.equal(run('git', ['rev-parse', 'HEAD']).trim(), sourceRevision, 'Source revision changed while Android was building; rebuild from the final commit');
const proof = { schema: 1, platform: 'android', version: buildVersion, versionCode, verificationSeed,
  sourceRevision, sourceDirty, builtAt: new Date().toISOString(), release, applicationId: identity[1], minSdk: 26, targetSdk: 35,
  unitTests: true, lint: true, signatureVerified: true, signingCertificateSha256: certs[0][1].toLowerCase(),
  artifact: { name, bytes: bytes.length, sha256 }, installedVerified: false, upgradeVerified: false };
writeFileSync(path.join(output, verificationSeed ? 'android-seed-build-proof.json' : 'android-build-proof.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ androidBuild: 'passed', release, artifact: name, bytes: bytes.length, sha256, installedVerified: false, upgradeVerified: false }));
