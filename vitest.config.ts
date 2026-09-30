import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    environment: 'node',
    // Integration tests spawn many git processes; under parallel load they exceed the 5 s default.
    testTimeout: 30_000,
  },
});
