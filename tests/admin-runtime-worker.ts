// Test-only worker. All authentication secrets are ephemeral harness bindings.
import { adminLogin, adminLogout, adminSession, requireAdminMutation } from '../src/admin-auth';
import { HttpError } from '../src/config';
import type { Env } from '../src/types';

interface TestBindings {
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD_HASH: string;
  ADMIN_PASSWORD_PEPPER: string;
  ADMIN_SESSION_SECRET: string;
  TEST_PASSWORD: string;
  RUNTIME_TEST_TOKEN: string;
}
async function rejectsWith(action: () => unknown | Promise<unknown>, status: number): Promise<boolean> {
  try { await action(); return false; }
  catch (error) { return error instanceof HttpError && error.status === status; }
}

export default {
  async fetch(request: Request, bindings: TestBindings): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).hostname !== 'admin-runtime.test'
      || request.headers.get('authorization') !== `Bearer ${bindings.RUNTIME_TEST_TOKEN}`) {
      return new Response(null, { status: 404 });
    }
    const base = 'https://pay.bornforthis.cn';
    const rateKeys: string[] = [];
    const env = {
      ...bindings,
      PAY_BASE_URL: base,
      ADMIN_LOGIN_LIMITER: { limit: async ({ key }: { key: string }) => { rateKeys.push(key); return { success: true }; } },
    } as unknown as Env;
    const loginRequest = (origin = base) => new Request(`${base}/api/admin/login`, {
      method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': origin === base ? 'same-origin' : 'cross-site', 'CF-Connecting-IP': '192.0.2.1' },
    });
    const response = await adminLogin(loginRequest(), env, { email: bindings.ADMIN_EMAIL, password: bindings.TEST_PASSWORD });
    const header = response.headers.get('Set-Cookie') ?? '';
    const cookie = header.split(';')[0];
    const payload = await response.json() as { csrfToken: string; user: { email: string } };
    const sessionRequest = new Request(`${base}/api/admin/session`, { headers: { Cookie: cookie } });
    const identity = adminSession(sessionRequest, env);
    const last = cookie.slice(-1);
    const tampered = `${cookie.slice(0, -1)}${last === '0' ? '1' : '0'}`;
    const mutationRequest = (csrf?: string, origin = base) => new Request(`${base}/api/admin/clients`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    });
    let correctCsrf = true;
    try { requireAdminMutation(mutationRequest(payload.csrfToken), env, identity); } catch { correctCsrf = false; }
    const alteredHash = `${bindings.ADMIN_PASSWORD_HASH.slice(0, -1)}${bindings.ADMIN_PASSWORD_HASH.endsWith('0') ? '1' : '0'}`;
    const logout = adminLogout().headers.get('Set-Cookie') ?? '';
    return Response.json({
      passwordLogin: response.status === 200 && payload.user.email === bindings.ADMIN_EMAIL,
      secureCookie: header.startsWith('__Host-brclio_admin=') && /; HttpOnly(?:;|$)/.test(header)
        && /; Secure(?:;|$)/.test(header) && /; SameSite=Strict(?:;|$)/.test(header) && !/; Domain=/i.test(header),
      sessionVerified: identity.email === bindings.ADMIN_EMAIL && identity.csrfToken === payload.csrfToken,
      wrongPasswordRejected: await rejectsWith(() => adminLogin(loginRequest(), env, { email: bindings.ADMIN_EMAIL, password: `${bindings.TEST_PASSWORD}-wrong` }), 401),
      unknownAccountRejected: await rejectsWith(() => adminLogin(loginRequest(), env, { email: 'unknown@example.com', password: bindings.TEST_PASSWORD }), 401),
      foreignOriginRejected: await rejectsWith(() => adminLogin(loginRequest('https://foreign.example'), env, { email: bindings.ADMIN_EMAIL, password: bindings.TEST_PASSWORD }), 403),
      rateLimitRejected: await rejectsWith(() => adminLogin(loginRequest(), { ...env, ADMIN_LOGIN_LIMITER: { limit: async () => ({ success: false }) } }, { email: bindings.ADMIN_EMAIL, password: bindings.TEST_PASSWORD }), 429),
      missingLimiterRejected: await rejectsWith(() => adminLogin(loginRequest(), { ...env, ADMIN_LOGIN_LIMITER: undefined }, { email: bindings.ADMIN_EMAIL, password: bindings.TEST_PASSWORD }), 503),
      rateKeysProtected: rateKeys.length === 3 && rateKeys.every(key => /^[a-f0-9]{64}$/.test(key)) && new Set(rateKeys).size === 1,
      tamperedSessionRejected: await rejectsWith(() => adminSession(new Request(`${base}/api/admin/session`, { headers: { Cookie: tampered } }), env), 401),
      expiredSessionRejected: await rejectsWith(() => adminSession(sessionRequest, env, Date.now() + 8 * 3600_000), 401),
      missingCsrfRejected: await rejectsWith(() => requireAdminMutation(mutationRequest(), env, identity), 403),
      wrongCsrfRejected: await rejectsWith(() => requireAdminMutation(mutationRequest('0'.repeat(64)), env, identity), 403),
      foreignMutationRejected: await rejectsWith(() => requireAdminMutation(mutationRequest(payload.csrfToken, 'https://foreign.example'), env, identity), 403),
      correctCsrf,
      passwordChangeInvalidatesSession: await rejectsWith(() => adminSession(sessionRequest, { ...env, ADMIN_PASSWORD_HASH: alteredHash }), 401),
      logoutExpiresCookie: /; Max-Age=0(?:;|$)/.test(logout) && /; HttpOnly(?:;|$)/.test(logout)
        && /; Secure(?:;|$)/.test(logout) && /; SameSite=Strict(?:;|$)/.test(logout),
    });
  },
};
