import {createHmac,createHash,randomBytes,timingSafeEqual} from 'node:crypto';
const hmac=(secret,value)=>createHmac('sha256',secret).update(value,'utf8').digest('hex');
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');

/** SERVER ONLY. Never bundle this module or its secrets into a browser/desktop/Android app. */
export function createPaymentClient({baseUrl='https://pay.bornforthis.cn',clientId,apiSecret,fetcher=fetch}) {
  if(!clientId || typeof apiSecret!=='string' || apiSecret.length<32)throw new Error('Payment client credentials required');
  async function call(method,path,value) {
    const body=value===undefined?'':JSON.stringify(value);
    const timestamp=String(Math.floor(Date.now()/1000));const nonce=randomBytes(24).toString('hex');
    const signature=hmac(apiSecret,[method,path,timestamp,nonce,hash(body)].join('\n'));
    const response=await fetcher(new URL(path,baseUrl),{method,redirect:'manual',signal:AbortSignal.timeout(30_000),headers:{'Content-Type':'application/json','X-Brclio-Client':clientId,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Signature':signature},...(body?{body}:{})});
    const result=await response.json();
    if(!response.ok) {
      const error=new Error(result.error?.message || `Payment API HTTP ${response.status}`);
      error.code=typeof result.error?.code==='string' && /^[A-Z_]{1,80}$/.test(result.error.code)?result.error.code:'PAYMENT_API_ERROR';
      error.status=response.status;
      throw error;
    }
    return result;
  }
  function checkedId(id){if(!/^pay_[a-f0-9]{32}$/.test(id))throw new Error('Invalid payment order ID');return id;}
  return {
    // Read through the product backend; do not cache indefinitely in a frontend or build.
    // acceptingPayments=false pauses new purchases; keep catalog prices and existing order/status flows.
    catalog:()=>call('GET','/api/v1/catalog'),
    // First payment window is 10 minutes. Idempotent retries never reopen orders;
    // a normal repurchase needs a NEW productOrderId. An administrator may reopen
    // the same logical order with a new attempt; read the current expiresAt.
    createOrder:({productOrderId,sku,returnUrl,provider})=>{
      if(provider!==undefined && !['alipay','wechat'].includes(provider))throw new Error('Invalid payment provider');
      return call('POST','/api/v1/orders',{productOrderId,sku,returnUrl,...(provider?{provider}:{})});
    },
    getOrder:id=>call('GET',`/api/v1/orders/${checkedId(id)}`),
    refreshOrder:id=>call('POST',`/api/v1/orders/${checkedId(id)}/refresh`,{})
  };
}

/** Verify the ORIGINAL request body before parsing. Idempotent entitlement write must happen separately. */
export function verifyPaymentEvent({rawBody,headers,webhookSecret,clientId,mode='live',now=Date.now()}) {
  if(typeof webhookSecret!=='string' || webhookSecret.length<32 || Buffer.byteLength(rawBody)>16_384)throw new Error('Invalid webhook configuration/body');
  const timestamp=headers.get('X-Brclio-Timestamp') || '';
  const signature=headers.get('X-Brclio-Signature') || '';
  if(!/^\d{10}$/.test(timestamp) || Math.abs(now/1000-Number(timestamp))>300 || !/^[a-f0-9]{64}$/i.test(signature))throw new Error('Expired or malformed webhook');
  const expected=hmac(webhookSecret,timestamp+'.'+rawBody);
  if(!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(signature,'hex')))throw new Error('Webhook signature invalid');
  const event=JSON.parse(rawBody);
  if(event.type!=='payment.paid' || event.mode!==mode || event.id!==headers.get('X-Brclio-Event') || event.id!==`evt_${event.data?.orderId}` || !/^pay_[a-f0-9]{32}$/.test(event.data.orderId) || event.data.clientId!==clientId || event.data.currency!=='CNY' || !/^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(event.data.amount) || event.data.amount==='0.00' || !/^\d{10,64}$/.test(event.data.tradeNo))throw new Error('Webhook event invalid');
  // Legacy Alipay events have no provider. Validate an explicit provider when supplied.
  if(event.data.provider!==undefined && !['alipay','wechat'].includes(event.data.provider))throw new Error('Webhook provider invalid');
  return event;
}
