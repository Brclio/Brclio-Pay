// Credentials arrive via stdin and are never printed or saved in plaintext.
import {readFileSync,writeFileSync,existsSync,mkdirSync,chmodSync} from 'node:fs';
import {createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
let input;try{input=JSON.parse(readFileSync(0,'utf8'));}catch{throw new Error('Provide JSON {email,password} on standard input');}
if(typeof input.email!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || typeof input.password!=='string' || input.password.length<12 || input.password.length>1024)throw new Error('Valid account and a password of 12-1024 characters required');
mkdirSync('secrets',{recursive:true,mode:0o700});chmodSync('secrets',0o700);
const path='secrets/admin-worker-secrets.json';
const previous=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
const pepper=previous.ADMIN_PASSWORD_PEPPER || randomBytes(32).toString('hex');
const salt=randomBytes(32).toString('hex');
const material=createHmac('sha256',pepper).update(input.password,'utf8').digest('hex');
const hash=pbkdf2Sync(material,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex');
const data={ADMIN_EMAIL:input.email.trim().toLowerCase(),ADMIN_PASSWORD_HASH:`pbkdf2-sha256$100000$${salt}$${hash}`,ADMIN_PASSWORD_PEPPER:pepper,ADMIN_SESSION_SECRET:previous.ADMIN_SESSION_SECRET || randomBytes(32).toString('hex'),REGISTRY_ENCRYPTION_KEY:previous.REGISTRY_ENCRYPTION_KEY || randomBytes(32).toString('hex')};
writeFileSync(path,JSON.stringify(data),{mode:0o600});chmodSync(path,0o600);
console.log('Prepared hashed admin credentials and encryption keys in the ignored secrets directory. No password was stored.');
