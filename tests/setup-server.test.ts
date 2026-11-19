import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createHmac,generateKeyPairSync,pbkdf2Sync} from 'node:crypto';
import {mkdtemp,mkdir,readFile,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {SQLiteStore} from '../server/sqlite-store';

const source=()=>import(new URL('../scripts/setup-server.mjs',import.meta.url).href);
let root:string,privateKey:string,publicKey:string,sequence=0;
beforeAll(async()=>{
  root=await realpath(await mkdtemp(resolve(tmpdir(),'brclio-server-setup-')));
  const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}});privateKey=keys.privateKey;publicKey=keys.publicKey;
  await mkdir(resolve(root,'merchant'));
  await writeFile(resolve(root,'merchant/private.pem'),privateKey);await writeFile(resolve(root,'merchant/public.pem'),publicKey);await writeFile(resolve(root,'merchant/api-v3.txt'),'v'.repeat(32)+'\n');await writeFile(resolve(root,'merchant/password.txt'),'a supplied secure password\n');
});
afterAll(async()=>{await rm(root,{recursive:true,force:true});});
function input(mode='dual'):any{return {providerMode:mode,baseUrl:'https://pay.example.com',admin:{email:'owner@example.com'},...(mode!=='wechat'?{alipay:{appId:'2021007109602288',sellerId:'2088123456789012',privateKeyFile:'merchant/private.pem',publicKeyFile:'merchant/public.pem'}}:{}),...(mode!=='alipay'?{wechat:{merchantId:'1234567890',appId:'wx0123456789abcdef',serialNo:'A'.repeat(40),privateKeyFile:'merchant/private.pem',apiV3KeyFile:'merchant/api-v3.txt',publicKeyId:'PUB_KEY_ID_fixture',publicKeyFile:'merchant/public.pem'}}:{})};}
const output=()=>`secrets/installation-${++sequence}`;

