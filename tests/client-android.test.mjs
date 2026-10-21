import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const test = process.env.VITEST ? (await import('vitest')).test : (await import('node:test')).default;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(path.join(root, 'clients/android/app/src/main/assets/native-actions.js'), 'utf8');
function context(origin = 'https://pay.bornforthis.cn', mainFrame = true) {
  const messages = [], events = new Map(), errors = [];
  let objectSequence = 0;
  class FixtureURL extends URL {
    static createObjectURL() { return `blob:${origin}/fixture-${++objectSequence}`; }
    static revokeObjectURL() {}
  }
  const sandbox = { location: { origin }, navigator: {}, document: { addEventListener: (name, listener) => events.set(name, listener) },
    setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; }, clearTimeout, Date, Map, JSON, Promise, Uint8Array, URL: FixtureURL, btoa, Blob,
    fetch: async () => { throw new Error('Production CSP blocks blob fetch'); }, alert: value => errors.push(value) };
  sandbox.window = { addEventListener: (name, listener) => events.set(name, listener), BrclioPayNative: { postMessage: text => {
    const message = JSON.parse(text); messages.push(message);
    queueMicrotask(() => sandbox.window.BrclioPayNative.onmessage({ data: JSON.stringify({ id: message.id, ok: true }) }));
  } } };
  sandbox.window.top = mainFrame ? sandbox.window : {};
  vm.runInNewContext(script, sandbox);
  return { sandbox, messages, events, errors };
}
test('Android native hooks are absent outside the exact trusted main frame', () => {
  for (const config of [['https://evil.test', true], ['https://pay.bornforthis.cn.evil.test', true], ['https://pay.bornforthis.cn', false]]) {
    const state = context(...config); assert.equal(state.sandbox.navigator.clipboard, undefined); assert.equal(state.events.size, 0);
  }
});
test('Clipboard writes use an acknowledged native message without exposing other native authority', async () => {
  const state = context(); await state.sandbox.navigator.clipboard.writeText('temporary scoped AI task');
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].action, 'copyText');
  assert.equal(state.messages[0].text, 'temporary scoped AI task');
  assert.deepEqual(Object.keys(state.sandbox.navigator.clipboard), ['writeText']);
});
test('CSV blob anchors export through ordered bounded chunks and acknowledge completion', async () => {
  const state = context(); let prevented = false;
  const href = state.sandbox.URL.createObjectURL(new Blob(['order,amount\r\n1,3.00'], { type: 'text/csv;charset=utf-8' }));
  state.events.get('click')({ isTrusted: false, target: { closest: () => ({ href, download: 'brclio-pay.csv' }) },
    preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  for (let i = 0; i < 30 && !state.messages.some(item => item.action === 'exportFinish'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(prevented, true); assert.deepEqual(state.errors, []);
  assert.deepEqual(state.messages.map(item => item.action), ['exportStart', 'exportChunk', 'exportFinish']);
  assert.equal(state.messages[0].mime, 'text/csv'); assert.equal(state.messages[1].sequence, 0);
  assert.equal(Buffer.from(state.messages[1].data, 'base64').toString(), 'order,amount\r\n1,3.00');
});
test('Revoked, evicted and page-hidden blobs cannot retain or export order files', async () => {
  const state = context(); const csv = () => new Blob(['data'], { type: 'text/csv' });
  const revoked = state.sandbox.URL.createObjectURL(csv()); state.sandbox.URL.revokeObjectURL(revoked);
  const evicted = state.sandbox.URL.createObjectURL(csv()); for (let i = 0; i < 8; i++) state.sandbox.URL.createObjectURL(csv());
  const hidden = state.sandbox.URL.createObjectURL(csv()); state.events.get('pagehide')();
  for (const href of [revoked, evicted, hidden]) {
    state.events.get('click')({ target: { closest: () => ({ href, download: 'data.csv' }) }, preventDefault() {}, stopImmediatePropagation() {} });
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state.messages.length, 0); assert.equal(state.errors.length, 3);
});
test('Aggregate retained Blob bytes are bounded even below the object count limit', async () => {
  const state = context(); const data = new Uint8Array(12 * 1024 * 1024);
  const first = state.sandbox.URL.createObjectURL(new Blob([data], { type: 'text/csv' }));
  state.sandbox.URL.createObjectURL(new Blob([data], { type: 'text/csv' }));
  state.sandbox.URL.createObjectURL(new Blob([data], { type: 'text/csv' }));
  state.events.get('click')({ target: { closest: () => ({ href: first, download: 'data.csv' }) }, preventDefault() {}, stopImmediatePropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(state.messages.length, 0); assert.equal(state.errors.length, 1);
  state.events.get('pagehide')();
});
test('Only trusted clicks open external HTTPS links', () => {
  const state = context(); const click = state.events.get('click');
  const event = { target: { closest: () => ({ href: 'https://github.com/Brclio/Brclio-Pay' }) }, preventDefault() {}, stopImmediatePropagation() {} };
  click({ ...event, isTrusted: false }); assert.equal(state.messages.length, 0);
  click({ ...event, isTrusted: true }); assert.equal(state.messages[0].action, 'external');
});
