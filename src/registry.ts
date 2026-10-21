import { Buffer } from 'node:buffer';
import type { Env, ProductClient, Store, Transaction } from './types';
import { clients as legacyClients, HttpError, httpsUrl, requireThat } from './config';
import { randomId, randomNonce, sha256 } from './crypto';
import {datedPath} from './partitioned-store';

export const REGISTRY_PATH = 'system/clients.enc.json';
const AAD = new TextEncoder().encode(`brclio-pay:registry:v1:${REGISTRY_PATH}`);
const MAX_REGISTRY_BYTES = 128 * 1024;
const MAX_CLIENTS = 100;
const MAX_GRANTS = 64;
const MAX_PLANS = 128;
const GRANT_SECONDS = 2 * 60 * 60;
const PLAN_SECONDS = 15 * 60;

export interface RegistryEnvironment extends Env { REGISTRY_ENCRYPTION_KEY?: string }
export interface ClientConfig {
  id: string;
  name: string;
  webhookUrl: string;
  returnOrigins: string[];
  skus: ProductClient['skus'];
  enabled?: boolean;
  providers?: ProductClient['providers'];
  webhookProtocol?: ProductClient['webhookProtocol'];
}
export interface ManagedClient extends ProductClient { enabled: boolean }
export interface ClientView extends ClientConfig { enabled: boolean; version: string }
export interface Credentials { apiSecret: string; webhookSecret: string }
export interface PublicAuditEntry {
  id: string; at: string; actor: string;
  action: 'client.created' | 'client.updated' | 'grant.created' | 'grant.revoked' | 'integration.planned' | 'integration.applied';
  clientId: string; version?: string;
  addedOrigins?: string[];
}
export interface GrantInput {
  clientId: string;
  mode: 'create' | 'update';
  allowedOrigins: string[];
  domainMode?: 'fixed' | 'auto';
  pricingMode?: 'detect' | 'manual';
  lifetimeSeconds?: number;
}
export interface GrantView {
  id: string; clientId: string; mode: 'create' | 'update'; allowedOrigins: string[];
  domainMode?: 'fixed' | 'auto'; pricingMode?: 'detect' | 'manual';
  createdAt: string; expiresAt: string;
  revokedAt?: string;
}
export interface IssuedGrant extends GrantView { token: string }
export interface IntegrationContext {
  clientId: string; mode: 'create' | 'update'; allowedOrigins: string[]; expiresAt: string;
  domainMode?: 'fixed' | 'auto'; pricingMode?: 'detect' | 'manual';
  client: ClientView | null; credentials: Credentials | null;
  payBaseUrl: string; docsUrl: string; paymentMode: 'live' | 'sandbox';
}
export interface PlanInput { config: ClientConfig; expectedVersion: string }
export interface PlanView {
  planId: string; clientId: string; mode: 'create' | 'update'; baseVersion: string;
  expiresAt: string; before: ClientView | null; after: ClientConfig & { enabled: boolean };
  addedOrigins?: string[];
}
export interface ApplyResult { client: ClientView; credentials: Credentials; appliedAt: string }
interface StoredGrant extends GrantView { tokenHash: string; appliedPlanId?: string }
interface StoredPlan extends PlanView { grantHash: string; result?: ApplyResult }
interface RegistryState {
  schema: 1; revision: number; clients: ManagedClient[];
  grants: StoredGrant[]; plans: StoredPlan[]; audit: PublicAuditEntry[];
}
interface Envelope { schema: 1; algorithm: 'AES-256-GCM'; iv: string; ciphertext: string }

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function clientId(value: unknown): asserts value is string {
  requireThat(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(value), 400, 'INVALID_CLIENT_ID', '产品 ID 格式错误');
}
function expectedVersion(value: unknown): asserts value is string {
  requireThat(typeof value === 'string' && (value === 'absent' || /^[a-f0-9]{64}$/.test(value)), 400, 'INVALID_VERSION', '需要当前产品版本或 absent');
}
function actorName(value: string): string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value), 400, 'INVALID_ACTOR', '操作人标识无效');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function clientVersion(client: ManagedClient): string { return sha256(canonical(client)); }
function credentials(client: ManagedClient): Credentials {
  return { apiSecret: client.apiSecret, webhookSecret: client.webhookSecret };
}
function publicView(client: ManagedClient): ClientView {
  return {
    id: client.id, name: client.name, webhookUrl: client.webhookUrl,
    returnOrigins: [...client.returnOrigins], skus: structuredClone(client.skus),
    enabled: client.enabled, ...(client.providers?{providers:[...client.providers]}:{}), ...(client.webhookProtocol||client.legacyWechat?{webhookProtocol:client.webhookProtocol??'wechat-legacy-v1'}:{}), version: clientVersion(client),
  };
}
function origin(value: unknown): string {
  requireThat(typeof value === 'string' && value.length <= 300, 400, 'INVALID_ORIGIN', '域名白名单格式错误');
  if (value.startsWith('https://*.')) {
    const domain = value.slice('https://*.'.length);
    requireThat(domain.length <= 253 && domain.includes('.') && domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      && !/^[\d.]+$/.test(domain) && !domain.endsWith('.localhost') && !domain.endsWith('.local'), 400, 'INVALID_ORIGIN', '通配域名白名单格式错误');
    return value;
  }
  const parsed = httpsUrl(value);
  requireThat(parsed.origin === value && parsed.hostname.includes('.') && parsed.hostname !== 'localhost' && !parsed.hostname.endsWith('.localhost')
    && !parsed.hostname.endsWith('.local') && !/^[\d.]+$/.test(parsed.hostname) && !parsed.hostname.includes(':'),
  400, 'INVALID_ORIGIN', '白名单必须是公网 HTTPS origin，不能包含路径');
  return value;
}
function origins(value: unknown, minimum = 1, maximum = 50): string[] {
  requireThat(Array.isArray(value) && value.length >= minimum && value.length <= maximum, 400, 'INVALID_ORIGIN', `需要 ${minimum} 至 ${maximum} 个 HTTPS 来源`);
  return [...new Set(value.map(origin))].sort();
}
function scopeContains(candidate: string, scope: string): boolean {
  if (!scope.includes('*')) return candidate === scope;
  const base = scope.slice('https://*.'.length);
  if (candidate.startsWith('https://*.')) {
    const child = candidate.slice('https://*.'.length);
    return child === base || child.endsWith(`.${base}`);
  }
  const url = httpsUrl(candidate);
  return url.port === '' && url.hostname !== base && url.hostname.endsWith(`.${base}`);
}
function enforceScope(config: ClientConfig, previous: ManagedClient | null, scopes: string[]): void {
  const changedOrigins = config.returnOrigins.filter(item => !previous?.returnOrigins.includes(item));
  if (!previous || config.webhookUrl !== previous.webhookUrl) changedOrigins.push(httpsUrl(config.webhookUrl).origin);
  requireThat(changedOrigins.every(item => scopes.some(scope => scopeContains(item, scope))), 403, 'INTEGRATION_SCOPE', '新增或变更的地址超出了授权域名范围');
}
function requiredOrigins(config: ClientConfig): string[] {
  return [...new Set([...config.returnOrigins, origin(httpsUrl(config.webhookUrl).origin)])].sort();
}
function additionalOrigins(config: ClientConfig, grant: GrantView): string[] {
  return requiredOrigins(config).filter(candidate => !grant.allowedOrigins.some(scope => scopeContains(candidate, scope)));
}

