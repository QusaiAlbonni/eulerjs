// Builds every example, as it is, into docs/.vitepress/built-examples/<name>, for the site to
// serve under examples/<name>/: copied into the site by every VitePress build, and served from
// there by the docs' dev server.
//
//   node scripts/build-examples.mjs     (SITE_BASE=/eulerjs/ by default)
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = process.env.SITE_BASE ?? '/eulerjs/';
const builtExamples = `${root}docs/.vitepress/built-examples`;
const examples = ['basics', 'sailboat', 'city', 'wedding', 'ocean'];

for (const example of examples) {
  const out = `${builtExamples}/${example}`;
  rmSync(out, { recursive: true, force: true });
  execFileSync('npx', ['vite', 'build', '--base', `${base}examples/${example}/`, '--outDir', out, '--emptyOutDir'], {
    cwd: `${root}examples/${example}`,
    stdio: 'inherit',
  });
}
