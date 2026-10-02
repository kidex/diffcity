// e2e/change/city-from-daemon-report (ADR-026): the real daemon, built in
// dist/, in a temporary DIFFCITY_HOME, collects the `shopfront` repo of the
// order-discounts scenario. From the Repo screen a click on the change row
// opens the night city of the Report the daemon serves: a building for every
// file, roof labels on the touched ones. A 1440x900 screenshot of it is kept
// in test-results/DC-59/city-real.png.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { stopDaemonIn } from '../../helpers/daemon.js';
import { registerHome } from '../../helpers/daemons.js';
import { buildScenario, listScenarios } from '../../helpers/scenario.js';
import { stats, waitReady } from '../support/scene.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(repoRoot, 'dist', 'cli', 'index.js');
const SCREENSHOT = join(repoRoot, 'test-results', 'DC-59', 'city-real.png');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** Runs the built CLI to completion; rejects on a non-zero exit. */
function cli(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`diffcity ${args.join(' ')} exited with ${String(code)}:\n${stderr}`));
    });
  });
}

async function poll<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('change/city-from-daemon-report', async ({ page }) => {
  test.setTimeout(150_000);
  const scenario = listScenarios().find((candidate) => candidate.name === 'order-discounts');
  if (scenario === undefined) throw new Error('order-discounts scenario missing');
  const { repo } = await buildScenario(scenario);
  const root = await mkdtemp(join(tmpdir(), 'dc-e2e-city-'));
  const home = join(root, 'home');
  // A timeout skips `finally`: the global teardown stops this home's daemon then.
  registerHome(home);
  const user = join(root, 'user');
  await mkdir(user);
  const env = { ...process.env, DIFFCITY_HOME: home, HOME: user };
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  let daemon: ChildProcess | null = null;

  try {
    daemon = spawn(process.execPath, [CLI, 'up', '--foreground', '--no-open', '--port', String(port)], { env, stdio: 'ignore' });
    await poll(async () => ((await fetch(`${base}/api/health`)).ok ? true : undefined), 'the daemon');
    await cli(['track', repo.dir], env);

    const repoId = await poll(async () => {
      const repos = (await (await fetch(`${base}/api/repos`)).json()) as RepoSummary[];
      return repos.find((candidate) => candidate.name === 'shopfront')?.id;
    }, 'shopfront in /api/repos');
    const change = await poll(async () => {
      const detail = (await (await fetch(`${base}/api/repos/${String(repoId)}`)).json()) as RepoDetail;
      return detail.changes.find((candidate) => candidate.ref.endsWith('feature/order-discounts') && candidate.stats !== null);
    }, 'the order-discounts change with its first snapshot');
    const report = (await (await fetch(`${base}/api/changes/${String(change.id)}/report`)).json()) as Report;
    const files = report.packages.reduce((sum, pkg) => sum + pkg.files.length, 0);
    expect(files).toBeGreaterThan(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto(`${base}/?scene-debug#/repo/${String(repoId)}`);
    await page.locator(`[data-testid="change-row"][data-change-id="${String(change.id)}"]`).getByTestId('change-title').click();
    await expect(page).toHaveURL(new RegExp(`#/change/${String(change.id)}$`));
    await waitReady(page);

    const scene = await stats(page);
    expect(scene.labels).toBeGreaterThan(0);
    expect(scene.buildings).toBe(files);
    await expect(page.getByTestId('roof-label')).toHaveCount(
      report.packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same').length,
    );
    // Labels settle (occlusion) once the camera rests.
    await page.waitForTimeout(500);
    await mkdir(join(repoRoot, 'test-results', 'DC-59'), { recursive: true });
    await page.screenshot({ path: SCREENSHOT });
    await test.info().attach('city-real', { path: SCREENSHOT, contentType: 'image/png' });
  } finally {
    if (daemon !== null && daemon.exitCode === null) {
      const exited = new Promise((resolve) => daemon?.once('exit', resolve));
      daemon.kill('SIGTERM');
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => { resolve('timeout'); }, 5_000));
      if ((await Promise.race([exited, timeout])) === 'timeout') daemon.kill('SIGKILL');
    }
    await stopDaemonIn(home);
    await rm(root, { recursive: true, force: true });
    await repo.cleanup();
  }
});
