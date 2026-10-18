import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// `npm run bench`: the timing and quality reports in packages/*/bench, kept out of `npm test`.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['packages/*/bench/**/*.test.ts', 'examples/*/bench/**/*.test.ts'],
      silent: false,
      // one file at a time: timings taken while another benchmark runs alongside mean nothing
      fileParallelism: false,
      testTimeout: 600_000,
    },
  }),
);
