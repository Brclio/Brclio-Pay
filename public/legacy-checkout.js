(async()=>{
  const message=document.getElementById('legacyMessage');
  const match=/^\/checkout\/([a-f0-9]{32})\/?$/.exec(location.pathname);
  const token=new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null,'',location.pathname);
  try{
    if(!match||!token||!/^[a-f0-9]{64}$/.test(token))throw Error('invalid');
    const response=await fetch('/api/legacy/wechat/checkout/'+match[1]+'/exchange',{headers:{Authorization:'Bearer '+token},redirect:'error',cache:'no-store'});
    if(!response.ok)throw Error('invalid');
    const value=await response.json(),url=new URL(value.checkoutUrl);
    if(url.origin!==location.origin||url.pathname!=='/checkout/pay_'+match[1]||!/^#token=[a-f0-9]{64}$/.test(url.hash)||url.search)throw Error('invalid');
    location.replace(url.href);
  }catch{message.textContent='暂时无法打开订单，请从原产品重新进入，或稍后再试。';}
})();
