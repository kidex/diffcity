import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    environment: 'node',
    // Builds dist/ once for the tests that spawn the built CLI.
    globalSetup: ['test/global-setup.ts'],
    // Points DIFFCITY_HOME and HOME at a fresh temporary directory for each test file (ADR-015).
    setupFiles: ['test/setup/home.ts'],
    // Integration tests spawn many git processes; under parallel load they exceed the 5 s default.
    testTimeout: 60_000,
    // Shared-repo beforeAll hooks spawn as many git processes as a test does.
    hookTimeout: 60_000,
  },
});