/** Encrypted tenant registry. Only this module may turn stored records into credentials. */
export class Registry {
  private keyPromise?: Promise<CryptoKey>;
  constructor(private env: RegistryEnvironment, private store: Store, private now: () => number = Date.now) {}

  private key(): Promise<CryptoKey> {
    requireThat(typeof this.env.REGISTRY_ENCRYPTION_KEY === 'string' && /^[a-f0-9]{64}$/i.test(this.env.REGISTRY_ENCRYPTION_KEY),
      503, 'REGISTRY_KEY_REQUIRED', '产品配置加密密钥尚未配置');
    this.keyPromise ??= crypto.subtle.importKey('raw', Uint8Array.from(Buffer.from(this.env.REGISTRY_ENCRYPTION_KEY, 'hex')),
      { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return this.keyPromise;
  }

  private legacy(): RegistryState {
    const clients = legacyClients(this.env).map(client => {
      const enabled = (client as ProductClient & { enabled?: unknown }).enabled;
      requireThat(enabled === undefined || typeof enabled === 'boolean', 503, 'CONFIGURATION', '产品启用状态配置无效');
      return { ...structuredClone(client), enabled: enabled !== false };
    });
    return { schema: 1, revision: 0, clients, grants: [], plans: [], audit: [] };
  }

  private async decode(envelope: Envelope): Promise<RegistryState> {
    requireThat(record(envelope) && envelope.schema === 1 && envelope.algorithm === 'AES-256-GCM'
      && typeof envelope.iv === 'string' && /^[A-Za-z0-9+/]{16}$/.test(envelope.iv)
      && typeof envelope.ciphertext === 'string' && envelope.ciphertext.length <= 180_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext),
    503, 'REGISTRY_CORRUPT', '加密产品配置格式无效');
    const key = await this.key();
    let state: unknown;
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(Buffer.from(envelope.iv, 'base64')), additionalData: AAD },
        key, Uint8Array.from(Buffer.from(envelope.ciphertext, 'base64')));
      requireThat(plaintext.byteLength <= MAX_REGISTRY_BYTES, 503, 'REGISTRY_CORRUPT', '产品配置过大');
      state = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext));
    } catch {
      throw new HttpError(503, 'REGISTRY_DECRYPT_FAILED', '无法解密产品配置，请检查加密密钥');
    }
    requireThat(record(state) && state.schema === 1 && Number.isSafeInteger(state.revision) && Number(state.revision) >= 0
      && Array.isArray(state.clients) && Array.isArray(state.grants) && Array.isArray(state.plans) && Array.isArray(state.audit),
    503, 'REGISTRY_CORRUPT', '产品配置结构无效');
    try {
      legacyClients({ ...this.env, CLIENTS_JSON: JSON.stringify(state.clients) });
      requireThat(state.clients.every(client => record(client) && typeof client.enabled === 'boolean'), 503, 'REGISTRY_CORRUPT', '产品配置启用状态无效');
      for (const grant of state.grants) {
        requireThat(record(grant) && /^grant_[a-f0-9]{32}$/.test(String(grant.id)) && /^[a-f0-9]{64}$/.test(String(grant.tokenHash))
          && (grant.mode === 'create' || grant.mode === 'update') && typeof grant.clientId === 'string' && Array.isArray(grant.allowedOrigins)
          && (grant.domainMode === undefined || grant.domainMode === 'fixed' || grant.domainMode === 'auto')
          && (grant.pricingMode === undefined || grant.pricingMode === 'detect' || grant.pricingMode === 'manual')
          && Number.isFinite(Date.parse(String(grant.expiresAt))), 503, 'REGISTRY_CORRUPT', '产品授权配置无效');
        origins(grant.allowedOrigins, grant.domainMode === 'auto' ? 0 : 1, grant.domainMode === 'auto' ? 100 : 50);
      }
      for (const plan of state.plans) {
        requireThat(record(plan) && /^plan_[a-f0-9]{32}$/.test(String(plan.planId)) && /^[a-f0-9]{64}$/.test(String(plan.grantHash))
          && record(plan.after) && typeof plan.clientId === 'string' && Number.isFinite(Date.parse(String(plan.expiresAt))),
        503, 'REGISTRY_CORRUPT', '产品接入计划无效');
      }
    } catch {
      throw new HttpError(503, 'REGISTRY_CORRUPT', '产品配置结构无效');
    }
    return state as unknown as RegistryState;
  }

  private async plainState(tx?:Transaction):Promise<RegistryState> {
    const read=<T>(path:string)=>tx?tx.read<T>(path):this.store.readJson<T>(path);
    const manifest=await read<{schema:number;revision:number;clients:string[];grants:string[];plans:string[];audit:{id:string;at:string}[]}>('system/registry.json');
    if(!manifest)return this.legacy();
    requireThat(manifest.schema===2 && Number.isSafeInteger(manifest.revision) && ['clients','grants','plans','audit'].every(key=>Array.isArray((manifest as unknown as Record<string,unknown>)[key])),503,'REGISTRY_CORRUPT','产品配置索引无效');
    const load=async<T>(paths:string[])=>Promise.all(paths.map(async path=>{
      const value=await read<T>(path);requireThat(value,503,'REGISTRY_CORRUPT','产品配置文件缺失');return value;
    }));
    const [clients,grants,plans,audit]=await Promise.all([
      load<ManagedClient>(manifest.clients.map(id=>{clientId(id);return `registry/clients/${id}.json`;})),
      load<StoredGrant>(manifest.grants.map(id=>{requireThat(/^grant_[a-f0-9]{32}$/.test(id),503,'REGISTRY_CORRUPT','授权索引无效');return `registry/grants/${id}.json`;})),
      load<StoredPlan>(manifest.plans.map(id=>{requireThat(/^plan_[a-f0-9]{32}$/.test(id),503,'REGISTRY_CORRUPT','计划索引无效');return `registry/plans/${id}.json`;})),
      load<PublicAuditEntry>(manifest.audit.map(item=>{requireThat(/^audit_[a-f0-9]{32}$/.test(item.id),503,'REGISTRY_CORRUPT','审计索引无效');return datedPath('registry/audit',item.id,item.at);})),
    ]);
    legacyClients({...this.env,CLIENTS_JSON:JSON.stringify(clients)});
    return {schema:1,revision:manifest.revision,clients,grants,plans,audit};
  }
  private async state(tx?: Transaction): Promise<RegistryState> {
    if(this.env.REGISTRY_STORAGE_MODE==='plain')return this.plainState(tx);
    const envelope = tx ? await tx.read<Envelope>(REGISTRY_PATH) : await this.store.readJson<Envelope>(REGISTRY_PATH);
    return envelope === null ? this.legacy() : this.decode(envelope);
  }

  private prune(state: RegistryState, milliseconds: number): void {
    state.grants = state.grants.filter(grant => Date.parse(grant.expiresAt) > milliseconds);
    const hashes = new Set(state.grants.map(grant => grant.tokenHash));
    state.plans = state.plans.filter(plan => hashes.has(plan.grantHash) && (!!plan.result || Date.parse(plan.expiresAt) > milliseconds));
    state.audit = state.audit.slice(-100);
  }

  private async save(tx: Transaction, state: RegistryState, milliseconds: number): Promise<void> {
    this.prune(state, milliseconds);
    state.revision++;
    requireThat(state.clients.length <= MAX_CLIENTS && state.grants.length <= MAX_GRANTS && state.plans.length <= MAX_PLANS,
      409, 'REGISTRY_FULL', '产品配置或活动授权已达到上限');
    const data = new TextEncoder().encode(JSON.stringify(state));
    requireThat(data.byteLength <= MAX_REGISTRY_BYTES, 409, 'REGISTRY_FULL', '产品配置已达到容量上限');
    if(this.env.REGISTRY_STORAGE_MODE==='plain'){
      const write=async(path:string,value:unknown)=>{if(JSON.stringify(await tx.read(path))!==JSON.stringify(value))tx.put(path,value);};
      for(const client of state.clients)await write(`registry/clients/${client.id}.json`,client);
      for(const grant of state.grants)await write(`registry/grants/${grant.id}.json`,grant);
      for(const plan of state.plans)await write(`registry/plans/${plan.planId}.json`,plan);
      for(const entry of state.audit)await write(datedPath('registry/audit',entry.id,entry.at),entry);
      tx.put('system/registry.json',{schema:2,revision:state.revision,clients:state.clients.map(c=>c.id),grants:state.grants.map(g=>g.id),plans:state.plans.map(p=>p.planId),audit:state.audit.map(({id,at})=>({id,at}))});
      return;
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await this.key(), data);
    tx.put(REGISTRY_PATH, { schema: 1, algorithm: 'AES-256-GCM', iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') } satisfies Envelope);
  }

  private note(state: RegistryState, entry: Omit<PublicAuditEntry, 'id'>): void {
    state.audit.push({ id: randomId('audit_'), ...entry });
  }

  private config(input: unknown, previous: ManagedClient | null): ClientConfig & { enabled: boolean } {
    requireThat(record(input) && Object.keys(input).every(key => ['id', 'name', 'webhookUrl', 'returnOrigins', 'skus', 'enabled', 'providers', 'webhookProtocol'].includes(key)),
      400, 'INVALID_CLIENT_CONFIG', '仅允许产品名称、回调、域名、商品与启用状态');
    clientId(input.id);
    requireThat(input.enabled === undefined || typeof input.enabled === 'boolean', 400, 'INVALID_CLIENT_CONFIG', '启用状态必须是布尔值');
    requireThat(typeof input.webhookUrl === 'string' && input.webhookUrl.length <= 2048 && record(input.skus)
      && Object.keys(input.skus).length > 0 && Object.keys(input.skus).length <= 100, 400, 'INVALID_CLIENT_CONFIG', '产品回调或商品配置无效');
    const config = {
      id: input.id, name: input.name, webhookUrl: input.webhookUrl,
      returnOrigins: origins(input.returnOrigins), skus: structuredClone(input.skus),
      enabled: input.enabled ?? previous?.enabled ?? true,
      ...(input.webhookProtocol!==undefined?{webhookProtocol:input.webhookProtocol}:previous?.webhookProtocol?{webhookProtocol:previous.webhookProtocol}:{}),
      ...(input.providers!==undefined?{providers:structuredClone(input.providers)}:previous?.providers?{providers:structuredClone(previous.providers)}:{}),
    } as ClientConfig & { enabled: boolean };
    for (const sku of Object.values(config.skus)) {
      requireThat(record(sku) && Object.keys(sku).every(key => ['subject', 'amount', 'enabled', 'description', 'entitlement'].includes(key)),
        400, 'INVALID_CLIENT_CONFIG', '商品仅允许名称、金额、启用状态、说明与权益');
    }
    try {
      legacyClients({ ...this.env, CLIENTS_JSON: JSON.stringify([{ ...config, apiSecret: 'x'.repeat(64), webhookSecret: 'y'.repeat(64) }]) });
    } catch {
      throw new HttpError(400, 'INVALID_CLIENT_CONFIG', '产品名称、回调、域名或商品配置无效');
    }
    return config;
  }

  private target(state: RegistryState, id: string, version: string): ManagedClient | null {
    expectedVersion(version);
    const found = state.clients.find(client => client.id === id) ?? null;
    requireThat(found ? version === clientVersion(found) : version === 'absent', 409, 'CLIENT_VERSION_CONFLICT', '该产品配置已变化，请重新读取该产品后再应用');
    return found;
  }

  private grant(state: RegistryState, token: string, milliseconds: number): StoredGrant {
    requireThat(typeof token === 'string' && /^brp_int_[a-f0-9]{64}$/.test(token), 401, 'INVALID_INTEGRATION_GRANT', '接入授权无效或已过期');
    const hash = sha256(token);
    const found = state.grants.find(grant => grant.tokenHash === hash);
    requireThat(found && !found.revokedAt && Date.parse(found.expiresAt) > milliseconds, 401, 'INVALID_INTEGRATION_GRANT', '接入授权无效或已过期');
    return found;
  }

  async resolveClients(): Promise<ManagedClient[]> {
    if(this.env.REGISTRY_STORAGE_MODE!=='plain')return structuredClone((await this.state()).clients);
    const manifest=await this.store.readJson<{schema:number;clients:string[]}>('system/registry.json');
    if(!manifest)return this.legacy().clients;
    requireThat(manifest.schema===2&&Array.isArray(manifest.clients)&&manifest.clients.length<=MAX_CLIENTS,503,'REGISTRY_CORRUPT','产品配置索引无效');
    const values=await Promise.all(manifest.clients.map(async id=>{clientId(id);const value=await this.store.readJson<ManagedClient>(`registry/clients/${id}.json`);requireThat(value&&value.id===id,503,'REGISTRY_CORRUPT','产品配置文件缺失');return value;}));
    legacyClients({...this.env,CLIENTS_JSON:JSON.stringify(values)});
    return values;
  }
  async list(): Promise<ClientView[]> { return (await this.state()).clients.map(publicView); }
  async get(id: string): Promise<ManagedClient | null> {
    clientId(id);
    return structuredClone((await this.state()).clients.find(client => client.id === id) ?? null);
  }
  async audit(): Promise<PublicAuditEntry[]> { return structuredClone((await this.state()).audit); }
  async listGrants(): Promise<GrantView[]> {
    return (await this.state()).grants.filter(grant => Date.parse(grant.expiresAt) > this.now())
      .map(({ id, clientId, mode, allowedOrigins, createdAt, expiresAt, revokedAt, domainMode, pricingMode }) => ({ id, clientId, mode,
        allowedOrigins: [...allowedOrigins], domainMode: domainMode ?? 'fixed', pricingMode: pricingMode ?? 'detect',
        createdAt, expiresAt, ...(revokedAt ? { revokedAt } : {}) }));
  }

  async revokeGrant(id: string, actor: string): Promise<void> {
    requireThat(typeof id === 'string' && /^grant_[a-f0-9]{32}$/.test(id), 400, 'INVALID_INTEGRATION_GRANT', '接入授权标识无效');
    actorName(actor);
    const milliseconds = this.now();
    await this.store.transaction(async tx => {
      const state = await this.state(tx);
      const grant = state.grants.find(item => item.id === id);
      requireThat(grant && Date.parse(grant.expiresAt) > milliseconds, 404, 'INTEGRATION_GRANT_NOT_FOUND', '授权不存在或已过期');
      if (grant.revokedAt) return;
      grant.revokedAt = new Date(milliseconds).toISOString();
      this.note(state, { at: grant.revokedAt, actor, action: 'grant.revoked', clientId: grant.clientId });
      await this.save(tx, state, milliseconds);
    });
  }

  async upsertClient(input: ClientConfig, version: string, actor: string): Promise<ClientView> {
    clientId(input?.id);
    expectedVersion(version);
    actorName(actor);
    const milliseconds = this.now();
    return this.store.transaction(async tx => {
      const state = await this.state(tx);
      const previous = this.target(state, input.id, version);
      const config = this.config(input, previous);
      const updated: ManagedClient = { ...previous, ...config,
        apiSecret: previous?.apiSecret ?? `${randomNonce()}${randomNonce()}`.slice(0, 64),
        webhookSecret: previous?.webhookSecret ?? `${randomNonce()}${randomNonce()}`.slice(0, 64),
      };
      const index = state.clients.findIndex(client => client.id === input.id);
      if (index < 0) state.clients.push(updated); else state.clients[index] = updated;
      const view = publicView(updated);
      this.note(state, { at: new Date(milliseconds).toISOString(), actor, action: previous ? 'client.updated' : 'client.created', clientId: updated.id, version: view.version });
      await this.save(tx, state, milliseconds);
      return view;
    });
  }

  async createGrant(input: GrantInput, actor: string): Promise<IssuedGrant> {
    requireThat(record(input) && Object.keys(input).every(key => ['clientId', 'mode', 'allowedOrigins', 'lifetimeSeconds', 'domainMode', 'pricingMode'].includes(key)),
      400, 'INVALID_INTEGRATION_GRANT', '接入授权参数无效');
    clientId(input.clientId);
    actorName(actor);
    requireThat(input.mode === 'create' || input.mode === 'update', 400, 'INVALID_INTEGRATION_GRANT', '接入授权类型无效');
    const domainMode = input.domainMode ?? 'fixed';
    const pricingMode = input.pricingMode ?? 'detect';
    requireThat(domainMode === 'fixed' || domainMode === 'auto', 400, 'INVALID_INTEGRATION_GRANT', '域名授权模式无效');
    requireThat(pricingMode === 'detect' || pricingMode === 'manual', 400, 'INVALID_INTEGRATION_GRANT', '套餐来源模式无效');
    const allowedOrigins = origins(input.allowedOrigins, domainMode === 'auto' ? 0 : 1);
    const seconds = input.lifetimeSeconds ?? GRANT_SECONDS;
    requireThat(Number.isInteger(seconds) && seconds >= 60 && seconds <= GRANT_SECONDS, 400, 'INVALID_INTEGRATION_GRANT', '接入授权有效期必须在 1 分钟至 2 小时内');
    const milliseconds = this.now();
    const token = `brp_int_${`${randomNonce()}${randomNonce()}`.slice(0, 64)}`;
    const view: GrantView = { id: randomId('grant_'), clientId: input.clientId, mode: input.mode, allowedOrigins, domainMode, pricingMode,
      createdAt: new Date(milliseconds).toISOString(), expiresAt: new Date(milliseconds + seconds * 1000).toISOString() };
    await this.store.transaction(async tx => {
      const state = await this.state(tx);
      const exists = state.clients.some(client => client.id === input.clientId);
      requireThat(input.mode === 'create' ? !exists : exists, 409, 'GRANT_MODE_CONFLICT', input.mode === 'create' ? '该产品已存在，请使用更新授权' : '该产品不存在，请使用创建授权');
      this.prune(state, milliseconds);
      state.grants.push({ ...view, tokenHash: sha256(token) });
      this.note(state, { at: new Date(milliseconds).toISOString(), actor, action: 'grant.created', clientId: input.clientId });
      await this.save(tx, state, milliseconds);
    });
    return { ...view, token };
  }

  async grantContext(token: string): Promise<IntegrationContext> {
    const state = await this.state();
    const grant = this.grant(state, token, this.now());
    const client = state.clients.find(client => client.id === grant.clientId) ?? null;
    requireThat(grant.mode !== 'create' || !client || !!grant.appliedPlanId, 409, 'GRANT_MODE_CONFLICT', '目标产品已由其他操作创建，请申请新的授权');
    return {
      clientId: grant.clientId, mode: grant.mode, allowedOrigins: [...grant.allowedOrigins], expiresAt: grant.expiresAt,
      domainMode: grant.domainMode ?? 'fixed', pricingMode: grant.pricingMode ?? 'detect',
      client: client ? publicView(client) : null, credentials: client ? credentials(client) : null,
      payBaseUrl: this.env.PAY_BASE_URL, docsUrl: `${this.env.PAY_BASE_URL}/docs/integration.md`,
      paymentMode: this.env.PAYMENT_MODE,
    };
  }

  async plan(token: string, input: PlanInput): Promise<PlanView> {
    requireThat(record(input) && Object.keys(input).every(key => ['config', 'expectedVersion'].includes(key)) && record(input.config),
      400, 'INVALID_INTEGRATION_PLAN', '接入计划参数无效');
    clientId(input.config.id);
    expectedVersion(input.expectedVersion);
    const milliseconds = this.now();
    const planId = randomId('plan_');
    return this.store.transaction(async tx => {
      const state = await this.state(tx);
      const grant = this.grant(state, token, milliseconds);
      requireThat(input.config.id === grant.clientId, 403, 'INTEGRATION_SCOPE', '授权仅适用于指定产品');
      const previous = this.target(state, grant.clientId, input.expectedVersion);
      requireThat(grant.mode === 'create' ? !previous : !!previous, 409, 'GRANT_MODE_CONFLICT', '授权类型与目标产品当前状态不一致');
      const after = this.config(input.config, previous);
      if (grant.domainMode !== 'auto') enforceScope(after, previous, grant.allowedOrigins);
      const addedOrigins = grant.domainMode === 'auto' ? additionalOrigins(after, grant) : [];
      requireThat(new Set([...grant.allowedOrigins, ...addedOrigins]).size <= 100, 400, 'INTEGRATION_SCOPE_LIMIT', '该授权记录的域名已达到上限');
      const plan: StoredPlan = {
        planId, clientId: grant.clientId, mode: grant.mode, baseVersion: input.expectedVersion,
        expiresAt: new Date(Math.min(milliseconds + PLAN_SECONDS * 1000, Date.parse(grant.expiresAt))).toISOString(),
        before: previous ? publicView(previous) : null, after, addedOrigins, grantHash: grant.tokenHash,
      };
      this.prune(state, milliseconds);
      state.plans.push(plan);
      this.note(state, { at: new Date(milliseconds).toISOString(), actor: `integration:${grant.id}`, action: 'integration.planned', clientId: grant.clientId,
        ...(addedOrigins.length ? { addedOrigins } : {}) });
      await this.save(tx, state, milliseconds);
      const { grantHash: _hash, ...view } = plan;
      return view;
    });
  }

  async apply(token: string, input: { planId: string }): Promise<ApplyResult> {
    requireThat(record(input) && Object.keys(input).length === 1 && /^plan_[a-f0-9]{32}$/.test(String(input.planId)),
      400, 'INVALID_INTEGRATION_PLAN', '需要有效的 planId');
    const milliseconds = this.now();
    return this.store.transaction(async tx => {
      const state = await this.state(tx);
      const grant = this.grant(state, token, milliseconds);
      const plan = state.plans.find(item => item.planId === input.planId && item.grantHash === grant.tokenHash);
      requireThat(plan, 404, 'INTEGRATION_PLAN_NOT_FOUND', '该授权下没有此接入计划');
      if (plan.result) return structuredClone(plan.result);
      requireThat(Date.parse(plan.expiresAt) > milliseconds, 410, 'INTEGRATION_PLAN_EXPIRED', '接入计划已过期，请重新生成');
      requireThat(plan.clientId === grant.clientId && plan.mode === grant.mode, 403, 'INTEGRATION_SCOPE', '接入计划与授权不匹配');
      const previous = this.target(state, grant.clientId, plan.baseVersion);
      requireThat(grant.mode === 'create' ? !previous : !!previous, 409, 'GRANT_MODE_CONFLICT', '授权类型与目标产品当前状态不一致');
      const config = this.config(plan.after, previous);
      if (grant.domainMode !== 'auto') enforceScope(config, previous, grant.allowedOrigins);
      const addedOrigins = grant.domainMode === 'auto' ? additionalOrigins(config, grant) : [];
      if (grant.domainMode === 'auto') grant.allowedOrigins = origins([...new Set([...grant.allowedOrigins, ...addedOrigins])], 0, 100);
      const updated: ManagedClient = { ...previous, ...config,
        apiSecret: previous?.apiSecret ?? `${randomNonce()}${randomNonce()}`.slice(0, 64),
        webhookSecret: previous?.webhookSecret ?? `${randomNonce()}${randomNonce()}`.slice(0, 64),
      };
      const index = state.clients.findIndex(client => client.id === grant.clientId);
      if (index < 0) state.clients.push(updated); else state.clients[index] = updated;
      const result = { client: publicView(updated), credentials: credentials(updated), appliedAt: new Date(milliseconds).toISOString() };
      plan.result = structuredClone(result);
      grant.appliedPlanId = plan.planId;
      this.note(state, { at: result.appliedAt, actor: `integration:${grant.id}`, action: 'integration.applied', clientId: grant.clientId,
        version: result.client.version, ...(addedOrigins.length ? { addedOrigins } : {}) });
      await this.save(tx, state, milliseconds);
      return result;
    });
  }
}
