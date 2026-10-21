import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {URL} from 'node:url';

const source=readFileSync(new URL('../public/checkout.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/checkout.html',import.meta.url),'utf8');
const NOW=Date.parse('2026-10-15T01:00:00.000Z');
const ID='pay_'+'a'.repeat(32);
const RETURN=`https://product.example/membership?payment_order_id=${ID}`;
type Listener=(event:Record<string,unknown>)=>unknown;
class Target {
  listeners=new Map<string,Listener[]>();
  addEventListener(name:string,listener:Listener){this.listeners.set(name,[...(this.listeners.get(name)||[]),listener]);}
  async emit(name:string,event:Record<string,unknown>={}){await Promise.all((this.listeners.get(name)||[]).map(listener=>listener(event)));}
}
class Element extends Target {
  hidden=false;disabled=false;checked=false;value='';textContent='';href='';dataset:Record<string,string>={};
  attributes=new Map<string,string>();
  label:{hidden:boolean}={hidden:false};
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  removeAttribute(name:string){this.attributes.delete(name);if(name==='href')this.href='';}
  closest(){return this.label;}
}
const order=(changes:Record<string,unknown>={})=>({
  id:ID,status:'PAID',fulfillmentStatus:'pending',subject:'一日会员',productName:'测试产品',
  amount:'3.00',currency:'CNY',expiresAt:new Date(NOW+30*60_000).toISOString(),
  mode:'live',returnUrl:RETURN,channels:['page','wap'],...changes,
});
type Reply={body:unknown;status?:number};
type BrowserRequest=RequestInit&{credentials?:string;referrerPolicy?:string};
type Call={path:string;options:BrowserRequest};
type Handler=(number:number,call:Call)=>Reply|Promise<Reply>;

