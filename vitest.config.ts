import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sourceOf = (packageDirectory: string, entry = 'index') =>
  fileURLToPath(new URL(`./packages/${packageDirectory}/src/${entry}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@eulerjs\/core$/, replacement: sourceOf('core') },
      { find: /^@eulerjs\/core\/extend$/, replacement: sourceOf('core', 'extend') },
      { find: /^@eulerjs\/marine$/, replacement: sourceOf('marine') },
      { find: /^@eulerjs\/bvh$/, replacement: sourceOf('bvh') },
      { find: /^@eulerjs\/scene$/, replacement: sourceOf('scene') },
      { find: /^@eulerjs\/vehicle$/, replacement: sourceOf('vehicle') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
    // many tests simulate tens of seconds, which takes a while under coverage with every file running at once
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/index.ts', 'packages/core/src/extend.ts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
