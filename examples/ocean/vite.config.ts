import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// Run against the engine sources, so edits to eulerjs show up without rebuilding the packages.
const sourceOf = (packageDirectory: string, entry = 'index') => here(`../../packages/${packageDirectory}/src/${entry}.ts`);

const PAGES = ['index', 'physics-bench', 'gpu-check'];

export default defineConfig({
  resolve: {
    alias: [
      { find: /^eulerjs$/, replacement: sourceOf('eulerjs') },
      { find: /^eulerjs\/extend$/, replacement: sourceOf('eulerjs', 'extend') },
      { find: /^@eulerjs\/marine$/, replacement: sourceOf('marine') },
      { find: /^@eulerjs\/marine\/webgpu$/, replacement: sourceOf('marine', 'webgpu/index') },
    ],
  },
  build: {
    rolldownOptions: {
      input: Object.fromEntries(PAGES.map((name) => [name, here(`${name}.html`)])),
    },
  },
});
