import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ConflictError, GitHubError, GitHubStore } from '../src/store';

const hash = (content: string) => createHash('sha1').update(content).digest('hex');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

/** Git object fixtures preserve immutable trees/commits while the head advances. */
class FakeGitHub {
  privateRepo = true;
  truncated = false;
  forceConflicts = false;
  blobMode = '100644';
  contentOverride?: Record<string, unknown>;
  calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  blobs = new Map<string, string>();
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, { tree: string; parents: string[] }>();
  head: string;
  successfulUpdates = 0;
  conflicts = 0;

  constructor(seed: Record<string, unknown> = {}) {
    const files = new Map<string, string>();
    for (const [path, value] of Object.entries(seed)) files.set(path, this.blob(`${JSON.stringify(value)}\n`));
    const tree = this.tree(files);
    this.head = hash(`initial:${tree}`);
    this.commits.set(this.head, { tree, parents: [] });
  }
  blob(content: string): string {
    const sha = hash(content);
    this.blobs.set(sha, content);
    return sha;
  }
  tree(files: Map<string, string>): string {
    const sha = hash(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b))));
    this.trees.set(sha, files);
    return sha;
  }
  blobResponse(sha: string): Record<string, unknown> {
    const content = this.blobs.get(sha)!;
    return { sha, encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') };
  }
  value<T>(path: string): T | null {
    const commit = this.commits.get(this.head)!;
    const sha = this.trees.get(commit.tree)!.get(path);
    return sha ? JSON.parse(this.blobs.get(sha)!) as T : null;
  }
  fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/repos/owner/private-data', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    this.calls.push({ path, method, body });
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token');
    if (!path) return json({ private: this.privateRepo });
    if (path === '/git/ref/heads/main') return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: this.head } });
    if (path.startsWith('/git/commits/') && method === 'GET') {
      const commit = this.commits.get(path.slice('/git/commits/'.length))!;
      return json({ tree: { sha: commit.tree } });
    }
    if (path.startsWith('/git/trees/') && method === 'GET') {
      const files = this.trees.get(path.slice('/git/trees/'.length))!;
      return json({ truncated: this.truncated, tree: [...files].map(([file, sha]) => ({ path: file, type: 'blob', mode: this.blobMode, sha, size: Buffer.byteLength(this.blobs.get(sha)!) })) });
    }
    if (path.startsWith('/git/blobs/')) return json(this.blobResponse(path.slice('/git/blobs/'.length)));
    if (path.startsWith('/contents/')) {
      expect(url.searchParams.get('ref')).toBe('main');
      if (this.contentOverride) return json(this.contentOverride);
      const sha = this.trees.get(this.commits.get(this.head)!.tree)!.get(path.slice('/contents/'.length));
      return sha ? json({ type: 'file', ...this.blobResponse(sha) }) : json({}, 404);
    }
    if (path === '/git/trees' && method === 'POST') {
      const files = new Map(this.trees.get(String(body.base_tree))!);
      for (const entry of body.tree as { path: string; mode: string; type: string; content: string }[]) {
        expect(entry.mode).toBe('100644');
        expect(entry.type).toBe('blob');
        files.set(entry.path, this.blob(entry.content));
      }
      return json({ sha: this.tree(files) }, 201);
    }
    if (path === '/git/commits' && method === 'POST') {
      const tree = String(body.tree);
      const parents = body.parents as string[];
      const sha = hash(JSON.stringify({ tree, parents, message: body.message }));
      this.commits.set(sha, { tree, parents });
      return json({ sha }, 201);
    }
    if (path === '/git/refs/heads/main' && method === 'PATCH') {
      expect(body.force).toBe(false);
      const sha = String(body.sha);
      const candidate = this.commits.get(sha)!;
      if (this.forceConflicts || (sha !== this.head && candidate.parents[0] !== this.head)) {
        this.conflicts++;
        return json({ message: 'Reference update failed' }, 422);
      }
      this.head = sha;
      this.successfulUpdates++;
      return json({ object: { sha } });
    }
    throw new Error(`Unexpected fixture route: ${method} ${path}`);
  }) as typeof fetch;
  store() { return new GitHubStore({ token: 'fixture-token', repository: 'owner/private-data', fetch: this.fetch }); }
}

