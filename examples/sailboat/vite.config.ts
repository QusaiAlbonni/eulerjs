import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Run against the engine sources, so edits to eulerjs show up without rebuilding the packages.
const sourceOf = (packageDirectory: string, entry = 'index') =>
  fileURLToPath(new URL(`../../packages/${packageDirectory}/src/${entry}.ts`, import.meta.url));

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
});
