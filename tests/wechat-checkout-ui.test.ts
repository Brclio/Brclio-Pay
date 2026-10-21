import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {URL} from 'node:url';
const source=readFileSync(new URL('../public/checkout.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/checkout.html',import.meta.url),'utf8');
const now=Date.parse('2026-10-21T00:00:00Z'),id='pay_'+'e'.repeat(32);
class Target {
  listeners=new Map<string,((event:unknown)=>unknown)[]>();
  addEventListener(name:string,fn:(event:unknown)=>unknown){this.listeners.set(name,[...(this.listeners.get(name)||[]),fn]);}
  async emit(name:string,event:unknown={}){await Promise.all((this.listeners.get(name)||[]).map(fn=>fn(event)));}
}
class Element extends Target {
  hidden=false;disabled=false;checked=false;textContent='';value='';href='';dataset:Record<string,string>={};label={hidden:false};
  setAttribute(){} removeAttribute(){} closest(){return this.label;}
}
async function page({codeUrl='weixin://wxpay/bizpayurl?pr=fixture',expiry=now+600_000}={}){
  const ui=Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element()]));
  const channels=['page','wap','native'].map(value=>Object.assign(new Element(),{value,checked:value==='page'}));
  const document=Object.assign(new Target(),{hidden:false,title:'',getElementById:(key:string)=>ui[key],querySelectorAll:()=>channels,querySelector:(selector:string)=>selector.includes(':checked')?channels.find(input=>input.checked):channels.find(input=>selector.includes(`value="${input.value}"`))});
  let status='PENDING';
  const order=()=>({id,provider:'wechat',status,fulfillmentStatus:status==='PAID'?'delivered':'pending',subject:'测试会员',productName:'测试产品',amount:'3.00',currency:'CNY',expiresAt:new Date(expiry).toISOString(),mode:'live',channels:['native'],returnUrl:'https://product.example/return'});
  const calls:{path:string;init:RequestInit}[]=[],assign=vi.fn(),toCanvas=vi.fn(async(_canvas:unknown,_code:string,_options:unknown)=>{});
  const window=Object.assign(new Target(),{location:{pathname:`/checkout/${id}`,search:'',hash:'#token=fixture',assign},history:{replaceState(){}},sessionStorage:{setItem(){},getItem(){return '';}},navigator:{userAgent:'Desktop',clipboard:{writeText:vi.fn()}},QRCodeLib:{toCanvas},setTimeout,clearTimeout,setInterval,clearInterval});
  const fetcher=async(path:string,init:RequestInit)=>{calls.push({path,init});return {ok:true,status:200,json:async()=>path.endsWith('/pay')?{provider:'wechat',channel:'native',codeUrl}:order()};};
  runInNewContext(source,{window,document,fetch:fetcher,URL,URLSearchParams,AbortController,Date,Intl});
  await vi.advanceTimersByTimeAsync(0);
  return {ui,channels,calls,assign,toCanvas,paid:()=>{status='PAID';}};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('WeChat Native checkout',()=>{
  it('requests Native payment, renders locally and clears the QR after payment confirmation',async()=>{
    const p=await page();expect(p.ui.orderProvider.textContent).toBe('微信支付');
    expect(p.channels[0].label.hidden).toBe(true);expect(p.channels[2].label.hidden).toBe(false);
    await p.ui.payButton.emit('click');
    expect(JSON.parse(String(p.calls[1].init.body))).toEqual({channel:'native'});
    expect(p.toCanvas).toHaveBeenCalledOnce();expect(p.toCanvas.mock.calls[0]?.[1]).toBe('weixin://wxpay/bizpayurl?pr=fixture');
    expect(p.ui.wechatQrPanel.hidden).toBe(false);expect(p.assign).not.toHaveBeenCalled();
    p.paid();await vi.advanceTimersByTimeAsync(15_000);
    expect(p.ui.wechatQrPanel.hidden).toBe(true);expect(p.ui.statusBadge.textContent).toBe('已付款');
  });
  it('rejects an untrusted code URL without rendering or navigating',async()=>{
    const p=await page({codeUrl:'https://attacker.example/qr'});await p.ui.payButton.emit('click');
    expect(p.toCanvas).not.toHaveBeenCalled();expect(p.assign).not.toHaveBeenCalled();expect(p.ui.wechatQrPanel.hidden).toBe(true);expect(p.ui.errorNotice.hidden).toBe(false);
  });
  it('hides an already displayed QR when its payment window expires',async()=>{
    const p=await page({expiry:now+1000});await p.ui.payButton.emit('click');expect(p.ui.wechatQrPanel.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);expect(p.ui.wechatQrPanel.hidden).toBe(true);expect(p.ui.paymentOptions.hidden).toBe(true);
    const count=p.calls.length;await p.ui.payButton.emit('click');expect(p.calls).toHaveLength(count);
  });
});
