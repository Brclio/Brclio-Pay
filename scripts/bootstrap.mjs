import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdirSync,existsSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
const dir=resolve('secrets');mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
const privatePath=resolve(dir,'alipay-private.pem');
if(!existsSync(privatePath)) {
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  writeFileSync(privatePath,privateKey,{mode:0o600,flag:'wx'});
  writeFileSync(resolve(dir,'alipay-app-public.pem'),publicKey,{mode:0o600,flag:'wx'});
  writeFileSync(resolve(dir,'alipay-app-public.txt'),publicKey.replace(/-----[^\n]+-----/g,'').replace(/\s/g,''),{mode:0o600,flag:'wx'});
}
if(!existsSync(resolve(dir,'checkout-secret.txt')))writeFileSync(resolve(dir,'checkout-secret.txt'),randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
if(!existsSync(resolve(dir,'clients.json')))writeFileSync(resolve(dir,'clients.json'),'[]\n',{mode:0o600,flag:'wx'});
console.log('Local key/config files are ready under secrets/. Existing keys were preserved. No secrets were printed.');
