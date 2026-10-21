import {readFileSync,writeFileSync} from 'node:fs';
const required=['GITHUB_TOKEN','ALIPAY_SELLER_ID'];
for(const key of required)if(!process.env[key])throw new Error(`Set ${key} in your local environment first`);
const clients=JSON.parse(readFileSync('secrets/clients.json','utf8'));
const value={GITHUB_TOKEN:process.env.GITHUB_TOKEN,ALIPAY_SELLER_ID:process.env.ALIPAY_SELLER_ID,ALIPAY_PRIVATE_KEY:readFileSync('secrets/alipay-private.pem','utf8'),ALIPAY_PUBLIC_KEY:readFileSync('secrets/alipay-public.pem','utf8'),CHECKOUT_SECRET:readFileSync('secrets/checkout-secret.txt','utf8').trim(),CLIENTS_JSON:JSON.stringify(clients)};
writeFileSync('secrets/worker-secrets.json',JSON.stringify(value),{mode:0o600});
console.log('Prepared secrets/worker-secrets.json. Publish with: npx wrangler secret bulk secrets/worker-secrets.json');