describe('independent SQLite server setup',()=>{
  it.each(['dual','alipay','wechat'])('initializes %s without Cloudflare/GitHub, persists all configuration privately and leaves payments disabled',async mode=>{
    const {prepareServer}=await source(),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('offline'));
    const result=await prepareServer(input(mode),{root,output:output()});
    const store=new SQLiteStore(result.database),data=store.exportSnapshot(),config=data.runtimeConfig;store.close();
    expect(config).toMatchObject({STORAGE_BACKEND:'sqlite',PAYMENT_ENABLED:'false',REGISTRY_STORAGE_MODE:'plain',CLIENTS_JSON:'[]'});expect(Object.keys(config).some(name=>name.startsWith('GITHUB_'))).toBe(false);
    expect(config.ALIPAY_CHANNELS).toBe(mode==='wechat'?'':'page,wap');expect(config.WECHAT_CHANNELS).toBe(mode==='alipay'?'':'native');
    expect(config.CHECKOUT_SECRET).toMatch(/^[a-f0-9]{64}$/);expect(config.ADMIN_SESSION_SECRET).not.toBe(config.CHECKOUT_SECRET);
    expect(data.documents.map(row=>row.path)).toEqual(['maintenance/environment/guide.json']);expect(data.documents[0].content).toContain('SQLite');expect(data.documents[0].content).not.toContain(config.CHECKOUT_SECRET);expect(data.documents[0].content).not.toContain(privateKey);
    const admin=JSON.parse(await readFile(resolve(result.output,'admin-login.json'),'utf8'));
    const [,iterations,salt,expected]=config.ADMIN_PASSWORD_HASH.split('$'),material=createHmac('sha256',config.ADMIN_PASSWORD_PEPPER).update(admin.password).digest('hex');
    expect(pbkdf2Sync(material,Buffer.from(salt,'hex'),Number(iterations),32,'sha256').toString('hex')).toBe(expected);
    expect((await stat(result.output)).mode&0o777).toBe(0o700);for(const file of ['brclio-pay.sqlite','admin-login.json','setup-receipt.json'])expect((await stat(resolve(result.output,file))).mode&0o777).toBe(0o600);
    expect(network).not.toHaveBeenCalled();network.mockRestore();
  });
  it('never overwrites an existing installation or emits provided administrator passwords into recovery files',async()=>{
    const {prepareServer}=await source(),fixture=input('alipay');fixture.admin.passwordFile='merchant/password.txt';const directory=output();
    const first=await prepareServer(fixture,{root,output:directory}),before=await readFile(first.database);
    await expect(prepareServer(fixture,{root,output:directory})).rejects.toThrow('SETUP_OUTPUT_ALREADY_EXISTS_NO_OVERWRITE');expect(await readFile(first.database)).toEqual(before);
    const admin=JSON.parse(await readFile(resolve(first.output,'admin-login.json'),'utf8'));expect(admin).not.toHaveProperty('password');expect(JSON.stringify(admin)).not.toContain('a supplied secure password');
  });
  it('rejects provider confusion, invalid merchant identifiers and unknown infrastructure fields',async()=>{
    const {validateServerInput}=await source();
    expect(()=>validateServerInput({...input('alipay'),wechat:input().wechat})).toThrow('UNSELECTED_WECHAT_INPUT');
    expect(()=>validateServerInput({...input('wechat'),alipay:input().alipay})).toThrow('UNSELECTED_ALIPAY_INPUT');
    const bad=input();bad.wechat.merchantId='not-merchant';expect(()=>validateServerInput(bad)).toThrow('INVALID_WECHAT_MERCHANT_ID');
    expect(()=>validateServerInput({...input(),cloudflare:{accountId:'fake'}})).toThrow('INVALID_SETUP_FIELDS');
    expect(()=>validateServerInput({...input(),baseUrl:'http://pay.example.com'})).toThrow('INVALID_PAY_BASE_URL');
    const duplicate=input();duplicate.alipay.channels=['page','page'];expect(()=>validateServerInput(duplicate)).toThrow('INVALID_ALIPAY_CHANNELS');
  });
  it('rejects a source output directory and a symlink into unignored source, and validates files before creating output',async()=>{
    const {prepareServer}=await source();await mkdir(resolve(root,'public'));await mkdir(resolve(root,'secrets'),{recursive:true});await symlink(resolve(root,'public'),resolve(root,'secrets/redirect'));
    await expect(prepareServer(input('alipay'),{root,output:'public/private-data'})).rejects.toThrow('OUTPUT_MUST_BE_UNDER_SECRETS_OR_ABSOLUTE_EXTERNAL');
    await expect(prepareServer(input('alipay'),{root,output:'secrets/redirect/private-data'})).rejects.toThrow('OUTPUT_MUST_BE_UNDER_SECRETS_OR_ABSOLUTE_EXTERNAL');
    const missing=input('alipay');missing.alipay.privateKeyFile='missing.pem';const destination=output();await expect(prepareServer(missing,{root,output:destination})).rejects.toThrow('INPUT_FILE_UNAVAILABLE');await expect(stat(resolve(root,destination))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('updates only reviewed fields at the expected revision and preserves unrelated credentials',async()=>{
    const {prepareServer,inspectServer,updateServerConfig}=await source(),result=await prepareServer(input(),{root,output:output()});
    const before=new SQLiteStore(result.database),snapshot=before.exportSnapshot();before.close();
    const inspection=await inspectServer(result.database);expect(inspection.revision).toBe(snapshot.revision);expect(JSON.stringify(inspection)).not.toContain(snapshot.runtimeConfig.CHECKOUT_SECRET);
    const changed=await updateServerConfig(result.database,{values:{PAYMENT_ENABLED:'true'}},snapshot.revision);expect(changed).toMatchObject({updated:true,changedNames:['PAYMENT_ENABLED'],restartRequired:true});
    const after=new SQLiteStore(result.database),current=after.exportSnapshot();after.close();expect(current.runtimeConfig).toEqual({...snapshot.runtimeConfig,PAYMENT_ENABLED:'true'});expect(current.documents).toEqual(snapshot.documents);
    await expect(updateServerConfig(result.database,{values:{PAYMENT_ENABLED:'false'}},snapshot.revision)).rejects.toMatchObject({code:'STORAGE_CONFLICT'});
    await expect(updateServerConfig(result.database,{values:{GITHUB_TOKEN:'forbidden'}},current.revision)).rejects.toThrow('INVALID_CONFIG_UPDATE');
    await expect(updateServerConfig(result.database,{values:{CHECKOUT_SECRET:''}},current.revision)).rejects.toThrow('INVALID_RUNTIME_CONFIG');
    await expect(updateServerConfig(result.database,{values:{CLIENTS_JSON:'[{}]'}},current.revision)).rejects.toMatchObject({code:'CONFIGURATION'});
  });
  it('keeps configuration updates and inspection from silently creating a missing database',async()=>{
    const {inspectServer,updateServerConfig}=await source(),missing=resolve(root,'absent.sqlite');
    await expect(inspectServer(missing)).rejects.toThrow('EXISTING_DATABASE_REQUIRED');await expect(updateServerConfig(missing,{values:{PAYMENT_ENABLED:'false'}},'sqlite:0')).rejects.toThrow('EXISTING_DATABASE_REQUIRED');await expect(stat(missing)).rejects.toMatchObject({code:'ENOENT'});
  });
  it('prints only paths and nonsecret receipts from the CLI',async()=>{
    const {main}=await source(),filename=resolve(root,'server-input.json'),directory=resolve(root,output());await writeFile(filename,JSON.stringify(input('alipay')));
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});
    try{await main(['--input',filename,'--output',directory]);const emitted=log.mock.calls.map(call=>call.join(' ')).join('\n');expect(JSON.parse(emitted)).toMatchObject({prepared:true,paymentEnabled:false});const store=new SQLiteStore(resolve(directory,'brclio-pay.sqlite')),config=store.readRuntimeConfig();store.close();expect(emitted).not.toContain(config.CHECKOUT_SECRET);expect(emitted).not.toContain(config.ADMIN_PASSWORD_HASH);expect(emitted).not.toContain(privateKey);}finally{log.mockRestore();}
  });
});
