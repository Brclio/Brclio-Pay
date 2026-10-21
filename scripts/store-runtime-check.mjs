import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const content = '{"status":"PAID"}\n';
let unexpected = 0;
let githubWrites = 0;
let authenticatedReads = 0;
let signedWebhookRequests = 0;
let signedExampleRequests = 0;
let runtime;
try {
  const compiled = await build({ absWorkingDir: root, entryPoints: ['tests/store-runtime-worker.ts'],
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], logLevel: 'silent' });
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: compiled.outputFiles[0].text,
    compatibilityDate: '2026-10-13', compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0,
    log: new Log(LogLevel.NONE), handleStructuredLogs: () => {},
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'api.github.com') {
        if (request.method !== 'GET') githubWrites++;
        if (request.method === 'GET' && request.headers.get('authorization') === 'Bearer fixture-token'
          && request.headers.get('user-agent') === 'Brclio-Pay/0.1') authenticatedReads++;
        if (['/repos/fixture/private','/repos/fixture/existing','/repos/fixture/snapshot'].includes(url.pathname)) return Response.json({ private: true });
        if(url.pathname==='/repos/fixture/snapshot/git/ref/heads/main')return Response.json({ref:'refs/heads/main',object:{type:'commit',sha:'1'.repeat(40)}});
        if(url.pathname==='/repos/fixture/snapshot/git/commits/'+'1'.repeat(40))return Response.json({tree:{sha:'2'.repeat(40)}});
        if(url.pathname==='/repos/fixture/snapshot/git/trees/'+'2'.repeat(40))return Response.json({truncated:false,tree:[{path:'orders/pay_native.json',type:'blob',mode:'100644',sha:createHash('sha1').update(content).digest('hex'),size:Buffer.byteLength(content)}]});
        if(url.pathname==='/repos/fixture/snapshot/git/blobs/'+createHash('sha1').update(content).digest('hex'))return Response.json({encoding:'base64',content:Buffer.from(content).toString('base64'),size:Buffer.byteLength(content),sha:createHash('sha1').update(content).digest('hex')});
        if (url.pathname === '/repos/fixture/redirect') return new Response(null, { status: 302, headers: { Location: 'https://never-follow.runtime.invalid/' } });
        if (url.pathname === '/repos/fixture/private/contents/system/clients.enc.json') return new Response('{}', { status: 404 });
        if (url.pathname === '/repos/fixture/existing/contents/orders/pay_native.json') return Response.json({
          type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'),
          size: Buffer.byteLength(content), sha: createHash('sha1').update(content).digest('hex'),
        });
      }
      if (request.method === 'POST' && ['product.runtime.invalid', 'redirect.runtime.invalid'].includes(url.hostname)) {
        if (/^[a-f0-9]{64}$/.test(request.headers.get('x-brclio-signature') ?? '')) signedWebhookRequests++;
        if (url.hostname === 'product.runtime.invalid') return new Response('ok');
        return new Response(null, { status: 302, headers: { Location: 'https://never-follow.runtime.invalid/' } });
      }
      if (['pay.runtime.invalid', 'pay-redirect.runtime.invalid'].includes(url.hostname)) {
        const body = await request.text();
        const canonical = [request.method, url.pathname, request.headers.get('x-brclio-timestamp'), request.headers.get('x-brclio-nonce'), createHash('sha256').update(body).digest('hex')].join('\n');
        const expected = createHmac('sha256', 'fixture-api-'.repeat(4)).update(canonical).digest('hex');
        if (request.headers.get('x-brclio-signature') === expected) signedExampleRequests++;
        if (url.hostname === 'pay-redirect.runtime.invalid') return Response.json({ error: { message: 'Fixture redirect rejected' } }, { status: 302, headers: { Location: 'https://never-follow.runtime.invalid/' } });
        return Response.json({ id: `pay_${'1'.repeat(32)}`, status: url.pathname.endsWith('/refresh') ? 'PAID' : 'PENDING' });
      }
      unexpected++;
      return new Response(null, { status: 599 });
    },
  }));
  const response = await runtime.dispatchFetch('http://store-runtime.test/', { method: 'POST' });
  assert.equal(response.status, 200);
  const checks = await response.json();
  for (const passed of Object.values(checks)) assert.equal(passed, true);
  assert.equal(unexpected, 0);
  assert.equal(githubWrites, 0);
  assert.equal(authenticatedReads, 10);
  assert.equal(signedWebhookRequests, 2);
  assert.equal(signedExampleRequests, 4);
  console.log(JSON.stringify({ networkWorkerd: true, ...checks, redirectsNeverFollowed: true, githubReadOnly: true, authenticationHeadersSent: true, exampleRequestSignaturesVerified: true }));
} catch (error) {
  console.error(JSON.stringify({ networkWorkerd: false, errorType: error?.name ?? 'Error' }));
  process.exitCode = 1;
} finally {
  try { await runtime?.dispose(); } catch { process.exitCode = 1; }
}
