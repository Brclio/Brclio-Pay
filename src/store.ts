import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Store, StoreSnapshot, Transaction } from './types';

const API = 'https://api.github.com';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TRANSACTION_BYTES = 1024 * 1024;
const MAX_TRANSACTION_PATHS = 64;
const MAX_CONFLICT_ATTEMPTS = 5;
const MAX_REQUEST_ATTEMPTS = 3;

export class GitHubError extends Error {
  constructor(message: string, readonly status = 503, readonly code = 'GITHUB_REQUEST_FAILED') {
    super(message);
    this.name = 'GitHubError';
  }
}
export { GitHubError as GithubError };

export class ConflictError extends GitHubError {
  constructor() {
    super('Payment storage is busy; retry using the same idempotency key', 409, 'STORAGE_CONFLICT');
    this.name = 'ConflictError';
  }
}

export interface GitHubStoreConfig {
  token: string;
  tokenProvider?: () => Promise<string>;
  repository: string;
  branch?: string;
  fetch?: typeof fetch;
}

interface Snapshot {
  commitSha: string;
  treeSha: string;
  files: Map<string, { sha: string; size?: number; mode: string }>;
}

interface JsonBlob {
  encoding: string;
  content: string;
  size: number;
  sha: string;
}

function assertPath(path: string): void {
  if (typeof path !== 'string' || path.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*\.json$/.test(path)
    || path.split('/').some(part => !part || part.startsWith('.') || part.includes('..'))) {
    throw new TypeError('Storage paths must be safe relative JSON file paths');
  }
}

function checkedSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new GitHubError('GitHub returned an invalid Git object', 503, 'INVALID_GIT_OBJECT');
  }
  return value;
}

function serializeJson(value: unknown): string {
  const ancestors = new Set<object>();
  const validate = (item: unknown, depth: number): void => {
    if (depth > 40) throw new TypeError('Storage JSON is too deeply nested');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') throw new TypeError('Storage values must be JSON data');
    if (ancestors.has(item)) throw new TypeError('Storage JSON cannot contain cycles');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('Storage values must contain only plain JSON objects');
    }
    ancestors.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) validate(child, depth + 1);
    ancestors.delete(item);
  };
  validate(value, 0);
  const content = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new TypeError('Storage JSON file exceeds 256 KiB');
  return content;
}

/**
 * Private GitHub data repository backed storage.
 * Every transaction builds a child commit of one immutable snapshot. A non-force
 * ref update serializes concurrent writers; callbacks can run again and must have
 * no network, payment, webhook, or other external side effects.
 */
export class GitHubStore implements Store {
  private readonly token: string;
  private readonly tokenProvider?: () => Promise<string>;
  private readonly repository: string;
  private readonly branch: string;
  private readonly branchPath: string;
  private readonly fetcher: typeof fetch;
  private privateCheck?: Promise<void>;

