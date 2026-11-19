import {createHash} from 'node:crypto';
import {chmodSync, closeSync, existsSync, lstatSync, openSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {ConflictError, GitHubError} from '../src/store';
import type {Store, StoreSnapshot, Transaction} from '../src/types';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TRANSACTION_BYTES = 1024 * 1024;
const MAX_TRANSACTION_PATHS = 64;
const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CONFLICT_ATTEMPTS = 8;

export interface SQLiteDocument {path: string; content: string}
export interface SQLiteArchive {path: string; content: Uint8Array}
export interface SQLiteImportOptions {
  sourceRevision: string;
  /** Required when importing into a database that already contains documents. */
  expectedRevision?: string;
  /** Replace all documents; false performs an explicit upsert. */
  replace?: boolean;
  /** Optional configuration is committed atomically with imported documents. */
  runtimeConfig?: Record<string, string>;
  /** SHA-256 over sorted path/NUL/content-SHA-256/NUL entries. */
  expectedDigest?: string;
  /** Non-JSON repository files are retained byte-for-byte, outside payment reads. */
  archives?: readonly SQLiteArchive[];
  expectedArchiveDigest?: string;
  sourceMetadata?: Record<string, unknown>;
}
export interface SQLiteExportSnapshot {
  revision: string;
  sourceRevision: string | null;
  documentDigest: string;
  documents: (SQLiteDocument & {sha256: string})[];
  archiveDigest: string;
  archives: (SQLiteArchive & {sha256: string})[];
  sourceMetadata: Record<string, unknown> | null;
  runtimeConfig: Record<string, string>;
}
interface CapturedSnapshot {
  revision: string;
  sourceRevision: string | null;
  documents: Map<string, string>;
  archives: Map<string, Uint8Array>;
  sourceMetadata: Record<string, unknown> | null;
  runtimeConfig: Record<string, string>;
}

function assertPath(path: string): void {
  if (typeof path !== 'string' || path.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*\.json$/.test(path)
    || path.split('/').some(part => !part || part.startsWith('.') || part.includes('..'))) {
    throw new TypeError('Storage paths must be safe relative JSON file paths');
  }
}
function assertPrefix(prefix: string): void {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_/-]*\/$/.test(prefix)
    || prefix.length > 200 || prefix.includes('//') || prefix.includes('..')) {
    throw new TypeError('Listing requires a safe relative directory prefix');
  }
}
function assertArchivePath(path: string): void {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new TypeError('Archive paths must be safe relative repository paths');
  }
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
function parseJson<T>(content: string): T {
  try {return JSON.parse(content) as T;}
  catch {throw new GitHubError('SQLite payment document is not valid JSON', 503, 'INVALID_DATA_FILE');}
}
function validateConfig(config: Record<string, string>): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (Object.getPrototypeOf(config) !== Object.prototype && Object.getPrototypeOf(config) !== null)) {
    throw new TypeError('Runtime configuration must be a string map');
  }
  for (const [key, value] of Object.entries(config)) {
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(key) || typeof value !== 'string' || Buffer.byteLength(value) > MAX_FILE_BYTES) {
      throw new TypeError('Runtime configuration contains an invalid variable');
    }
  }
}
const sha256 = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex');
export function sqliteDocumentDigest(documents: readonly SQLiteDocument[]): string {
  const hash = createHash('sha256');
  for (const {path, content} of [...documents].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(path).update('\0').update(sha256(content)).update('\0');
  }
  return hash.digest('hex');
}
export function sqliteArchiveDigest(archives: readonly SQLiteArchive[]): string {
  const hash = createHash('sha256');
  for (const {path, content} of [...archives].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(path).update('\0').update(sha256(content)).update('\0');
  }
  return hash.digest('hex');
}

/**
 * Server-only physical JSON document store. PartitionedStore supplies the logical
 * payment paths exactly as in the Cloudflare deployment. A callback runs against
 * an immutable in-memory snapshot; BEGIN IMMEDIATE is held only during the final
 * synchronous compare-and-commit, never across an await. Other processes cannot
 * lose updates, and callback exceptions cannot partially write an order/outbox.
 * Like GitHubStore, a conflicted callback can run again and must have no external
 * side effects. Async callbacks on one instance are queued to avoid starvation.
 */
export class SQLiteStore implements Store {
  private readonly db: DatabaseSync;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;

