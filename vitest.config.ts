import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['src/fixtures/test-helpers.ts'],
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
    fileParallelism: false,
  },
});
