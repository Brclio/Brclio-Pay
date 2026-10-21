import {createPrivateKey, sign} from 'node:crypto';
import {GitHubError} from './store';

export interface AppCredentials {appId:string; privateKey:string; repository:string; installationId?:string}
/** Installation tokens stay in memory and are scoped to this one data repository. */
export class GitHubApp {
  private cached?:{token:string;expires:number};
  private pending?:Promise<string>;
  constructor(private config:AppCredentials,private fetcher:typeof fetch=(input,init)=>globalThis.fetch(input,init)){}
  async token():Promise<string>{
    if(this.cached && this.cached.expires>Date.now()+60_000)return this.cached.token;
    this.pending??=this.issue().finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  private async issue():Promise<string>{
    const now=Math.floor(Date.now()/1000);
    const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iat:now-60,exp:now+540,iss:this.config.appId});
    let jwt:string;
    try {jwt=unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),createPrivateKey(this.config.privateKey)).toString('base64url');}
    catch {throw new GitHubError('GitHub App credentials are invalid',503,'GITHUB_APP_CONFIGURATION');}
    const request=async(path:string,body?:unknown)=>{
      let response:Response;
      try {response=await this.fetcher('https://api.github.com'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+jwt,accept:'application/vnd.github+json','content-type':'application/json','user-agent':'Brclio-Pay','x-github-api-version':'2022-11-28'},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(10000)});}
      catch {throw new GitHubError('GitHub App authentication unavailable',503,'GITHUB_APP_UNAVAILABLE');}
      if(!response.ok){await response.body?.cancel();throw new GitHubError('GitHub App authentication returned HTTP '+response.status,503,'GITHUB_APP_AUTHENTICATION');}
      return response.json() as Promise<Record<string,unknown>>;
    };
    const installation=this.config.installationId || String((await request('/repos/'+this.config.repository+'/installation')).id || '');
    if(!/^\d+$/.test(installation))throw new GitHubError('GitHub App installation is unavailable',503,'GITHUB_APP_INSTALLATION');
    const result=await request('/app/installations/'+installation+'/access_tokens',{repositories:[this.config.repository.split('/')[1]],permissions:{contents:'write'}});
    const expires=Date.parse(String(result.expires_at));
    if(typeof result.token!=='string'||!Number.isFinite(expires)||expires<=Date.now()+60_000)throw new GitHubError('GitHub App token is invalid',503,'GITHUB_APP_AUTHENTICATION');
    this.cached={token:result.token,expires};
    return result.token;
  }
}