  constructor(readonly filename: string) {
    if (!filename || filename.includes('\0')) throw new TypeError('SQLite database filename is required');
    if (filename !== ':memory:') {
      if (existsSync(filename) && (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())) {
        throw new TypeError('SQLite database must be a regular file');
      }
      const fd = openSync(filename, 'a', 0o600);
      closeSync(fd);
      chmodSync(filename, 0o600);
    }
    this.db = new DatabaseSync(filename, {enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false});
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
        CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS documents (path TEXT PRIMARY KEY, content TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS source_archives (path TEXT PRIMARY KEY, content BLOB NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS runtime_config (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        INSERT OR IGNORE INTO store_meta(key,value) VALUES ('revision','0'), ('schema_version','1');
      `);
      if (this.meta('schema_version') !== '1') throw new Error('Unsupported SQLite store schema');
    } catch (error) {this.db.close(); throw error;}
  }

  private ensureOpen(): void {if (this.closed) throw new Error('SQLite store is closed');}
  private meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM store_meta WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  }
  private revision(): string {return `sqlite:${this.meta('revision')}`;}
  private bumpRevision(): void {
    this.db.prepare("UPDATE store_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'").run();
  }
  private capture(includePrivate = false): CapturedSnapshot {
    this.ensureOpen();
    this.db.exec('BEGIN');
    try {
      const revision = this.revision();
      const sourceRevision = this.meta('source_revision');
      const documents = new Map(this.db.prepare('SELECT path,content FROM documents ORDER BY path').all().map(row => [String(row.path), String(row.content)]));
      const archives = new Map(includePrivate ? this.db.prepare('SELECT path,content FROM source_archives ORDER BY path').all().map(row => [String(row.path), new Uint8Array(row.content as Uint8Array)]) : []);
      const metadata = this.meta('source_metadata');
      const sourceMetadata = metadata === null ? null : parseJson<Record<string, unknown>>(metadata);
      const runtimeConfig = includePrivate ? Object.fromEntries(this.db.prepare('SELECT key,value FROM runtime_config ORDER BY key').all().map(row => [String(row.key), String(row.value)])) : {};
      this.db.exec('COMMIT');
      return {revision, sourceRevision, documents, archives, sourceMetadata, runtimeConfig};
    } catch (error) {this.db.exec('ROLLBACK'); throw error;}
  }
  private change(callback: () => void): void {
    this.ensureOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {callback(); this.bumpRevision(); this.db.exec('COMMIT');}
    catch (error) {this.db.exec('ROLLBACK'); throw error;}
  }
  private writeConfig(config: Record<string, string>): void {
    this.db.exec('DELETE FROM runtime_config');
    const put = this.db.prepare('INSERT INTO runtime_config(key,value) VALUES (?,?)');
    for (const [key, value] of Object.entries(config)) put.run(key, value);
  }

  async readJson<T>(path: string): Promise<T | null> {
    this.ensureOpen(); assertPath(path);
    const row = this.db.prepare('SELECT content FROM documents WHERE path = ?').get(path);
    return row ? parseJson<T>(String(row.content)) : null;
  }
  async openSnapshot(): Promise<StoreSnapshot> {
    const snapshot = this.capture();
    return {
      revision: snapshot.revision,
      listJsonPaths: prefix => {
        assertPrefix(prefix);
        const paths = [...snapshot.documents.keys()].filter(path => path.startsWith(prefix));
        if (paths.length > 20_000) throw new GitHubError('Reporting listing exceeds its bounded capacity', 503, 'REPORTING_CAPACITY');
        return paths;
      },
      readJson: async <T>(path: string): Promise<T | null> => {
        assertPath(path);
        const content = snapshot.documents.get(path);
        return content === undefined ? null : parseJson<T>(content);
      },
    };
  }
  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    this.ensureOpen(); this.pending++;
    const operation = this.tail.then(() => this.transact(callback));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation.finally(() => {this.pending--;});
  }
  private async transact<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < MAX_CONFLICT_ATTEMPTS; attempt++) {
      const snapshot = this.capture();
      const writes = new Map<string, string>();
      let active = true;
      const assertActive = () => {if (!active) throw new Error('Storage transaction callback has completed');};
      const tx: Transaction = {
        read: async <V>(path: string): Promise<V | null> => {
          assertActive(); assertPath(path);
          const content = writes.get(path) ?? snapshot.documents.get(path);
          return content === undefined ? null : parseJson<V>(content);
        },
        put: (path, value) => {
          assertActive(); assertPath(path);
          const content = serializeJson(value);
          const paths = writes.size + (writes.has(path) ? 0 : 1);
          if (paths > MAX_TRANSACTION_PATHS) throw new TypeError('Storage transaction has too many files');
          const bytes = [...writes].reduce((total, [key, raw]) => total + (key === path ? 0 : Buffer.byteLength(raw)), Buffer.byteLength(content));
          if (bytes > MAX_TRANSACTION_BYTES) throw new TypeError('Storage transaction exceeds 1 MiB');
          writes.set(path, content);
        },
      };
      let result: T;
      try {result = await callback(tx);} finally {active = false;}
      if (writes.size === 0) return result;
      try {
        this.change(() => {
          if (this.revision() !== snapshot.revision) throw new ConflictError();
          const put = this.db.prepare('INSERT INTO documents(path,content) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content');
          for (const [path, content] of writes) put.run(path, content);
        });
        return result;
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt + 1 === MAX_CONFLICT_ATTEMPTS) throw error;
      }
    }
    throw new ConflictError();
  }

  readRuntimeConfig(): Record<string, string> {
    this.ensureOpen();
    return Object.fromEntries(this.db.prepare('SELECT key,value FROM runtime_config ORDER BY key').all().map(row => [String(row.key), String(row.value)]));
  }
  getRuntimeConfig(): Record<string, string> {return this.readRuntimeConfig();}
  replaceRuntimeConfig(config: Record<string, string>, options: {expectedRevision?: string} = {}): string {
    validateConfig(config);
    this.change(() => {
      if (options.expectedRevision !== undefined && options.expectedRevision !== this.revision()) throw new ConflictError();
      this.writeConfig(config);
    });
    return this.revision();
  }
  /** Import exact source JSON bytes (including formatting), never parse/re-serialize. */
  importDocuments(documents: readonly SQLiteDocument[], options: SQLiteImportOptions): string {
    this.ensureOpen();
    if (!options || !/^[A-Za-z0-9_.:-]{1,160}$/.test(options.sourceRevision)) throw new TypeError('A source revision is required');
    if (!Array.isArray(documents)) throw new TypeError('Import documents must be an array');
    const paths = new Set<string>();
    for (const document of documents) {
      assertPath(document.path);
      if (paths.has(document.path)) throw new TypeError('Import contains duplicate document paths');
      paths.add(document.path);
      if (typeof document.content !== 'string' || Buffer.byteLength(document.content) > MAX_IMPORT_FILE_BYTES) throw new TypeError('Import document exceeds its supported size');
      parseJson(document.content);
    }
    if (options.runtimeConfig !== undefined) validateConfig(options.runtimeConfig);
    if (options.expectedDigest !== undefined && options.expectedDigest !== sqliteDocumentDigest(documents)) throw new TypeError('Import document digest does not match the reviewed source');
    if (options.archives !== undefined && !Array.isArray(options.archives)) throw new TypeError('Import archives must be an array');
    for (const archive of options.archives || []) {
      assertArchivePath(archive.path);
      if (paths.has(archive.path)) throw new TypeError('Import contains duplicate repository paths');
      paths.add(archive.path);
      if (!(archive.content instanceof Uint8Array) || archive.content.byteLength > MAX_IMPORT_FILE_BYTES) throw new TypeError('Import archive exceeds its supported size');
    }
    if (options.expectedArchiveDigest !== undefined && options.expectedArchiveDigest !== sqliteArchiveDigest(options.archives || [])) throw new TypeError('Import archive digest does not match the reviewed source');
    const metadata = options.sourceMetadata === undefined ? undefined : serializeJson(options.sourceMetadata);
    if (options.sourceMetadata?.revision !== undefined && options.sourceMetadata.revision !== options.sourceRevision) throw new TypeError('Import metadata revision does not match source revision');
    this.change(() => {
      const existing = Number(this.db.prepare('SELECT (SELECT count(*) FROM documents) + (SELECT count(*) FROM source_archives) AS count').get()!.count);
      if (existing > 0 && options.expectedRevision === undefined) throw new TypeError('Import into an existing database requires an expected revision');
      if (options.expectedRevision !== undefined && options.expectedRevision !== this.revision()) throw new ConflictError();
      if (options.replace) this.db.exec('DELETE FROM documents');
      const put = this.db.prepare('INSERT INTO documents(path,content) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content');
      for (const {path, content} of documents) put.run(path, content);
      if (options.archives !== undefined) {
        if (options.replace) this.db.exec('DELETE FROM source_archives');
        const archivePut = this.db.prepare('INSERT INTO source_archives(path,content) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content');
        for (const {path, content} of options.archives) archivePut.run(path, content);
      }
      if (options.runtimeConfig !== undefined) this.writeConfig(options.runtimeConfig);
      this.db.prepare("INSERT INTO store_meta(key,value) VALUES ('source_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(options.sourceRevision);
      if (metadata !== undefined) this.db.prepare("INSERT INTO store_meta(key,value) VALUES ('source_metadata',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(metadata);
    });
    return this.revision();
  }
  /** Sensitive export: callers must save only to a private backup, never to logs. */
  exportSnapshot(): SQLiteExportSnapshot {
    const snapshot = this.capture(true);
    const documents = [...snapshot.documents].map(([path, content]) => ({path, content, sha256: sha256(content)}));
    const archives = [...snapshot.archives].map(([path, content]) => ({path, content, sha256: sha256(content)}));
    return {...snapshot, documents, archives, documentDigest: sqliteDocumentDigest(documents), archiveDigest: sqliteArchiveDigest(archives)};
  }
  integrityCheck(): boolean {
    this.ensureOpen();
    return this.db.prepare('PRAGMA integrity_check').all().every(row => row.integrity_check === 'ok');
  }
  close(): void {
    if (this.closed) return;
    if (this.pending) throw new Error('SQLite store has unfinished transactions');
    this.db.close(); this.closed = true;
  }
}
