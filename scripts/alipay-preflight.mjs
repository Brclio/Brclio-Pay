// Read-only production query. Does not create a transaction or move money.
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fetch,ProxyAgent} from 'undici';
await build({entryPoints:['src/alipay.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist/alipay-preflight.cjs',logLevel:'silent'});
const {createAlipay}=createRequire(import.meta.url)('../dist/alipay-preflight.cjs');
const proxy=process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher=proxy?new ProxyAgent(proxy):undefined;
let providerCode;
const adapter=createAlipay({
  ALIPAY_APP_ID:'2021007109602288',
  ALIPAY_PRIVATE_KEY:readFileSync('secrets/alipay-private.pem','utf8'),
  ALIPAY_PUBLIC_KEY:readFileSync('secrets/alipay-public.pem','utf8'),
  ALIPAY_SELLER_ID:readFileSync('secrets/alipay-seller-id.txt','utf8').trim(),
  PAYMENT_MODE:'live'
},async(url,options)=>{
  const response=await fetch(url,{...options,dispatcher});
  const body=await response.clone().json();
  const data=body.alipay_trade_query_response || body.error_response;
  if(typeof data?.sub_code==='string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(data.sub_code))providerCode=data.sub_code;
  return response;
});
try {
  const result=await adapter.query('pay_diagnostic_no_transaction_20261013');
  console.log(JSON.stringify({signatureVerified:true,queryAvailable:true,expectedNoTransaction:result===null,providerCode}));
} catch(error) {
  console.log(JSON.stringify({signatureVerified:error.code==='ALIPAY_QUERY_REJECTED',queryAvailable:false,code:error.code || 'PROVIDER_OR_NETWORK_ERROR',...(error.code==='ALIPAY_QUERY_REJECTED'?{providerCode}:{})}));
  process.exitCode=1;
} finally {await dispatcher?.close();}
