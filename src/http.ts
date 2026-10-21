import {HttpError,requireThat} from './config';
export async function jsonBody(request:Request,limit=32768):Promise<unknown> {
  requireThat(request.headers.get('Content-Type')?.split(';')[0].trim()==='application/json',415,'INVALID_CONTENT_TYPE','请求需要 JSON');
  requireThat(Number(request.headers.get('Content-Length') || 0)<=limit,413,'BODY_TOO_LARGE','请求过大');
  if(!request.body)throw new HttpError(400,'INVALID_JSON','JSON 格式错误');
  const reader=request.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let size=0,raw='';
  try {
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new HttpError(413,'BODY_TOO_LARGE','请求过大');}raw+=decoder.decode(value,{stream:true});}
    raw+=decoder.decode();
    try{return JSON.parse(raw);}catch{throw new HttpError(400,'INVALID_JSON','JSON 格式错误');}
  }finally{reader.releaseLock();}
}
