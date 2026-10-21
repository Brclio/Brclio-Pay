import {mkdirSync,copyFileSync} from 'node:fs';
mkdirSync('public/docs',{recursive:true});
for(const name of ['integration','alipay-setup','architecture','deployment','environment-variables','application-profile','admin','status'])copyFileSync(`docs/${name}.md`,`public/docs/${name}.md`);
