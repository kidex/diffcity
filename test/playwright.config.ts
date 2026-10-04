// Playwright Test (ADR-023). Two projects by default:
// - screens: the UI against a mocked API (page.route + JSON fixtures), served
//   by a test-only static server; trace and screenshot kept on failure, video
//   too outside CI; CI splits its spec files over parallel jobs
//   (scripts/e2e-shard.mjs, .github/workflows/ci.yml);
// - acceptance: each spec starts its own daemon in a fresh temporary home,
//   one worker so timed specs never share the machine with each other; CI
//   runs it in a job of its own, beside the screens shards.
//
// A third project, proof, records a video of one task's acceptance criteria
// (e2e/proof/DC-<nr>.spec.ts). It exists only in proof mode: DIFFCITY_PROOF
// set (`npm run proof -- DC-<nr>` sets it to the task key) or `--project
// proof` on the command line. Proof mode has only that project and no stub
// server, so `npm run test:e2e` and CI never run it.

import { defineConfig, devices, type Project } from '@playwright/test';
import { WEBGL_ARGS } from './e2e/support/browser-args.js';

const CI = Boolean(process.env['CI']);
// DIFFCITY_E2E_PORT lets two worktrees run the screens project side by side;
// with reuseExistingServer, a shared port would serve the other one's dist/.
// An unset, empty, non-numeric or out-of-range value falls back to 4399.
const DEFAULT_PORT = 4399;
const requestedPort = Number(process.env['DIFFCITY_E2E_PORT']?.trim() || Number.NaN);
const PORT = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : DEFAULT_PORT;
// Opt-ins for local runs where Playwright's downloads are not available:
// DIFFCITY_E2E_CHANNEL=chrome uses an installed browser instead of the
// Chromium download, DIFFCITY_E2E_VIDEO=off skips video (it needs Playwright's
// ffmpeg). CI sets neither.
const channel = process.env['DIFFCITY_E2E_CHANNEL'];
const video = process.env['DIFFCITY_E2E_VIDEO'] === 'off' ? 'off' : 'retain-on-failure';
const viewport = { width: 1440, height: 900 };
// WebGL in headless Chromium runs on SwiftShader (the change screen's city
// needs it); every project shares these arguments.
const webglArgs = WEBGL_ARGS;
const browser = { ...devices['Desktop Chrome'], viewport, launchOptions: { args: webglArgs }, ...(channel ? { channel } : {}) };

const argv = process.argv;
const proofFlag = argv.some((arg, i) => arg === '--project=proof' || (arg === '--project' && argv[i + 1] === 'proof'));
// Workers load this file again without the CLI arguments: the environment
// carries proof mode to them, so every process sees the same projects.
if (proofFlag && process.env['DIFFCITY_PROOF'] === undefined) process.env['DIFFCITY_PROOF'] = '1';
const proofTask = process.env['DIFFCITY_PROOF'];
// Proof videos are attached to Jira: temporary repos go under /tmp so the
// paths they show carry no per-user folder (the macOS default TMPDIR is a
// hashed folder under /var/folders). Set before the workers start, so they
// inherit it.
if (proofTask !== undefined) process.env['TMPDIR'] = '/tmp';
const PROOF_TASK = /^DC-\d+$/;

/** One task's proof spec, recorded at full size and slowed down so it can be followed. */
const proofProject = (task: string | undefined): Project => ({
  name: 'proof',
  testDir: './e2e/proof',
  ...(task !== undefined && PROOF_TASK.test(task) ? { testMatch: `${task}.spec.ts` } : {}),
  outputDir: task !== undefined && PROOF_TASK.test(task) ? `../test-results/proof/${task}` : '../test-results/proof',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: {
    ...browser,
    video: { mode: 'on', size: viewport },
    trace: 'off',
    screenshot: 'off',
    launchOptions: { args: webglArgs, slowMo: 120 },
  },
});

const defaultProjects: Project[] = [
  {
    name: 'screens',
    testDir: './e2e/screens',
    // CI keeps traces and screenshots of a failure but records no video: the
    // recorder shares the runner's CPU with the SwiftShader frame loop.
    use: { ...browser, baseURL: `http://127.0.0.1:${String(PORT)}`, ...(CI ? { video: 'off' as const } : {}) },
  },
  {
    name: 'acceptance',
    testDir: './e2e/acceptance',
    // Real daemons with deadlines: one spec at a time (see cd-to-ui.spec.ts).
    workers: 1,
    // No retry: a retry would let a slow first attempt pass as flaky, so the
    // 5 s deadline would never fail CI. Screens keep the global retry.
    retries: 0,
    use: browser,
  },
];

export default defineConfig({
  testDir: './e2e',
  outputDir: '../test-results',
  globalSetup: './e2e/support/global-setup.ts',
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['github']] : 'list',
  use: {
    video,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: proofTask === undefined ? defaultProjects : [proofProject(proofTask)],
  // The stub server serves only the screens project.
  ...(proofTask === undefined
    ? {
        webServer: {
          // Until the daemon serves dist/ui, a stub with the same HTTP surface does.
          command: `node e2e/support/stub-server.mjs --port ${String(PORT)}`,
          url: `http://127.0.0.1:${String(PORT)}/__stub/health`,
          reuseExistingServer: !CI,
          stdout: 'ignore' as const,
        },
      }
    : {}),
});
