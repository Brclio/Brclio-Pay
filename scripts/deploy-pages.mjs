// Pages does not accept account_id in its Wrangler file. Use the Worker's
// checked-in account explicitly so an unrelated local login cannot select it.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const readConfig = relative => {
  const parsed = ts.parseConfigFileTextToJson(relative, readFileSync(new URL('../' + relative, import.meta.url), 'utf8'));
  if (parsed.error) throw new Error('Invalid deployment configuration');
  return parsed.config;
};
const worker = readConfig('wrangler.jsonc');
const pagesConfig=process.argv.includes('--wechat')?'cloudflare/wechat-pages/wrangler.jsonc':'cloudflare/pages/wrangler.jsonc';
const pages = readConfig(pagesConfig);
if (!/^[a-f0-9]{32}$/.test(worker.account_id) || !/^[a-z0-9-]+$/.test(pages.name)) {
  throw new Error('Invalid deployment account or Pages project');
}
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
  'pages', 'deploy', '--cwd', pagesConfig.replace('/wrangler.jsonc',''), '--project-name', pages.name,
  '--branch', 'main', '--commit-dirty=true'], {
  cwd: root, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: worker.account_id }, stdio: 'inherit',
});
if (result.error) throw new Error('Unable to start Pages deployment');
process.exitCode = result.status ?? 1;
