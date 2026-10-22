'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{prepareSigning,ROOT}=require('./signing.cjs');
(async()=>{
 const arch=process.argv[2];if(!['arm64','x64'].includes(arch))throw Error('Usage: node mac/build.cjs arm64|x64 [--dir]');if(process.argv.slice(3).some(a=>a!=='--dir'))throw Error('Unknown Mac build option');
 const project=path.join(ROOT,'clients/desktop'),pkg=JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8')),state=await prepareSigning(),output=path.resolve(project,pkg.build.directories.output),app=path.join(output,arch==='arm64'?'mac-arm64':'mac','Brclio Pay.app'),assets=path.join(__dirname,'.generated',`${pkg.version}-${arch}`);
 const contents=[{x:150,y:155,type:'file',path:app},{x:420,y:155,type:'file',path:path.join(assets,'安装 Brclio Pay.command')},{x:280,y:320,type:'file',path:path.join(assets,'安装说明.txt')},...['.brclio-install-manifest.tsv','.brclio-install-manifest.sig','.brclio-update-public-key.pem'].map(name=>({x:0,y:0,type:'file',path:path.join(assets,name)}))];
 const config={...pkg.build,extends:null,afterSign:path.join(__dirname,'after-sign.cjs'),mac:{...pkg.build.mac,identity:'-'},dmg:{...pkg.build.dmg,sign:false,title:`Brclio Pay ${pkg.version}`,contents,window:{width:580,height:420}}};
 const configPath=path.join(state.directory,`builder-${arch}.json`);await fs.writeFile(configPath,JSON.stringify(config),{mode:0o600});
 const env={...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'};delete env.CSC_LINK;delete env.CSC_KEY_PASSWORD;
 const args=['--config',configPath,'--mac',`--${arch}`,'--publish','never'];if(process.argv.includes('--dir'))args.push('--dir');
 const child=spawn(path.join(project,'node_modules/.bin/electron-builder'),args,{cwd:project,env,stdio:'inherit'}),code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});if(code!==0)throw Error('Mac packaging failed');
 console.log(JSON.stringify({macSelfSigned:true,version:pkg.version,arch,certificateSha256:state.certificateSha256,notarized:false,systemTrustChanged:false,installationAssistant:'安装 Brclio Pay.command'}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
