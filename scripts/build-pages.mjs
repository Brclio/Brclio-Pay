import {mkdirSync,copyFileSync,cpSync,rmSync} from 'node:fs';
import './sync-docs.mjs';
rmSync('dist-pages',{recursive:true,force:true});
mkdirSync('dist-pages',{recursive:true});
cpSync('public','dist-pages',{recursive:true});
copyFileSync('cloudflare/pages/_worker.js','dist-pages/_worker.js');
copyFileSync('cloudflare/pages/_routes.json','dist-pages/_routes.json');
