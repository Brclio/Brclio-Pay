import {createAlipay} from './alipay';
import {createWechat} from './wechat';
import {paymentChannels,providerConfigured} from './config';
import type {Env} from './types';

export function paymentAdapters(env:Env){
  let alipay:ReturnType<typeof createAlipay>|undefined,wechat:ReturnType<typeof createWechat>|undefined;
  // Retained credentials can still verify late payments after new purchases
  // are disabled. A malformed unselected provider must not block the active one.
  for(const provider of ['alipay','wechat'] as const){
    if(!providerConfigured(env,provider))continue;
    try{if(provider==='alipay')alipay=createAlipay(env);else wechat=createWechat(env);}
    catch(error){if(paymentChannels(env,provider).length)throw error;}
  }
  return {alipay,wechat};
}
