// Test-only entry point. It is never imported by the production Worker.
import { createAlipay, type AlipayEnvironment } from '../src/alipay';
import { hmacSha256, randomId, randomNonce, safeEqualHex, sha256 } from '../src/crypto';
import { createPublicKey, createVerify } from 'node:crypto';
import { AlipaySdk } from 'alipay-sdk';

interface RuntimeEnv extends AlipayEnvironment {
  RUNTIME_TOKEN: string;
  QUERY_RESPONSE: string;
  BAD_QUERY_RESPONSE: string;
  CLOSE_RESPONSE: string;
  BAD_CLOSE_RESPONSE: string;
  NOTIFICATION_FORM: string;
  HMAC_SECRET: string;
  HMAC_EXPECTED: string;
  HASH_EXPECTED: string;
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).hostname !== 'runtime.test'
      || request.headers.get('authorization') !== `Bearer ${env.RUNTIME_TOKEN}`) {
      return new Response(null, { status: 404 });
    }
    let phase = 'configuration';
    const diagnostics: Record<string, boolean> = {};
    try {
    const fakeTransport = (raw: string): typeof fetch => (async () => new Response(raw)) as typeof fetch;
    const alipay = createAlipay(env, fakeTransport(env.QUERY_RESPONSE));
    phase = 'payment-url';
    const paymentUrl = alipay.paymentUrl({
      id: 'pay_runtime', subject: 'Runtime verification', totalAmount: '1.00', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }, {
      channel: 'page', pageReturnUrl: 'https://pay.bornforthis.cn/payment/return', notifyUrl: 'https://pay.bornforthis.cn/api/alipay/notify',
    });
    phase = 'native-response-verify';
    const envelope = JSON.parse(env.QUERY_RESPONSE);
    const originalPayload = JSON.stringify(envelope.alipay_trade_query_response, null, 2);
    diagnostics.nativeResponseVerified = createVerify('RSA-SHA256').update(originalPayload, 'utf8').verify(env.ALIPAY_PUBLIC_KEY, envelope.sign, 'base64');
    const normalized = createPublicKey(env.ALIPAY_PUBLIC_KEY).export({ type: 'spki', format: 'pem' }).toString();
    diagnostics.normalizedPublicKeyUnchanged = normalized === env.ALIPAY_PUBLIC_KEY;
    const directSdk = new AlipaySdk({ appId: env.ALIPAY_APP_ID, privateKey: env.ALIPAY_PRIVATE_KEY.trim(), keyType: 'PKCS8', alipayPublicKey: env.ALIPAY_PUBLIC_KEY.trim(), signType: 'RSA2' });
    diagnostics.sdkRawExtractMatches = directSdk.getSignStr(env.QUERY_RESPONSE, 'alipay_trade_query_response') === originalPayload;
    diagnostics.sdkSignTypeMatches = directSdk.config.signType === 'RSA2';
    diagnostics.sdkPublicKeyMatches = directSdk.config.alipayPublicKey.replace(/\s/g, '') === env.ALIPAY_PUBLIC_KEY.replace(/\s/g, '');
    diagnostics.nativeSdkKeyVerified = createVerify('RSA-SHA256').update(originalPayload, 'utf8').verify(directSdk.config.alipayPublicKey, envelope.sign, 'base64');
    try {
      directSdk.checkResponseSign(env.QUERY_RESPONSE, 'alipay_trade_query_response', envelope.sign, '');
      diagnostics.sdkDirectVerified = true;
    } catch (error) {
      diagnostics.sdkDirectVerified = false;
      diagnostics.sdkVerifyTypeError = error instanceof TypeError;
      diagnostics.sdkVerifyReferenceError = error instanceof ReferenceError;
    }
    phase = 'query';
    const query = await alipay.query('pay_runtime');
    phase = 'native-fetch-query';
    const nativeQuery=await createAlipay(env).query('pay_runtime');
    phase = 'close';
    await createAlipay(env, fakeTransport(env.CLOSE_RESPONSE)).close('pay_runtime');
    phase = 'native-fetch-close';
    await createAlipay(env).close('pay_runtime');
    let invalidCloseRejected = false;
    try {
      await createAlipay(env, fakeTransport(env.BAD_CLOSE_RESPONSE)).close('pay_runtime');
    } catch (error) {
      invalidCloseRejected = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ALIPAY_SIGNATURE_INVALID';
    }
    const form = Object.fromEntries(new URLSearchParams(env.NOTIFICATION_FORM));
    let invalidRejected = false;
    try {
      await createAlipay(env, fakeTransport(env.BAD_QUERY_RESPONSE)).query('pay_runtime');
    } catch (error) {
      invalidRejected = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ALIPAY_SIGNATURE_INVALID';
    }
    phase = 'crypto';
    const nonce = randomNonce();
    return Response.json({
      checks: {
        rsa: new URL(paymentUrl).searchParams.get('sign_type') === 'RSA2',
        hmac: safeEqualHex(hmacSha256(env.HMAC_SECRET, 'runtime\n中文 + 100%'), env.HMAC_EXPECTED),
        hash: sha256('runtime\n中文 + 100%') === env.HASH_EXPECTED,
        randomness: /^pay_[a-f0-9]{32}$/.test(randomId('pay_')) && /^[a-f0-9]{48}$/.test(nonce) && nonce !== randomNonce(),
        notification: alipay.verifyNotification(form),
        queryVerified: query?.tradeStatus === 'TRADE_SUCCESS' && query.totalAmount === '1.00' && query.outTradeNo === 'pay_runtime',
        nativeFetchQueryVerified: nativeQuery?.tradeStatus === 'TRADE_SUCCESS' && nativeQuery.totalAmount === '1.00' && nativeQuery.outTradeNo === 'pay_runtime',
        closeVerified: true,
        nativeFetchCloseVerified: true,
        invalidCloseRejected,
        invalidRejected,
        ...diagnostics,
      },
      // Returned only to the local harness for Node-side signature verification.
      // The harness deliberately never prints this URL or any key/fixture bytes.
      paymentUrl,
    });
    } catch (error) {
      return Response.json({ diagnostic: {
        phase,
        errorType: error instanceof Error ? error.name : 'Error',
        errorCode: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'UNKNOWN',
        ...diagnostics,
      } }, { status: 500 });
    }
  },
};
