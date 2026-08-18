import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Test files run one at a time: the load test measures wall-clock latency and
    // must not compete with other suites for the event loop.
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
