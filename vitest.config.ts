import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 50,
        functions: 65,
        lines: 65,
        statements: 65,
      },
    },
    testTimeout: 10_000,
  },
});
