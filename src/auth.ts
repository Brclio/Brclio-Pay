import {hmacSha256, sha256, safeEqualHex} from './crypto';
import {clients, requireThat} from './config';
import type {Env, ProductClient} from './types';
export function authenticateHeaders(request:Request,now=Date.now()):void {
  requireThat(/^[a-z0-9][a-z0-9_-]{1,63}$/.test(request.headers.get('X-Brclio-Client') || '') && /^\d{10}$/.test(request.headers.get('X-Brclio-Timestamp') || '') && Math.abs(now/1000-Number(request.headers.get('X-Brclio-Timestamp')))<=300 && /^[A-Za-z0-9_-]{16,80}$/.test(request.headers.get('X-Brclio-Nonce') || '') && /^[a-f0-9]{64}$/i.test(request.headers.get('X-Brclio-Signature') || '') && !new URL(request.url).search,401,'UNAUTHORIZED','请求签名无效或已过期');
}
export function authenticate(request: Request, rawBody: string, env: Env, now = Date.now()): ProductClient {
  authenticateHeaders(request,now);
  const id = request.headers.get('X-Brclio-Client');
  const client = clients(env).find(c => c.id === id);
  const timestamp = request.headers.get('X-Brclio-Timestamp') || '';
  const nonce = request.headers.get('X-Brclio-Nonce') || '';
  const signature = request.headers.get('X-Brclio-Signature') || '';
  const url = new URL(request.url);
  requireThat(client && /^\d{10}$/.test(timestamp) && Math.abs(now / 1000 - Number(timestamp)) <= 300 && /^[A-Za-z0-9_-]{16,80}$/.test(nonce) && !url.search,401,'UNAUTHORIZED','请求签名无效或已过期');
  const canonical = [request.method.toUpperCase(),url.pathname,timestamp,nonce,sha256(rawBody)].join('\n');
  requireThat(safeEqualHex(signature,hmacSha256(client.apiSecret,canonical)),401,'UNAUTHORIZED','请求签名无效或已过期');
  return client;
}
export function checkoutToken(orderId: string, env: Env): string {
  return hmacSha256(env.CHECKOUT_SECRET, 'brclio-checkout-v1:' + orderId);
}
export function authenticateCheckout(request: Request, id: string, env: Env): void {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /,'');
  requireThat(safeEqualHex(token,checkoutToken(id,env)),401,'UNAUTHORIZED','支付链接无效，请从产品重新打开');
  const origin = request.headers.get('Origin');
  requireThat(!origin || [new URL(env.PAY_BASE_URL).origin,...(env.LEGACY_WECHAT_BASE_URL?[new URL(env.LEGACY_WECHAT_BASE_URL).origin]:[])].includes(origin),403,'ORIGIN_NOT_ALLOWED','请求来源无效');
}
