import {build} from 'esbuild';
import {cp,mkdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
await rm(new URL('../dist-server/',import.meta.url),{recursive:true,force:true});
await mkdir(new URL('../dist-server/',import.meta.url),{recursive:true});
await build({absWorkingDir:root,entryPoints:['server/index.ts'],outfile:'dist-server/index.mjs',bundle:true,platform:'node',format:'esm',target:'node22.13',banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"},logLevel:'info'});
await cp(new URL('../public/',import.meta.url),new URL('../dist-server/public/',import.meta.url),{recursive:true});
