// Playwright Test (ADR-023). Two projects:
// - screens: the UI against a mocked API (page.route + JSON fixtures), served
//   by a test-only static server; video, trace and screenshot kept on failure;
// - acceptance: each spec starts its own daemon in a fresh temporary home.

import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env['CI']);
const PORT = 4399;
// Opt-ins for local runs where Playwright's downloads are not available:
// DIFFCITY_E2E_CHANNEL=chrome uses an installed browser instead of the
// Chromium download, DIFFCITY_E2E_VIDEO=off skips video (it needs Playwright's
// ffmpeg). CI sets neither.
const channel = process.env['DIFFCITY_E2E_CHANNEL'];
const video = process.env['DIFFCITY_E2E_VIDEO'] === 'off' ? 'off' : 'retain-on-failure';
const browser = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...(channel ? { channel } : {}) };

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
  projects: [
    {
      name: 'screens',
      testDir: './e2e/screens',
      use: { ...browser, baseURL: `http://127.0.0.1:${String(PORT)}` },
    },
    {
      name: 'acceptance',
      testDir: './e2e/acceptance',
      use: browser,
    },
  ],
  webServer: {
    // Until the daemon serves dist/ui, a stub with the same HTTP surface does.
    command: `node e2e/support/stub-server.mjs --port ${String(PORT)}`,
    url: `http://127.0.0.1:${String(PORT)}/__stub/health`,
    reuseExistingServer: !CI,
    stdout: 'ignore',
  },
});
