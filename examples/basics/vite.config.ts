import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// Run against the engine sources, so edits to eulerjs show up without rebuilding the packages.
const sourceOf = (packageDirectory: string, entry = 'index') =>
  here(`../../packages/${packageDirectory}/src/${entry}.ts`);

const EXAMPLES = ['hello', 'tumbling', 'springs', 'chain', 'collisions', 'floating', 'joints', 'queries', 'sensors', 'terrain', 'solvers'];

export default defineConfig({
  resolve: {
    alias: [
      { find: /^eulerjs$/, replacement: sourceOf('eulerjs') },
      { find: /^eulerjs\/extend$/, replacement: sourceOf('eulerjs', 'extend') },
      { find: /^@eulerjs\/marine$/, replacement: sourceOf('marine') },
      { find: /^@eulerjs\/marine\/webgpu$/, replacement: sourceOf('marine', 'webgpu/index') },
      { find: /^@eulerjs\/bvh$/, replacement: sourceOf('bvh') },
      { find: /^@eulerjs\/vehicle$/, replacement: sourceOf('vehicle') },
    ],
  },
  build: {
    rolldownOptions: {
      input: Object.fromEntries([['index', here('index.html')], ...EXAMPLES.map((name) => [name, here(`${name}.html`)])]),
    },
  },
});