async function page(handler:Handler=()=>({body:order()}),{hidden=false}={}){
  const ui=Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element()]));
  const channels=[new Element(),new Element()];channels[0].value='page';channels[0].checked=true;channels[1].value='wap';
  const document=Object.assign(new Target(),{
    hidden,title:'',getElementById:(id:string)=>ui[id],
    querySelectorAll:()=>channels,
    querySelector:(selector:string)=>selector.includes(':checked')?channels.find(input=>input.checked):channels.find(input=>selector.includes(`value="${input.value}"`)),
  });
  const storage=new Map<string,string>();
  const assign=vi.fn();
  const window=Object.assign(new Target(),{
    location:{pathname:`/checkout/${ID}`,search:'',hash:'#token=test_checkout_token',assign},
    history:{replaceState:vi.fn(()=>{window.location.hash='';})},
    sessionStorage:{setItem:(key:string,value:string)=>storage.set(key,value),getItem:(key:string)=>storage.get(key)||null,removeItem:(key:string)=>storage.delete(key)},
    navigator:{userAgent:'Desktop',clipboard:{writeText:vi.fn(async()=>{})}},
    setTimeout:(callback:()=>void,ms:number)=>setTimeout(callback,ms),clearTimeout:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id),
    setInterval:(callback:()=>void,ms:number)=>setInterval(callback,ms),clearInterval:(id:ReturnType<typeof setInterval>)=>clearInterval(id),
  });
  const calls:Call[]=[];
  const fetcher=vi.fn(async(path:string,options:BrowserRequest)=>{
    const call={path,options};calls.push(call);
    const reply=await handler(calls.length,call),status=reply.status??200;
    return {ok:status>=200&&status<300,status,json:async()=>structuredClone(reply.body)};
  });
  runInNewContext(source,{window,document,fetch:fetcher,URL,URLSearchParams,AbortController,Date,Intl},{filename:'public/checkout.js'});
  await vi.advanceTimersByTimeAsync(0);
  return {ui,document,window,calls,fetcher,assign,storage};
}

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe('checkout notification confirmation and safe product return',()=>{
  it('continues GET checks after payment and returns only after delivered plus the visible countdown',async()=>{
    const p=await page(number=>({body:order({fulfillmentStatus:number===1?'pending':'delivered'})}));
    expect(p.ui.statusTitle.textContent).toBe('付款成功，正在通知产品');
    expect(p.ui.paymentOptions.hidden).toBe(true);expect(p.assign).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000);
    expect(p.calls).toHaveLength(2);expect(p.ui.statusTitle.textContent).toBe('产品已收到付款通知');
    expect(p.ui.autoReturnNotice.hidden).toBe(false);expect(p.ui.autoReturnCopy.textContent).toContain('5 秒后');
    expect(p.ui.returnLink.href).toBe(RETURN);expect(p.ui.refreshButton.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(4999);expect(p.assign).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(p.assign).toHaveBeenCalledExactlyOnceWith(RETURN);
    expect(p.calls.every(call=>call.options.method==='GET'&&call.path===`/api/checkout/${ID}`)).toBe(true);
    expect(p.calls.every(call=>call.options.cache==='no-store'&&call.options.credentials==='omit'&&!call.path.includes('token'))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds automatic checks, reads once on later focus, and reserves a renewed watch for explicit GET refresh',async()=>{
    const p=await page();
    await vi.advanceTimersByTimeAsync(10*60_000);
    expect(p.calls.length).toBeGreaterThan(1);expect(p.calls.length).toBeLessThanOrEqual(41);
    const count=p.calls.length;
    expect(p.ui.pollNote.textContent).toContain('自动通知确认已暂停');
    await vi.advanceTimersByTimeAsync(10*60_000);await p.window.emit('focus');
    await p.document.emit('visibilitychange');await vi.advanceTimersByTimeAsync(0);
    expect(p.calls).toHaveLength(count+1);expect(vi.getTimerCount()).toBe(0);
    await p.ui.refreshButton.emit('click');await vi.advanceTimersByTimeAsync(15000);
    expect(p.calls).toHaveLength(count+3);expect(p.calls.every(call=>call.options.method==='GET')).toBe(true);
    expect(p.assign).not.toHaveBeenCalled();
  });

  it('freshly reads an exhausted old tab once when visible again and returns if delivery completed',async()=>{
    let delivered=false;
    const p=await page(()=>({body:order({fulfillmentStatus:delivered?'delivered':'pending'})}));
    await vi.advanceTimersByTimeAsync(10*60_000);const count=p.calls.length;
    p.document.hidden=true;await p.document.emit('visibilitychange');await vi.advanceTimersByTimeAsync(30_000);
    delivered=true;await p.window.emit('focus');expect(p.calls).toHaveLength(count);
    p.document.hidden=false;await p.document.emit('visibilitychange');await p.window.emit('focus');await vi.advanceTimersByTimeAsync(0);
    expect(p.calls).toHaveLength(count+1);expect(p.ui.autoReturnNotice.hidden).toBe(false);expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);expect(p.assign).toHaveBeenCalledExactlyOnceWith(RETURN);
    expect(p.calls.every(call=>call.options.method==='GET')).toBe(true);
  });

  it('throttles exhausted foreground reads to fifteen seconds without restarting continuous polling',async()=>{
    const p=await page();await vi.advanceTimersByTimeAsync(10*60_000);const count=p.calls.length;
    p.document.hidden=true;await p.document.emit('visibilitychange');await vi.advanceTimersByTimeAsync(30_000);
    p.document.hidden=false;await p.document.emit('visibilitychange');await vi.advanceTimersByTimeAsync(0);
    expect(p.calls).toHaveLength(count+1);expect(vi.getTimerCount()).toBe(0);
    await Promise.all([p.window.emit('focus'),p.document.emit('visibilitychange')]);await vi.advanceTimersByTimeAsync(14999);
    await p.window.emit('focus');await vi.advanceTimersByTimeAsync(0);expect(p.calls).toHaveLength(count+1);
    await vi.advanceTimersByTimeAsync(1);await p.window.emit('focus');await vi.advanceTimersByTimeAsync(0);
    expect(p.calls).toHaveLength(count+2);expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);expect(p.calls).toHaveLength(count+2);
    expect(p.ui.pollNote.textContent).toContain('自动通知确认已暂停');
  });

  it('caps focus-triggered checks at forty even before the ten-minute deadline',async()=>{
    const p=await page();
    for(let count=0;count<45;count++){
      await vi.advanceTimersByTimeAsync(1000);await p.window.emit('focus');await vi.advanceTimersByTimeAsync(0);
    }
    expect(p.calls).toHaveLength(41);expect(p.ui.pollNote.textContent).toContain('自动通知确认已暂停');
    expect(vi.getTimerCount()).toBe(0);expect(p.calls.every(call=>call.options.method==='GET')).toBe(true);
  });

  it('recovers a transient notification-state read failure with another GET instead of restarting payment',async()=>{
    const p=await page(number=>number===2?{status:503,body:{error:{code:'SERVICE_UNAVAILABLE'}}}:{body:order({fulfillmentStatus:number>=3?'delivered':'pending'})});
    await vi.advanceTimersByTimeAsync(15000);expect(p.ui.errorNotice.hidden).toBe(false);expect(p.assign).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000);expect(p.ui.errorNotice.hidden).toBe(true);expect(p.ui.autoReturnNotice.hidden).toBe(false);
    expect(p.calls).toHaveLength(3);expect(p.calls.every(call=>call.options.method==='GET')).toBe(true);
  });

  it('resumes a pending notification on visibility or focus without duplicate concurrent checks',async()=>{
    const p=await page();
    p.document.hidden=true;await p.document.emit('visibilitychange');
    await vi.advanceTimersByTimeAsync(60_000);await p.window.emit('focus');
    expect(p.calls).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
    p.document.hidden=false;
    await Promise.all([p.document.emit('visibilitychange'),p.window.emit('focus')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.calls).toHaveLength(2);expect(vi.getTimerCount()).toBe(1);
    await p.window.emit('focus');await vi.advanceTimersByTimeAsync(0);expect(p.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);await p.window.emit('focus');await vi.advanceTimersByTimeAsync(0);
    expect(p.calls).toHaveLength(3);expect(vi.getTimerCount()).toBe(1);
  });

  it('lets the user stay without restarting the countdown after focus, visibility or back-cache restoration',async()=>{
    const p=await page(()=>({body:order({fulfillmentStatus:'delivered'})}));
    await vi.advanceTimersByTimeAsync(2000);await p.ui.stayButton.emit('click');
    expect(p.ui.autoReturnNotice.hidden).toBe(true);expect(p.ui.returnLink.hidden).toBe(false);
    expect(p.ui.pollNote.textContent).toContain('已保留此页');
    await p.window.emit('focus');await p.document.emit('visibilitychange');
    await p.window.emit('pagehide');await p.window.emit('pageshow',{persisted:true});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(p.assign).not.toHaveBeenCalled();expect(p.calls).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses the countdown while hidden and gives a full chance to cancel when visible again',async()=>{
    const p=await page(()=>({body:order({fulfillmentStatus:'delivered'})}));
    await vi.advanceTimersByTimeAsync(4000);p.document.hidden=true;await p.document.emit('visibilitychange');
    await vi.advanceTimersByTimeAsync(60_000);expect(p.assign).not.toHaveBeenCalled();
    p.document.hidden=false;await p.document.emit('visibilitychange');
    expect(p.ui.autoReturnCopy.textContent).toContain('5 秒后');
    await vi.advanceTimersByTimeAsync(4999);expect(p.assign).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(p.assign).toHaveBeenCalledExactlyOnceWith(RETURN);
  });

  it('starts only one countdown after an initially hidden delivered page becomes visible and focused',async()=>{
    const p=await page(()=>({body:order({fulfillmentStatus:'delivered'})}),{hidden:true});
    await vi.advanceTimersByTimeAsync(20_000);expect(p.assign).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    p.document.hidden=false;
    await Promise.all([p.document.emit('visibilitychange'),p.window.emit('focus'),p.window.emit('focus')]);
    expect(vi.getTimerCount()).toBe(1);expect(p.ui.autoReturnCopy.textContent).toContain('5 秒后');
    await vi.advanceTimersByTimeAsync(5000);expect(p.assign).toHaveBeenCalledExactlyOnceWith(RETURN);
    expect(p.calls).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
  });

  it('never auto-returns a sandbox notification and makes no product-rights claim',async()=>{
    const p=await page(()=>({body:order({mode:'sandbox',fulfillmentStatus:'delivered'})}));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.assign).not.toHaveBeenCalled();expect(p.ui.autoReturnNotice.hidden).toBe(true);
    expect(p.ui.returnLink.hidden).toBe(false);expect(p.ui.statusCopy.textContent).toContain('不代表正式产品权益开通');
    expect(p.calls).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['http://product.example/','javascript:alert(1)','data:text/html,hello','https://name:password@product.example/','https://product.example/\nunsafe','not-a-url'])('hides and never follows an unsafe product return: %s',async returnUrl=>{
    const p=await page(()=>({body:order({fulfillmentStatus:'delivered',returnUrl})}));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.assign).not.toHaveBeenCalled();expect(p.ui.returnLink.hidden).toBe(true);expect(p.ui.returnLink.href).toBe('');
    expect(p.ui.autoReturnNotice.hidden).toBe(true);expect(vi.getTimerCount()).toBe(0);
  });

  it('stops all work when the order closes and never treats closed as delivered payment',async()=>{
    const p=await page(number=>({body:order({status:number===1?'PAID':'CLOSED',fulfillmentStatus:'pending'})}));
    await vi.advanceTimersByTimeAsync(15000);
    expect(p.ui.statusTitle.textContent).toBe('这笔订单已结束');expect(p.ui.refreshButton.hidden).toBe(true);
    await p.window.emit('focus');await vi.advanceTimersByTimeAsync(60_000);
    expect(p.calls).toHaveLength(2);expect(p.assign).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401,403,404])('clears checks and the stored checkout token after HTTP %s',async status=>{
    const p=await page(number=>number===1?{body:order()}:{status,body:{error:{code:'NOT_ALLOWED'}}});
    await vi.advanceTimersByTimeAsync(15000);
    expect(p.ui.refreshButton.hidden).toBe(true);expect(p.ui.autoReturnNotice.hidden).toBe(true);expect(p.storage.size).toBe(0);
    await p.window.emit('focus');await vi.advanceTimersByTimeAsync(60_000);
    expect(p.calls).toHaveLength(2);expect(p.assign).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave a cooldown timer after a manual refresh loses its checkout authorization',async()=>{
    const p=await page(number=>number===1?{body:order()}:{status:401,body:{error:{code:'UNAUTHORIZED'}}});
    await p.ui.refreshButton.emit('click');
    expect(p.ui.refreshButton.hidden).toBe(true);expect(p.storage.size).toBe(0);expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an active read on pagehide and ignores a late delivered response',async()=>{
    let finish:(value:Reply)=>void=()=>{};
    const p=await page(number=>number===1?{body:order()}:new Promise<Reply>(resolve=>{finish=resolve;}));
    await vi.advanceTimersByTimeAsync(15000);expect(p.calls).toHaveLength(2);
    await p.window.emit('pagehide');expect(p.calls[1].options.signal?.aborted).toBe(true);
    finish({body:order({fulfillmentStatus:'delivered'})});await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.assign).not.toHaveBeenCalled();expect(p.ui.statusTitle.textContent).toBe('付款成功，正在通知产品');
    expect(p.calls).toHaveLength(2);expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a manual read cooldown after pagehide and ignores its late result',async()=>{
    let finish:(value:Reply)=>void=()=>{};
    const p=await page(number=>number===1?{body:order()}:new Promise<Reply>(resolve=>{finish=resolve;}));
    const clicked=p.ui.refreshButton.emit('click');await vi.advanceTimersByTimeAsync(0);
    await p.window.emit('pagehide');finish({body:order({fulfillmentStatus:'delivered'})});await clicked;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.assign).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });

  it('automatically reads pending payments with GET and reserves provider refresh POST for an explicit user click',async()=>{
    const p=await page(()=>({body:order({status:'PENDING'})}));
    await vi.advanceTimersByTimeAsync(15000);expect(p.calls.every(call=>call.options.method==='GET')).toBe(true);
    await p.ui.refreshButton.emit('click');expect(p.calls[2].path).toBe(`/api/checkout/${ID}/refresh`);expect(p.calls[2].options.method).toBe('POST');
    expect(p.calls.some(call=>call.path.endsWith('/pay'))).toBe(false);
  });

  it('never starts a return from browser query flags or an unconfirmed payment',async()=>{
    const p=await page(()=>({body:order({status:'PENDING',fulfillmentStatus:'delivered'})}));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(p.assign).not.toHaveBeenCalled();expect(p.ui.autoReturnNotice.hidden).toBe(true);
    expect(p.ui.statusTitle.textContent).toBe('准备好了，就去付款吧');
    expect(p.calls.every(call=>call.options.method==='GET')).toBe(true);
  });
});
