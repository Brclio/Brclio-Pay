import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SQLiteStore, sqliteDocumentDigest, sqliteArchiveDigest} from '../server/sqlite-store';
import {PartitionedStore} from '../src/partitioned-store';

const stores: SQLiteStore[] = [];
const directories: string[] = [];
function store(filename = ':memory:'): SQLiteStore {
  const created = new SQLiteStore(filename); stores.push(created); return created;
}
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brclio-sqlite-test-')); directories.push(dir); return join(dir, 'payment.sqlite');
}
afterEach(() => {
  for (const item of stores.splice(0)) item.close();
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('server-local SQLite storage', () => {
  it('commits dated payment, event, locators and queue together, then persists across restart', async () => {
    const path = file(), physical = store(path), logical = new PartitionedStore(physical);
    const id = 'pay_' + 'a'.repeat(32), eventId = 'evt_' + id;
    await logical.transaction(async tx => {
      tx.put(`orders/${id}.json`, {id, createdAt: '2026-10-31T17:00:00Z', amount: '1.00', status: 'PAID'});
      tx.put(`events/${eventId}.json`, {event: {id: eventId, createdAt: '2026-10-31T17:00:00Z'}, attempts: 0});
      tx.put('system/queue.json', {orders: [], deliveries: [eventId]});
      expect(await tx.read(`orders/${id}.json`)).toMatchObject({amount: '1.00'});
    });
    const revision = (await physical.openSnapshot()).revision;
    physical.close();
    const reopened = store(path);
    expect((statSync(path).mode & 0o777)).toBe(0o600);
    expect((await reopened.openSnapshot()).revision).toBe(revision);
    expect(await reopened.readJson(`orders/2026/11/${id}.json`)).toMatchObject({status: 'PAID'});
    expect(await new PartitionedStore(reopened).readJson(`events/${eventId}.json`)).toMatchObject({attempts: 0});
    expect(reopened.integrityCheck()).toBe(true);
  });

  it('rolls back all staged writes and resumes the queue after callback failure', async () => {
    const db = store();
    const before = (await db.openSnapshot()).revision;
    await expect(db.transaction(async tx => {
      tx.put('orders/one.json', {status: 'PAID'});
      await Promise.resolve();
      tx.put('events/one.json', {attempts: 0});
      throw new Error('fixture failure');
    })).rejects.toThrow('fixture failure');
    expect((await db.openSnapshot()).revision).toBe(before);
    expect(await db.readJson('orders/one.json')).toBeNull();
    expect(await db.readJson('events/one.json')).toBeNull();
    await db.transaction(async tx => {tx.put('orders/two.json', {status: 'PENDING'});});
    expect(await db.readJson('orders/two.json')).toEqual({status: 'PENDING'});
  });

  it('serializes competing callbacks on one connection without losing increments', async () => {
    const db = store();
    await db.transaction(async tx => {tx.put('system/counter.json', {count: 0});});
    await Promise.all(Array.from({length: 30}, () => db.transaction(async tx => {
      const value = await tx.read<{count: number}>('system/counter.json');
      await Promise.resolve();
      tx.put('system/counter.json', {count: value!.count + 1});
    })));
    expect(await db.readJson('system/counter.json')).toEqual({count: 30});
  });

  it('retries a stale snapshot after another connection commits while the callback awaits', async () => {
    const path = file(), a = store(path), b = store(path);
    await a.transaction(async tx => {tx.put('system/counter.json', {count: 0});});
    let callbacks = 0;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const started = new Promise<void>(resolve => {entered = resolve;});
    const incrementA = a.transaction(async tx => {
      callbacks++;
      const value = await tx.read<{count: number}>('system/counter.json');
      if (callbacks === 1) {entered(); await gate;}
      tx.put('system/counter.json', {count: value!.count + 1});
    });
    await started;
    await b.transaction(async tx => {
      const value = await tx.read<{count: number}>('system/counter.json');
      tx.put('system/counter.json', {count: value!.count + 1});
    });
    release(); await incrementA;
    expect(callbacks).toBe(2);
    expect(await a.readJson('system/counter.json')).toEqual({count: 2});
  });

  it('keeps an immutable snapshot and returns independent JSON objects', async () => {
    const db = store();
    await db.transaction(async tx => {tx.put('orders/one.json', {status: 'PENDING', nested: {value: 1}});});
    const old = await db.openSnapshot();
    const value = await old.readJson<{nested: {value: number}}>('orders/one.json'); value!.nested.value = 8;
    await db.transaction(async tx => {tx.put('orders/one.json', {status: 'PAID'}); tx.put('orders/two.json', {});});
    expect(await old.readJson('orders/one.json')).toEqual({status: 'PENDING', nested: {value: 1}});
    expect(old.listJsonPaths('orders/')).toEqual(['orders/one.json']);
    expect((await db.openSnapshot()).listJsonPaths('orders/')).toEqual(['orders/one.json', 'orders/two.json']);
    expect(() => old.listJsonPaths('../')).toThrow(TypeError);
  });

  it('preserves exact imported bytes, source revision and runtime configuration in one durable import', () => {
    const path = file(), db = store(path);
    const documents = [{path: 'orders/2026/11/fixture.json', content: '{\n  "amount": "2.00", "id": "fixture", "timestamp": "2026-11-19T01:00:00Z"\n}\n'}];
    const runtimeConfig = {PAYMENT_MODE: 'live', CHECKOUT_SECRET: 'synthetic-fixture-only', ALIPAY_PRIVATE_KEY: 'synthetic\nkey'};
    db.importDocuments(documents, {sourceRevision: 'a'.repeat(40), runtimeConfig, expectedDigest: sqliteDocumentDigest(documents)});
    const exported = db.exportSnapshot();
    expect(exported.sourceRevision).toBe('a'.repeat(40));
    expect(exported.documents[0].content).toBe(documents[0].content);
    expect(exported.documentDigest).toBe(sqliteDocumentDigest(documents));
    db.close();
    expect(store(path).readRuntimeConfig()).toEqual(runtimeConfig);
  });

  it('requires reviewed revisions for replacement and rejects a changed source digest without mutations', () => {
    const db = store();
    db.importDocuments([{path: 'old/one.json', content: '{"value":1}'}], {sourceRevision: 'first'});
    const before = db.exportSnapshot();
    const replacement = [{path: 'new/one.json', content: '{"value":2}'}];
    expect(() => db.importDocuments(replacement, {sourceRevision: 'second', replace: true})).toThrow('expected revision');
    expect(() => db.importDocuments(replacement, {sourceRevision: 'second', replace: true, expectedRevision: 'sqlite:0'})).toThrowError(expect.objectContaining({code: 'STORAGE_CONFLICT'}));
    expect(() => db.importDocuments(replacement, {sourceRevision: 'second', expectedRevision: before.revision, expectedDigest: '0'.repeat(64)})).toThrow('digest');
    expect(db.exportSnapshot()).toEqual(before);
    db.importDocuments(replacement, {sourceRevision: 'second', replace: true, expectedRevision: before.revision});
    expect(db.exportSnapshot().documents.map(entry => entry.path)).toEqual(['new/one.json']);
  });

  it('archives arbitrary repository bytes and migration provenance without exposing archives as payment JSON', async () => {
    const db = store();
    const archives = [{path: '历史/README.md', content: Uint8Array.from([0, 255, 254, 13, 10])}, {path: '.gitkeep', content: new Uint8Array()}];
    const sourceMetadata = {schema: 1, repository: 'fixture/private', revision: 'fixture-revision', planDigest: 'a'.repeat(64)};
    db.importDocuments([{path: 'system/queue.json', content: '{"orders":[],"deliveries":[]}\n'}], {
      sourceRevision: 'fixture-revision', sourceMetadata, archives, expectedArchiveDigest: sqliteArchiveDigest(archives), runtimeConfig: {PAYMENT_ENABLED: 'false'},
    });
    const exported = db.exportSnapshot();
    expect(exported.sourceMetadata).toEqual(sourceMetadata);
    expect(exported.archiveDigest).toBe(sqliteArchiveDigest(archives));
    expect(exported.archives.find(entry => entry.path === archives[0].path)?.content).toEqual(archives[0].content);
    expect((await db.openSnapshot()).listJsonPaths('system/')).toEqual(['system/queue.json']);
    expect(() => db.importDocuments([], {
      sourceRevision: 'fixture-revision', expectedRevision: exported.revision, archives: [{path: '../escape', content: new Uint8Array()}], runtimeConfig: {PAYMENT_ENABLED: 'true'},
    })).toThrow('safe relative');
    expect(db.exportSnapshot()).toEqual(exported);
  });

  it('allows one logical payment creation under concurrent repeated idempotency keys', async () => {
    const path = file(), a = store(path), b = store(path);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const started = new Promise<void>(resolve => {entered = resolve;});
    let first = true;
    const requestA = a.transaction(async tx => {
      const existing = await tx.read('indexes/client/key.json');
      if (existing) return 'existing';
      if (first) {first = false; entered(); await gate;}
      tx.put('orders/one.json', {amount: '1.00'}); tx.put('indexes/client/key.json', {id: 'one'}); tx.put('events/one.json', {attempts: 0});
      return 'created';
    });
    await started;
    const requestB = await b.transaction(async tx => {
      expect(await tx.read('orders/one.json')).toBeNull();
      tx.put('orders/one.json', {amount: '1.00'}); tx.put('indexes/client/key.json', {id: 'one'}); tx.put('events/one.json', {attempts: 0});
      return 'created';
    });
    release();
    expect([await requestA, requestB]).toEqual(['existing', 'created']);
    expect(a.exportSnapshot().documents).toHaveLength(3);
  });

  it('rejects unsafe paths, duplicate imports, invalid JSON and invalid runtime config without leaking values', async () => {
    const db = store();
    for (const path of ['../secret.json', '/secret.json', 'a//b.json', 'a/../b.json', 'a.txt']) {
      await expect(db.readJson(path)).rejects.toThrow(TypeError);
    }
    await expect(db.transaction(async tx => {tx.put('orders/one.json', {number: Infinity});})).rejects.toThrow(TypeError);
    await expect(db.transaction(async tx => {tx.put('orders/one.json', {number: undefined});})).rejects.toThrow(TypeError);
    expect(() => db.importDocuments([{path: 'test/one.json', content: 'fixture-secret-not-json'}], {sourceRevision: 'test'})).toThrow('not valid JSON');
    expect(() => db.importDocuments([{path: 'test/one.json', content: '{}'}, {path: 'test/one.json', content: '{}'}], {sourceRevision: 'test'})).toThrow('duplicate');
    expect(() => db.replaceRuntimeConfig({BAD: 123 as unknown as string})).toThrow('invalid variable');
    expect(db.exportSnapshot().documents).toEqual([]);
  });

  it('does not allow an escaped transaction handle to change a completed commit', async () => {
    const db = store(); let escaped!: Parameters<Parameters<SQLiteStore['transaction']>[0]>[0];
    await db.transaction(async tx => {escaped = tx; tx.put('orders/one.json', {status: 'PAID'});});
    expect(() => escaped.put('orders/two.json', {})).toThrow('completed');
    await expect(escaped.read('orders/one.json')).rejects.toThrow('completed');
  });
});
