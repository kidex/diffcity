import { defineConfig } from 'vitest/config';

// The tests that assert a time: the 5 s deadline of SPEC.md section 9, the
// 200 ms warm served Report (ADR-036) and the 100 ms warm change list
// (DC-106). Run beside other files they measure the machine, not the code, so
// they get their own project, one file at a time
// (`npm test` runs it after `main`). The fix-queue concurrency races (DC-112)
// run there too: two processes spinning against each other need free cores,
// not a machine already busy with the main project.
const TIMING = [
  'test/integration/collect/track-to-api-under-5s.test.ts',
  'test/integration/collect/track-to-api-under-5s-gh-latency.test.ts',
  'test/integration/report-route/overlay-bench.test.ts',
  'test/integration/report-route/list-stats-bench.test.ts',
  'test/integration/fix-queue/fix-queue-concurrency.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    // Builds dist/ once for the tests that spawn the built CLI; its teardown
    // stops every daemon left in a temporary home of the run (DC-58).
    globalSetup: ['test/global-setup.ts'],
    // Points DIFFCITY_HOME and HOME at a fresh temporary directory for each test
    // file (ADR-015), and stops the daemons of the homes a file registered.
    // Puts the gh, npm and claude sentinels first on PATH (ADR-032): no test starts a real tool.
    setupFiles: ['test/setup/home.ts', 'test/setup/daemons.ts', 'test/setup/tools.ts'],
    // Integration tests spawn many git processes; under parallel load they exceed the 5 s default.
    testTimeout: 60_000,
    // Shared-repo beforeAll hooks spawn as many git processes as a test does.
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
          exclude: TIMING,
          // Git-heavy integration tests contend for the CPU; half the cores keeps them under their timeouts.
          maxWorkers: '50%',
        },
      },
      {
        extends: true,
        test: {
          name: 'timing',
          include: TIMING,
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});
