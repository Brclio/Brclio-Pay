import {it,expect} from 'vitest';
import {handle} from '../src/index';
import {hmacSha256} from '../src/crypto';
import {checkoutToken,authenticateCheckout} from '../src/auth';
import type {Env} from '../src/types';
const env={PAY_BASE_URL:'https://pay.bornforthis.cn',LEGACY_WECHAT_BASE_URL:'https://paywc.bornforthis.cn',CHECKOUT_SECRET:'new'.repeat(24),LEGACY_WECHAT_CHECKOUT_SECRET:'old'.repeat(24)} as Env;
const id='a'.repeat(32),url=`https://paywc.bornforthis.cn/api/legacy/wechat/checkout/${id}/exchange`,ctx={waitUntil(){}} as unknown as ExecutionContext;
it('exchanges authenticated historical checkout without a GitHub read and trusts only configured cashier origins',async()=>{
 const response=await handle(new Request(url,{headers:{Authorization:'Bearer '+hmacSha256(env.LEGACY_WECHAT_CHECKOUT_SECRET!,'checkout:v1:'+id)}}),env,ctx);
 expect(response.status).toBe(200);const body=await response.json() as {checkoutUrl:string};
 expect(body.checkoutUrl).toBe(`https://paywc.bornforthis.cn/checkout/pay_${id}#token=${checkoutToken('pay_'+id,env)}`);
 expect(()=>authenticateCheckout(new Request('https://paywc.bornforthis.cn/api/checkout/pay_'+id,{headers:{Origin:'https://paywc.bornforthis.cn',Authorization:'Bearer '+checkoutToken('pay_'+id,env)}}),'pay_'+id,env)).not.toThrow();
 expect(()=>authenticateCheckout(new Request('https://paywc.bornforthis.cn/api/checkout/pay_'+id,{headers:{Origin:'https://evil.example',Authorization:'Bearer '+checkoutToken('pay_'+id,env)}}),'pay_'+id,env)).toThrow();
});
it('rejects invalid legacy credentials and malformed signatures before any storage access',async()=>{
 expect((await handle(new Request(url,{headers:{Authorization:'Bearer '+'0'.repeat(64)}}),env,ctx)).status).toBe(401);
 expect((await handle(new Request('https://paywc.bornforthis.cn/api/v1/orders',{method:'POST',headers:{'X-Brclio-Client':'x'}}),env,ctx)).status).toBe(401);
});
