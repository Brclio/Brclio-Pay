import {resolve,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteStore} from './sqlite-store';
import {staticAssets} from './assets';
import {createPaymentServer,rateLimiter} from './runtime';
import type {Env} from '../src/types';

process.umask(0o077);
const version=process.versions.node.split('.').map(Number);
if(version[0]<22||(version[0]===22&&version[1]<13))throw new Error('Node.js 22.13 or newer is required');
const database=process.env.PAY_DATABASE_PATH||'/www/server/brclio-pay/data/brclio-pay.sqlite';
if(!isAbsolute(database))throw new Error('PAY_DATABASE_PATH must be absolute');
const port=Number(process.env.PORT||3187);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid listen port');
const store=new SQLiteStore(database);
const stored=store.readRuntimeConfig();
if(!stored.PAY_BASE_URL){store.close();throw new Error('SQLite runtime configuration is missing');}
const env={...stored,STORAGE_BACKEND:'sqlite',STORAGE:store,ASSETS:staticAssets(process.env.PAY_ASSETS_PATH||resolve(dirname(fileURLToPath(import.meta.url)),'public')),ADMIN_LOGIN_LIMITER:rateLimiter(5),INTEGRATION_LIMITER:rateLimiter(30),PAYMENT_API_LIMITER:rateLimiter(120)} as unknown as Env;
const runtime=createPaymentServer({env,maintenance:process.env.SERVER_MAINTENANCE!=='false'});
runtime.server.listen(port,'127.0.0.1',()=>console.log('brclio_pay_server_ready'));
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;try{await runtime.close();store.close();process.exitCode=0;}catch{console.error('shutdown_failed');process.exitCode=1;}}
process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
runtime.server.on('error',()=>{console.error('server_failed');void shutdown();});
