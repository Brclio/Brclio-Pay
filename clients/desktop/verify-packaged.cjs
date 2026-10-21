'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
(async()=>{
  const exe=process.argv[2];if(!exe||!path.isAbsolute(exe))throw Error('Usage: npm run verify:packaged -- /absolute/path/to/executable');
  const work=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'brclio-pay-client-smoke-'));
  const report=path.join(work,'report.json');
  const child=spawn(exe,['--client-smoke-report',report,'--client-profile',path.join(work,'profile')],{stdio:'inherit'});
  const timer=setTimeout(()=>child.kill(),90000);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
  if(code!==0)throw Error('Packaged client smoke failed');
  const data=JSON.parse(await fs.readFile(report,'utf8'));if(!data.isPackaged||!data.remoteNodeIsolated||!data.loginFormReady)throw Error('Packaged client verification failed');
  console.log(JSON.stringify(data,null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
