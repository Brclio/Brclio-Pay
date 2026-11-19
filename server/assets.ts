import {readFile,realpath,stat} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';

const MIME:Record<string,string>={'.html':'text/html;charset=utf-8','.js':'application/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.json':'application/json;charset=utf-8','.md':'text/markdown;charset=utf-8','.txt':'text/plain;charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.webp':'image/webp','.woff2':'font/woff2','.zip':'application/zip'};

/** Static files come only from the release's public directory, never the data directory. */
export function staticAssets(directory:string):Fetcher {
  const root=realpath(directory);
  return {async fetch(input:RequestInfo|URL,init?:RequestInit){
    const request=input instanceof Request?input:new Request(input,init);
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
    try{
      const pathname=decodeURIComponent(new URL(request.url).pathname);
      if(pathname.includes('\\')||pathname.includes('\0')||pathname.split('/').some(part=>part.startsWith('.'))||pathname.startsWith('/_'))return new Response('Not found',{status:404});
      const base=await root,target=await realpath(resolve(base,'.'+(pathname==='/'?'/index.html':pathname)));
      if(!target.startsWith(base+sep))return new Response('Not found',{status:404});
      const info=await stat(target);
      if(!info.isFile())return new Response('Not found',{status:404});
      return new Response(request.method==='HEAD'?null:await readFile(target),{headers:{'Content-Type':MIME[extname(target).toLowerCase()]||'application/octet-stream','Content-Length':String(info.size),'X-Content-Type-Options':'nosniff'}});
    }catch{return new Response('Not found',{status:404});}
  }} as unknown as Fetcher;
}
