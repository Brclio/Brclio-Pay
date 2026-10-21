import type {Env, ProductClient} from './types';
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function requireThat(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new HttpError(status, code, message);
}
export function money(value: unknown): string {
  requireThat(typeof value === 'string' && /^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(value) && value !== '0.00', 400, 'INVALID_AMOUNT', '金额必须是大于零且保留两位小数的人民币金额');
  return value;
}
export function httpsUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, 'INVALID_URL', '地址格式错误'); }
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 400, 'INVALID_URL', '地址必须使用 HTTPS，且不能包含账号或 fragment');
  return url;
}
export function allowedReturn(value: string, origins: string[]): string {
  const url = httpsUrl(value);
  const allowed = origins.some(origin => {
    if (!origin.includes('*')) return url.origin === httpsUrl(origin).origin;
    const match = /^https:\/\/\*\.([a-z0-9.-]+)$/.exec(origin);
    return !!match && url.port === '' && url.hostname.endsWith('.' + match[1]) && url.hostname !== match[1];
  });
  requireThat(allowed, 400, 'RETURN_URL_NOT_ALLOWED', '返回地址不在产品白名单内');
  return url.toString();
}
export function clients(env: Env): ProductClient[] {
  let data: unknown;
  try { data = JSON.parse(env.CLIENTS_JSON || '[]'); } catch { throw new HttpError(503, 'CONFIGURATION', '支付服务配置未完成'); }
  requireThat(Array.isArray(data), 503, 'CONFIGURATION', '支付服务配置未完成');
  const ids = new Set();
  for (const c of data as ProductClient[]) {
    requireThat(c && typeof c.id==='string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(c.id) && !ids.has(c.id) && typeof c.name === 'string' && c.name.length > 0 && c.name.length <= 80 && typeof c.apiSecret==='string' && c.apiSecret.length >= 32 && typeof c.webhookSecret==='string' && c.webhookSecret.length >= 32 && typeof c.webhookUrl==='string' && Array.isArray(c.returnOrigins) && c.returnOrigins.length > 0 && c.skus && typeof c.skus === 'object' && !Array.isArray(c.skus) && Object.keys(c.skus).length>0, 503, 'CONFIGURATION', '产品配置无效');
    requireThat(c.providers===undefined || (Array.isArray(c.providers)&&c.providers.length>0&&c.providers.length<=2&&new Set(c.providers).size===c.providers.length&&c.providers.every(p=>['alipay','wechat'].includes(p))),503,'CONFIGURATION','支付渠道配置无效');
    requireThat(c.webhookProtocol===undefined || ['brclio-v1','wechat-legacy-v1'].includes(c.webhookProtocol),503,'CONFIGURATION','通知协议配置无效');
    ids.add(c.id);
    const webhook = httpsUrl(c.webhookUrl);
    requireThat(!webhook.search && !/^(localhost|.*\.localhost|.*\.local)$/.test(webhook.hostname) && !/^[\d.]+$/.test(webhook.hostname) && !webhook.hostname.includes(':'),503,'CONFIGURATION','回调地址需要公网 HTTPS 域名');
    for (const [sku, item] of Object.entries(c.skus)) {
      requireThat(item && /^[a-zA-Z0-9_-]{1,80}$/.test(sku) && typeof item.subject === 'string' && item.subject.length > 0 && item.subject.length <= 120,503,'CONFIGURATION','商品配置无效');
      money(item.amount);
      requireThat(item.enabled === undefined || typeof item.enabled === 'boolean',503,'CONFIGURATION','商品启用状态配置无效');
      for (const [value, maximum] of [[item.description, 500], [item.entitlement, 1000]] as const) {
        requireThat(value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= maximum
          && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)),503,'CONFIGURATION','商品说明或权益配置无效');
      }
    }
    for (const origin of c.returnOrigins) {
      requireThat(typeof origin === 'string' && (/^https:\/\/\*\.[a-z0-9.-]+$/.test(origin) || httpsUrl(origin).origin === origin),503,'CONFIGURATION','返回域名配置无效');
    }
  }
  return data as ProductClient[];
}
export function configurationReady(env: Env): boolean {
  return [(env.GITHUB_TOKEN || (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY)),env.GITHUB_REPOSITORY,env.CHECKOUT_SECRET,env.ALIPAY_APP_ID,env.ALIPAY_PRIVATE_KEY,env.ALIPAY_PUBLIC_KEY,env.ALIPAY_SELLER_ID].every(Boolean) && env.CHECKOUT_SECRET.length >= 32 && clients(env).length > 0;
}
export function requireReady(env: Env, acceptingPayments = false): void {
  requireThat(configurationReady(env),503,'NOT_READY','支付服务尚未完成配置');
  if (acceptingPayments) requireThat(env.PAYMENT_ENABLED === 'true',503,'PAYMENTS_DISABLED','收款尚未启用');
  const base = httpsUrl(env.PAY_BASE_URL);
  requireThat(base.pathname === '/' && !base.search,503,'CONFIGURATION','支付域名配置无效');
  requireThat(['live','sandbox'].includes(env.PAYMENT_MODE),503,'CONFIGURATION','支付环境配置无效');
  const sandbox = env.ALIPAY_GATEWAY?.includes('alipaydev.com') || env.ALIPAY_GATEWAY?.includes('openapi-sandbox');
  requireThat(env.PAYMENT_MODE !== 'sandbox' || !!sandbox,503,'CONFIGURATION','沙箱必须使用沙箱网关与沙箱应用');
  requireThat(env.PAYMENT_MODE !== 'live' || !sandbox,503,'CONFIGURATION','生产环境不能使用沙箱网关');
}
