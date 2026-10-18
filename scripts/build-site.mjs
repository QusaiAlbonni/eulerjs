// Builds the documentation site into docs/.vitepress/dist: the API reference from the sources,
// the guide with VitePress, and every example as it is, each under examples/<name>/.
//
//   node scripts/build-site.mjs          (SITE_BASE=/eulerjs/ by default, as GitHub Pages serves it)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = process.env.SITE_BASE ?? '/eulerjs/';
const site = `${root}docs/.vitepress/dist`;

const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, SITE_BASE: base } });

run('npx', ['typedoc']);
run('node', ['scripts/build-examples.mjs']);
// VitePress copies the examples in as it finishes
run('npx', ['vitepress', 'build', 'docs']);
// GitHub Pages runs sites through Jekyll unless told not to, which hides folders starting with _
if (!existsSync(site)) mkdirSync(site, { recursive: true });
cpSync(`${root}docs/public/.nojekyll`, `${site}/.nojekyll`);
console.log(`\nThe site is in ${site}, for ${base}`);