  constructor(config: GitHubStoreConfig) {
    if ((!config.token && !config.tokenProvider) || /[\r\n]/.test(config.token)) throw new TypeError('GitHub token is required');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(config.repository)) {
      throw new TypeError('GitHub repository must be owner/repository');
    }
    const branch = config.branch ?? 'main';
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/.test(branch)
      || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.')
      || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) {
      throw new TypeError('Invalid GitHub branch');
    }
    this.token = config.token;
    this.tokenProvider = config.tokenProvider;
    this.repository = config.repository;
    this.branch = branch;
    this.branchPath = branch.split('/').map(encodeURIComponent).join('/');
    // workerd's native fetch requires its global receiver; calling it as
    // this.fetcher(...) would otherwise bind the GitHubStore as `this`.
    this.fetcher = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`${API}/repos/${this.repository}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.tokenProvider ? await this.tokenProvider() : this.token}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'Brclio-Pay/0.1',
            'x-github-api-version': '2022-11-28',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        if (attempt + 1 < MAX_REQUEST_ATTEMPTS) {
          await this.backoff(attempt);
          continue;
        }
        // Provider exceptions can contain full authenticated requests; never retain their cause/message.
        throw new GitHubError('GitHub storage request failed', 503, 'GITHUB_NETWORK_ERROR');
      }
      const limited = response.status === 429
        || (response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'));
      if ((limited || response.status >= 500) && attempt + 1 < MAX_REQUEST_ATTEMPTS) {
        await response.body?.cancel();
        await this.backoff(attempt, response.headers.get('retry-after'));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new GitHubError(`GitHub storage request returned HTTP ${response.status}`, response.status,
          limited ? 'GITHUB_RATE_LIMITED' : 'GITHUB_REQUEST_FAILED');
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (contentLength > 12 * 1024 * 1024) {
        await response.body?.cancel();
        throw new GitHubError('GitHub storage response is too large', 503, 'GITHUB_RESPONSE_TOO_LARGE');
      }
      let raw: string;
      try {
        raw = await response.text();
      } catch {
        throw new GitHubError('GitHub storage response could not be read', 503, 'GITHUB_NETWORK_ERROR');
      }
      if (Buffer.byteLength(raw, 'utf8') > 12 * 1024 * 1024) {
        throw new GitHubError('GitHub storage response is too large', 503, 'GITHUB_RESPONSE_TOO_LARGE');
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new GitHubError('GitHub storage returned invalid JSON', 503, 'GITHUB_INVALID_RESPONSE');
      }
    }
    throw new GitHubError('GitHub storage request failed');
  }

  private async backoff(attempt: number, retryAfter: string | null = null): Promise<void> {
    const seconds = Number(retryAfter);
    const delay = retryAfter !== null && Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds * 1000, 2000) : 200 * 2 ** attempt + Math.floor(Math.random() * 100);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  private async ensurePrivate(): Promise<void> {
    this.privateCheck ??= (async () => {
      const repository = await this.request<{ private?: boolean }>('', 'GET');
      if (repository.private !== true) {
        throw new GitHubError('Payment data requires a private GitHub repository', 503, 'PRIVATE_REPOSITORY_REQUIRED');
      }
    })().catch(error => {
      // A cached instance must recover after temporary provider/configuration failure.
      this.privateCheck = undefined;
      throw error;
    });
    return this.privateCheck;
  }

  private async snapshot(): Promise<Snapshot> {
    await this.ensurePrivate();
    const ref = await this.request<{ ref: string; object: { type: string; sha: string } }>(`/git/ref/heads/${this.branchPath}`);
    if (ref.ref !== `refs/heads/${this.branch}` || ref.object?.type !== 'commit') {
      throw new GitHubError('Configured GitHub branch is not an existing commit reference', 503, 'INVALID_GIT_REFERENCE');
    }
    const commitSha = checkedSha(ref.object.sha);
    const commit = await this.request<{ tree: { sha: string } }>(`/git/commits/${commitSha}`);
    const treeSha = checkedSha(commit.tree?.sha);
    const tree = await this.request<{
      truncated?: boolean;
      tree: { path: string; type: string; sha: string; size?: number; mode: string }[];
    }>(`/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated !== false || !Array.isArray(tree.tree)) {
      throw new GitHubError('GitHub data tree is incomplete; archive old payment data before continuing', 503, 'TRUNCATED_GIT_TREE');
    }
    const files: Snapshot['files'] = new Map();
    for (const entry of tree.tree) {
      if (entry.type === 'blob') {
        if (files.has(entry.path)) throw new GitHubError('GitHub returned duplicate file paths', 503, 'INVALID_GIT_OBJECT');
        files.set(entry.path, { sha: checkedSha(entry.sha), size: entry.size, mode: entry.mode });
      }
    }
    return { commitSha, treeSha, files };
  }

  private async readSnapshot<T>(snapshot: Snapshot, path: string): Promise<T | null> {
    assertPath(path);
    const entry = snapshot.files.get(path);
    if (!entry) return null;
    if ((entry.mode !== '100644' && entry.mode !== '100755') || (entry.size ?? 0) > MAX_FILE_BYTES) {
      throw new GitHubError('GitHub data file is not a supported JSON blob', 503, 'INVALID_DATA_FILE');
    }
    const blob = await this.request<JsonBlob>(`/git/blobs/${entry.sha}`);
    return this.decodeBlob<T>(blob, entry.sha);
  }

  private decodeBlob<T>(blob: JsonBlob, expectedSha?: string): T {
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.size > MAX_FILE_BYTES
      || (expectedSha !== undefined && blob.sha !== expectedSha) || !/^[A-Za-z0-9+/=\r\n]*$/.test(blob.content)) {
      throw new GitHubError('GitHub returned an invalid data blob', 503, 'INVALID_DATA_FILE');
    }
    checkedSha(blob.sha);
    const data = Buffer.from(blob.content.replace(/[\r\n]/g, ''), 'base64');
    if (data.length !== blob.size || data.length > MAX_FILE_BYTES) {
      throw new GitHubError('GitHub data blob size does not match', 503, 'INVALID_DATA_FILE');
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data)) as T;
    } catch {
      throw new GitHubError('GitHub payment data is not valid JSON', 503, 'INVALID_DATA_FILE');
    }
  }

  async readJson<T>(path: string): Promise<T | null> {
    assertPath(path);
    await this.ensurePrivate();
    // A standalone read needs one branch-resolved file, whereas a transaction
    // must read all files by immutable blob SHA from its single snapshot.
    let file: JsonBlob & { type: string };
    try {
      file = await this.request<JsonBlob & { type: string }>(
        `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`,
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
    if (file.type !== 'file') throw new GitHubError('GitHub payment data must be a JSON file', 503, 'INVALID_DATA_FILE');
    return this.decodeBlob<T>(file);
  }

  async openSnapshot(): Promise<StoreSnapshot> {
    const snapshot = await this.snapshot();
    return {
      revision: snapshot.commitSha,
      listJsonPaths: (prefix: string): string[] => {
        if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_/-]*\/$/.test(prefix)
          || prefix.length > 200 || prefix.includes('//') || prefix.includes('..')) {
          throw new TypeError('Listing requires a safe relative directory prefix');
        }
        const paths = [...snapshot.files.keys()].filter(path => path.startsWith(prefix) && path.endsWith('.json')).sort();
        if (paths.length > 20_000) throw new GitHubError('Reporting listing exceeds its bounded capacity', 503, 'REPORTING_CAPACITY');
        return paths;
      },
      readJson: <T>(path: string) => this.readSnapshot<T>(snapshot, path),
    };
  }

  async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < MAX_CONFLICT_ATTEMPTS; attempt++) {
      const snapshot = await this.snapshot();
      const writes = new Map<string, string>();
      const reads = new Map<string, Promise<unknown>>();
      const tx: Transaction = {
        read: async <V>(path: string): Promise<V | null> => {
          assertPath(path);
          const pending = writes.get(path);
          if (pending !== undefined) return JSON.parse(pending) as V;
          if (!reads.has(path)) reads.set(path, this.readSnapshot<unknown>(snapshot, path));
          const value = await reads.get(path);
          return value === null ? null : JSON.parse(JSON.stringify(value)) as V;
        },
        put: (path: string, value: unknown): void => {
          assertPath(path);
          writes.set(path, serializeJson(value));
          if (writes.size > MAX_TRANSACTION_PATHS) throw new TypeError('Storage transaction has too many files');
          let bytes = 0;
          for (const content of writes.values()) bytes += Buffer.byteLength(content, 'utf8');
          if (bytes > MAX_TRANSACTION_BYTES) throw new TypeError('Storage transaction exceeds 1 MiB');
        },
      };
      const result = await callback(tx);
      if (writes.size === 0) return result;
      const tree = await this.request<{ sha: string }>('/git/trees', 'POST', {
        base_tree: snapshot.treeSha,
        tree: [...writes].map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      });
      const commit = await this.request<{ sha: string }>('/git/commits', 'POST', {
        // Identical writes in the same second must still yield distinct candidate
        // commits; otherwise Git could accept both and lose a logical increment.
        message: `Persist payment transaction ${randomUUID()}`,
        tree: checkedSha(tree.sha),
        parents: [snapshot.commitSha],
      });
      const candidateSha = checkedSha(commit.sha);
      try {
        const ref = await this.request<{ object: { sha: string } }>(`/git/refs/heads/${this.branchPath}`, 'PATCH', {
          sha: candidateSha,
          force: false,
        });
        if (ref.object?.sha !== candidateSha) throw new GitHubError('GitHub did not confirm payment data commit', 503, 'INVALID_GIT_REFERENCE');
        return result;
      } catch (error) {
        // A concurrent writer may have advanced the branch. Re-run against a fresh immutable snapshot.
        if (!(error instanceof GitHubError) || (error.status !== 409 && error.status !== 422)) throw error;
        if (attempt + 1 === MAX_CONFLICT_ATTEMPTS) throw new ConflictError();
        await this.backoff(attempt);
      }
    }
    throw new ConflictError();
  }

  async tx<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.transaction(callback);
  }
}