describe('private GitHub payment storage', () => {
  it('provides bounded immutable listings and blob reads even after the branch advances', async () => {
    const github = new FakeGitHub({ 'orders/pay_one.json': { status: 'PENDING' }, 'system/private.json': { secret: 'fixture' } });
    const store = github.store();
    const snapshot = await store.openSnapshot();
    expect(snapshot.listJsonPaths('orders/')).toEqual(['orders/pay_one.json']);
    const oldRevision = snapshot.revision;
    await store.transaction(async tx => {
      tx.put('orders/pay_one.json', { status: 'PAID' });
      tx.put('orders/pay_two.json', { status: 'PENDING' });
    });
    expect(await snapshot.readJson('orders/pay_one.json')).toEqual({ status: 'PENDING' });
    expect(snapshot.listJsonPaths('orders/')).toEqual(['orders/pay_one.json']);
    const fresh = await store.openSnapshot();
    expect(fresh.revision).not.toBe(oldRevision);
    expect(fresh.listJsonPaths('orders/')).toEqual(['orders/pay_one.json', 'orders/pay_two.json']);
    expect(await fresh.readJson('orders/pay_one.json')).toEqual({ status: 'PAID' });
    expect(() => fresh.listJsonPaths('../')).toThrow(TypeError);
    expect(() => fresh.listJsonPaths('orders')).toThrow(TypeError);
    github.truncated = true;
    await expect(store.openSnapshot()).rejects.toMatchObject({ code: 'TRUNCATED_GIT_TREE' });
  });

  it('refuses oversized report listings instead of silently truncating history', async () => {
    const github = new FakeGitHub(Object.fromEntries(Array.from({ length: 20_001 }, (_, n) => [`orders/pay_${String(n).padStart(5, '0')}.json`, {}])));
    const snapshot = await github.store().openSnapshot();
    expect(() => snapshot.listJsonPaths('orders/')).toThrow(expect.objectContaining({ code: 'REPORTING_CAPACITY' }));
  });

  it('atomically commits order, idempotency index, and work queue in one branch update', async () => {
    const github = new FakeGitHub();
    const result = await github.store().transaction(async tx => {
      expect(await tx.read('orders/pay_one.json')).toBeNull();
      tx.put('orders/pay_one.json', { status: 'PENDING', subject: '中文 + %' });
      tx.put('indexes/client/abc.json', { id: 'pay_one' });
      tx.put('system/queue.json', { orders: ['pay_one'], deliveries: [] });
      expect(await tx.read('orders/pay_one.json')).toEqual({ status: 'PENDING', subject: '中文 + %' });
      return 'created';
    });
    expect(result).toBe('created');
    expect(github.value('orders/pay_one.json')).toMatchObject({ status: 'PENDING' });
    expect(github.value('indexes/client/abc.json')).toEqual({ id: 'pay_one' });
    expect(github.value('system/queue.json')).toEqual({ orders: ['pay_one'], deliveries: [] });
    expect(github.successfulUpdates).toBe(1);
  });

  it('re-reads immutable state and retries competing writers without losing an update', async () => {
    const github = new FakeGitHub({ 'system/counter.json': { count: 0 } });
    const store = github.store();
    let callbacks = 0;
    const increment = () => store.transaction(async tx => {
      callbacks++;
      const counter = await tx.read<{ count: number }>('system/counter.json');
      tx.put('system/counter.json', { count: counter!.count + 1 });
      return counter!.count + 1;
    });
    const values = await Promise.all([increment(), increment()]);
    expect(values.sort()).toEqual([1, 2]);
    expect(github.value('system/counter.json')).toEqual({ count: 2 });
    expect(callbacks).toBe(3);
    expect(github.conflicts).toBe(1);
    expect(github.successfulUpdates).toBe(2);
    expect(github.calls.filter(call => call.path === '').length).toBe(1);
    expect(github.calls.some(call => call.path.startsWith('/git/blobs/'))).toBe(true);
    expect(github.calls.some(call => call.path.startsWith('/contents/'))).toBe(false);
  });

  it('bounds conflicting commit retries and never forces the ref', async () => {
    const github = new FakeGitHub();
    github.forceConflicts = true;
    await expect(github.store().transaction(async tx => tx.put('system/queue.json', {}))).rejects.toBeInstanceOf(ConflictError);
    expect(github.conflicts).toBe(5);
    expect(github.successfulUpdates).toBe(0);
  });

  it('checks privacy once then reads a standalone JSON file with one contents request', async () => {
    const github = new FakeGitHub({ 'orders/pay_one.json': { status: 'PAID' } });
    const store = github.store();
    expect(await store.readJson('orders/pay_one.json')).toEqual({ status: 'PAID' });
    expect(await store.readJson('orders/missing.json')).toBeNull();
    expect(github.calls.map(call => call.path)).toEqual(['', '/contents/orders/pay_one.json', '/contents/orders/missing.json']);
  });

  it('refuses public storage before reading any data', async () => {
    const github = new FakeGitHub();
    github.privateRepo = false;
    await expect(github.store().readJson('orders/pay_one.json')).rejects.toMatchObject({ code: 'PRIVATE_REPOSITORY_REQUIRED' });
    expect(github.calls).toHaveLength(1);
  });

  it('refuses a truncated tree and symlink blobs before any commit', async () => {
    const github = new FakeGitHub({ 'orders/pay_one.json': {} });
    github.truncated = true;
    await expect(github.store().transaction(async tx => tx.put('system/queue.json', {}))).rejects.toMatchObject({ code: 'TRUNCATED_GIT_TREE' });
    github.truncated = false;
    github.blobMode = '120000';
    await expect(github.store().transaction(async tx => tx.read('orders/pay_one.json'))).rejects.toMatchObject({ code: 'INVALID_DATA_FILE' });
    expect(github.successfulUpdates).toBe(0);
  });

  it('rejects path traversal, non-JSON data, and oversized files', async () => {
    const github = new FakeGitHub();
    const store = github.store();
    await expect(store.readJson('../orders/a.json')).rejects.toBeInstanceOf(TypeError);
    expect(github.calls).toHaveLength(0);
    await expect(store.transaction(async tx => tx.put('system/data.json', { secret: undefined }))).rejects.toBeInstanceOf(TypeError);
    await expect(store.transaction(async tx => tx.put('system/data.json', { text: 'x'.repeat(256 * 1024) }))).rejects.toBeInstanceOf(TypeError);
    github.contentOverride = { type: 'file', sha: hash('bad'), encoding: 'base64', size: 3, content: Buffer.from('bad').toString('base64') };
    await expect(store.readJson('system/data.json')).rejects.toMatchObject({ code: 'INVALID_DATA_FILE' });
    expect(github.successfulUpdates).toBe(0);
  });

  it('rejects redirects without forwarding repository credentials', async () => {
    const send=vi.fn(async(_url:RequestInfo | URL,init?:RequestInit)=>{expect(init?.redirect).toBe('manual');return new Response(null,{status:302,headers:{Location:'https://untrusted.example/'}});});
    const store=new GitHubStore({token:'fixture-token',repository:'owner/private-data',fetch:send as typeof fetch});
    await expect(store.readJson('system/data.json')).rejects.toMatchObject({status:302,code:'GITHUB_REQUEST_FAILED'});
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sanitizes exhausted transport failures and bounds network retries', async () => {
    let requests = 0;
    const store = new GitHubStore({ token: 'sensitive-fixture-token', repository: 'owner/private-data', fetch: (async () => {
      requests++;
      throw new Error('Request contained sensitive-fixture-token');
    }) as typeof fetch });
    let failure: unknown;
    try { await store.readJson('orders/pay_one.json'); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(GitHubError);
    expect(String(failure)).not.toContain('sensitive-fixture-token');
    expect((failure as Error).cause).toBeUndefined();
    expect(requests).toBe(3);
  });

  it('retries 5xx and rate limits but allows a cached instance to recover after metadata failure', async () => {
    let requests = 0;
    const retrying = new GitHubStore({ token: 'fixture-token', repository: 'owner/private-data', fetch: (async () => {
      requests++;
      if (requests === 1) return json({}, 503);
      if (requests === 2) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      if (requests === 3) return json({ private: true });
      return json({}, 404);
    }) as typeof fetch });
    expect(await retrying.readJson('orders/missing.json')).toBeNull();
    expect(requests).toBe(4);

    const github = new FakeGitHub();
    github.privateRepo = false;
    const cached = github.store();
    await expect(cached.readJson('orders/missing.json')).rejects.toMatchObject({ code: 'PRIVATE_REPOSITORY_REQUIRED' });
    github.privateRepo = true;
    expect(await cached.readJson('orders/missing.json')).toBeNull();
    expect(github.calls.filter(call => call.path === '')).toHaveLength(2);
  });
});
