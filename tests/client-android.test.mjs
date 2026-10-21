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
  const sandbox = { location: { origin }, navigator: {}, document: { addEventListener: (name, listener) => events.set(name, listener) },
    setTimeout, clearTimeout, Date, Map, JSON, Promise, Uint8Array, URL, btoa, Blob,
    fetch: async () => ({ blob: async () => new Blob(['order,amount\r\n1,3.00'], { type: 'text/csv;charset=utf-8' }) }), alert: value => errors.push(value) };
  sandbox.window = { BrclioPayNative: { postMessage: text => {
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
  state.events.get('click')({ isTrusted: false, target: { closest: () => ({ href: 'blob:https://pay.bornforthis.cn/csv-export', download: 'brclio-pay.csv' }) },
    preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  for (let i = 0; i < 30 && !state.messages.some(item => item.action === 'exportFinish'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(prevented, true); assert.deepEqual(state.errors, []);
  assert.deepEqual(state.messages.map(item => item.action), ['exportStart', 'exportChunk', 'exportFinish']);
  assert.equal(state.messages[0].mime, 'text/csv'); assert.equal(state.messages[1].sequence, 0);
  assert.equal(Buffer.from(state.messages[1].data, 'base64').toString(), 'order,amount\r\n1,3.00');
});
test('Only trusted clicks open external HTTPS links', () => {
  const state = context(); const click = state.events.get('click');
  const event = { target: { closest: () => ({ href: 'https://github.com/Brclio/Brclio-Pay' }) }, preventDefault() {}, stopImmediatePropagation() {} };
  click({ ...event, isTrusted: false }); assert.equal(state.messages.length, 0);
  click({ ...event, isTrusted: true }); assert.equal(state.messages[0].action, 'external');
});
