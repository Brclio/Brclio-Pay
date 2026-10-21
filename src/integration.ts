import type { Store } from './types';
import { HttpError, requireThat } from './config';
import { Registry, type PlanInput, type RegistryEnvironment } from './registry';
import { skillMarkdown, skillZip, type SkillVariant } from './skill';

const MAX_BODY_BYTES = 32 * 1024;
async function body(request: Request): Promise<unknown> {
  requireThat(/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''), 415, 'JSON_REQUIRED', '请使用 application/json');
  const length = Number(request.headers.get('content-length'));
  requireThat(!Number.isFinite(length) || length <= MAX_BODY_BYTES, 413, 'BODY_TOO_LARGE', '请求不能超过 32 KiB');
  const reader = request.body?.getReader();
  requireThat(reader, 400, 'INVALID_JSON', '需要 JSON 请求内容');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'BODY_TOO_LARGE', '请求不能超过 32 KiB');
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch { throw new HttpError(400, 'INVALID_JSON', 'JSON 请求内容无效'); }
}
function json(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } });
}

/** Root applies its common security headers and HttpError handler to this response. */
export async function handleIntegration(request: Request, env: RegistryEnvironment, store: Store): Promise<Response> {
  const url = new URL(request.url);
  requireThat(!url.search, 400, 'QUERY_NOT_ALLOWED', '接入 API 不接受 URL 查询参数');
  const match = /^\/api\/integration\/v1\/(context|plan|apply|skill|skill\.zip)$/.exec(url.pathname);
  requireThat(match, 404, 'NOT_FOUND', '接入接口不存在');
  const operation = match[1];
  const variant=(request.headers.get('X-Brclio-Skill') || 'brclio-pay-integrate') as SkillVariant;
  requireThat(['brclio-pay-integrate','brclio-alipay-integrate','brclio-wechatpay-integrate'].includes(variant),400,'INVALID_SKILL','Skill 类型无效');
  const isRead = operation === 'context' || operation === 'skill' || operation === 'skill.zip';
  requireThat(request.method === (isRead ? 'GET' : 'POST'), 405, 'METHOD_NOT_ALLOWED', '请求方法无效');
  const authorization = /^Bearer (brp_int_[a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
  requireThat(authorization, 401, 'INVALID_INTEGRATION_GRANT', '需要有效的接入授权');
  const registry = new Registry(env, store);
  if (operation === 'context') return json(await registry.grantContext(authorization[1]));
  if (operation === 'skill' || operation === 'skill.zip') {
    await registry.grantContext(authorization[1]);
    if (operation === 'skill') return json({ content: skillMarkdown(variant) });
    return new Response(skillZip(variant) as BodyInit, { headers: {
      'content-type': 'application/zip', 'content-disposition': `attachment; filename="${variant}.zip"`,
      'cache-control': 'no-store', pragma: 'no-cache',
    } });
  }
  const input = await body(request);
  if (operation === 'plan') return json(await registry.plan(authorization[1], input as PlanInput));
  return json(await registry.apply(authorization[1], input as { planId: string }));
}
