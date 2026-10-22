import './sync-environment-docs.mjs';
import {mkdirSync,copyFileSync} from 'node:fs';
mkdirSync('public/docs',{recursive:true});
for(const name of ['integration','alipay-setup','merchant-setup','architecture','deployment','environment-variables','application-profile','admin','clients','status','release-verification-2026-10-22','release-verification-client-1.0.1-2026-10-22'])copyFileSync(`docs/${name}.md`,`public/docs/${name}.md`);
