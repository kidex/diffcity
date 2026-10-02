// e2e/cd-to-ui: the phase 2 exit criterion (SPEC.md section 9, 3a, ADR-023,
// ADR-016, ADR-015). You `cd` into a repo and within 5 s it appears in the UI
// with all its changes, with no manual command.
//
// - Scenario A, per installed shell (zsh, the system bash, and the Homebrew
//   bash 5 and fish when present): the real daemon runs (`up --foreground`),
//   the UI is open on the Fleet, a real interactive shell evaluates the built
//   `diffcity shell-init` and `cd`s into the invented sample-shop repo. Within
//   5000 ms of t0 (the moment the `cd` line is written to the shell) the repo's
//   lot and row are on the Fleet with one Draft, one Branch and one PR,
//   GET /api/repos/:id lists the 3 changes, each with stats, and following the
//   row opens the Repo screen listing the 3 changes with their stats.
// - Scenario B: no daemon. The hook's `track` starts one detached (on the port
//   from state.json) and the same 5000 ms deadline applies from t0; the UI
//   opened afterwards shows the lot, and the Repo screen the 3 changes.
// - An untrusted repo with a diffcity.config.js: its config is never imported
//   and the repo carries the "not trusted" note.
//
// Every test has its own temporary DIFFCITY_HOME and HOME, a gh stub first on
// PATH, git without the user's config, and stops every daemon it caused. The
// real ~/.config/diffcity is never touched. On failure the video, the trace
// and the daemon's log are kept in test-results/.
//
// Why the timing assertions run serially: the deadline measures the daemon's
// collection, not the machine. Each test spawns a shell, a daemon with its
// snapshot workers and git processes; two of them side by side would share the
// CPU and the deadline would measure the load instead (the same reason the
// vitest `timing` project runs integration/track-to-api-under-5s alone). So the
// tests of this file run one after another in a single worker (Playwright's
// default without fullyParallel) and the `acceptance` project is limited to
// one worker in test/playwright.config.ts, so no other acceptance spec runs
// beside them. CI runs the acceptance project in a step of its own, after the
// screens project, so no screen spec runs beside them either.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base, type Page, type TestInfo } from '@playwright/test';
import { homePaths, HOME_ENV, type HomePaths } from '../../../src/core/home.js';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import { CONFIG_NOT_TRUSTED_NOTE } from '../../../src/core/settings/index.js';
import { CLI_DIST, stopDaemonIn } from '../../helpers/daemon.js';
import { registerHome } from '../../helpers/daemons.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';
import {
  buildSampleShop,
  cdLine,
  freePort,
  ghStubEnv,
  installedShells,
  openShell,
  samplePrs,
  type ShellSession,
  type ShellSpec,
} from '../support/acceptance.js';

const DEADLINE_MS = 5000;
/** Waits run past the deadline, so a miss still reports how long it took. */
const OBSERVE_MS = 30_000;

interface World {
  /** Temporary root: DIFFCITY_HOME, HOME, the gh stub and the shell's start directory. */
  readonly root: string;
  readonly paths: HomePaths;
  readonly env: NodeJS.ProcessEnv;
  readonly repo: TempRepo;
  readonly port: number;
  readonly baseURL: string;
  /** Starts `up --foreground --no-open --port <port>` and waits for /api/health. */
  startDaemon(): Promise<void>;
  /** An interactive shell in `root` with the hook loaded; closed at teardown. */
  shell(spec: ShellSpec): Promise<ShellSession>;
  /** Another repo, removed at teardown. */
  addRepo(repo: TempRepo): void;
}

async function attachOnFailure(testInfo: TestInfo, name: string, path: string): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus || !existsSync(path)) return;
  await testInfo.attach(name, { path, contentType: 'text/plain' });
}

const test = base.extend<{ world: World }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured first argument.
  world: async ({}, use, testInfo) => {
    // Short prefix: <root>/home/daemon.sock must fit the socket path limit.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-acc-')));
    const home = join(root, 'home');
    // Stopped at teardown, or by the global teardown if this worker dies.
    registerHome(home);
    const user = join(root, 'user');
    await mkdir(user);
    const { repo, prHead } = await buildSampleShop();
    const env = await ghStubEnv(root, { ...process.env, [HOME_ENV]: home, HOME: user }, samplePrs(prHead));
    const paths = homePaths(home);
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${String(port)}`;
    const foregroundLog = join(root, 'daemon-foreground.log');
    const shells: ShellSession[] = [];
    const repos: TempRepo[] = [repo];
    const daemon: { child: ChildProcess | null } = { child: null };

    const world: World = {
      root,
      paths,
      env,
      repo,
      port,
      baseURL,
      async startDaemon() {
        const log = createWriteStream(foregroundLog);
        const child = spawn(process.execPath, [CLI_DIST, 'up', '--foreground', '--no-open', '--port', String(port)], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.pipe(log);
        child.stderr.pipe(log);
        daemon.child = child;
        const deadline = Date.now() + 15_000;
        for (;;) {
          const ok = await fetch(`${baseURL}/api/health`).then((response) => response.ok, () => false);
          if (ok) return;
          if (child.exitCode !== null) throw new Error(`up exited with ${String(child.exitCode)}; see daemon-foreground.log`);
          if (Date.now() > deadline) throw new Error('the daemon did not answer within 15 s');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
      async shell(spec) {
        const session = await openShell(spec, root, env, root);
        shells.push(session);
        return session;
      },
      addRepo(extra) {
        repos.push(extra);
      },
    };

    await use(world);

    for (const session of shells) await session.close();
    await attachOnFailure(testInfo, 'daemon.log', paths.log);
    await attachOnFailure(testInfo, 'daemon-foreground.log', foregroundLog);
    // Never leave a daemon behind: the foreground one, and any one a hook started.
    const running = daemon.child;
    if (running !== null && running.exitCode === null && running.signalCode === null) {
      const exited = new Promise((resolve) => running.once('exit', resolve));
      running.kill('SIGTERM');
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => { resolve('timeout'); }, 5000));
      if ((await Promise.race([exited, timeout])) === 'timeout') running.kill('SIGKILL');
    }
    await stopDaemonIn(home);
    for (const extra of repos) await extra.cleanup();
    await rm(root, { recursive: true, force: true });
  },
});

/** Polls the API until sample-shop lists its 3 changes, each with stats. */
async function waitForChanges(baseURL: string, name: string): Promise<RepoDetail> {
  const deadline = Date.now() + OBSERVE_MS;
  for (;;) {
    const repos = await fetch(`${baseURL}/api/repos`)
      .then(async (response) => (response.ok ? ((await response.json()) as RepoSummary[]) : []))
      .catch(() => []);
    const repo = repos.find((entry) => entry.name === name);
    if (repo !== undefined) {
      const detail = (await (await fetch(`${baseURL}/api/repos/${String(repo.id)}`)).json()) as RepoDetail;
      if (detail.changes.length === 3 && detail.changes.every((change) => change.stats !== null)) return detail;
    }
    if (Date.now() > deadline) throw new Error(`${name} did not list 3 changes with stats within ${String(OBSERVE_MS)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Waits until the Fleet shows the lot and the row of `name` with one Draft,
 * one Branch and one PR. Polls every 25 ms in the page, so the measured time
 * is not rounded up by expect's back-off. The predicate is a string because
 * the test tsconfig has no DOM types.
 */
async function waitForFleet(page: Page, name: string): Promise<void> {
  const repoName = JSON.stringify(name);
  await page.waitForFunction(
    `(() => {
      const lot = [...document.querySelectorAll('[data-testid="lot"]')].find((element) =>
        (element.getAttribute('aria-label') ?? '').startsWith(${repoName} + ','));
      const row = [...document.querySelectorAll('[data-testid="repo-row"]')].find((element) =>
        (element.querySelector('[data-col="repo"]')?.textContent ?? '').includes(${repoName}));
      if (lot === undefined || row === undefined) return false;
      const count = (column) => row.querySelector('[data-col="' + column + '"]')?.textContent?.trim() ?? '';
      return count('draft') === '1' && count('branch') === '1' && count('pr') === '1';
    })()`,
    undefined,
    { polling: 25, timeout: OBSERVE_MS },
  );
}

/**
 * Opens the repo from its Fleet row and waits until the Repo screen shows
 * `name` with its 3 changes (a Draft, a Branch and a PR), each with its stats
 * computed, and the Branch and PR under their titles.
 */
async function openRepoScreen(page: Page, name: string): Promise<void> {
  await page.getByTestId('repo-row').filter({ hasText: name }).getByRole('link', { name }).click();
  await page.waitForFunction(
    `(() => {
      const screen = document.querySelector('[data-screen="repo"]');
      if (screen === null || screen.querySelector('h1')?.textContent !== ${JSON.stringify(name)}) return false;
      const rows = [...screen.querySelectorAll('[data-testid="change-row"]')];
      if (rows.length !== 3 || screen.querySelector('[data-testid="computing"]') !== null) return false;
      const kinds = rows.map((row) => row.getAttribute('data-kind')).sort().join(',');
      const titles = rows.map((row) => row.querySelector('[data-testid="change-title"]')?.textContent ?? '');
      return kinds === 'branch,draft,pr' && titles.includes('add the menu') && titles.includes('Checkout flow');
    })()`,
    undefined,
    { polling: 25, timeout: OBSERVE_MS },
  );
}

/** Waits until the Fleet shows a lot for `name`. */
async function waitForLot(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    `[...document.querySelectorAll('[data-testid="lot"]')].some((lot) => (lot.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(name)} + ','))`,
    undefined,
    { polling: 25, timeout: OBSERVE_MS },
  );
}

/** Checks the listed changes are sample-shop's Draft, Branch and PR. */
function expectSampleShopChanges(detail: RepoDetail): void {
  expect(detail.repo.name).toBe('sample-shop');
  expect(detail.changes.map((change) => `${change.kind} ${change.ref}`).sort()).toEqual([
    'branch branch:feature/menu',
    'draft draft:.',
    'pr pr:7',
  ]);
  const titles = Object.fromEntries(detail.changes.map((change) => [change.kind, change.title]));
  expect(titles).toEqual({ draft: expect.any(String) as unknown, branch: 'add the menu', pr: 'Checkout flow' });
  const branch = detail.changes.find((change) => change.kind === 'branch');
  expect(branch).toMatchObject({ ahead: 1, behind: 0 });
}

const report = (testInfo: TestInfo, text: string): void => {
  // Measured for the phase report; printed by the list reporter.
  console.info(`${testInfo.title}: ${text}`);
  testInfo.annotations.push({ type: 'timing', description: text });
};

const shells = installedShells();

test.describe('scenario A: the daemon runs and the UI is open on the Fleet', () => {
  // A missing shell would silently drop its test, so CI (which installs zsh)
  // must find both; fish runs only where it is installed.
  test('zsh and bash are installed in CI', () => {
    test.skip(!process.env['CI'], 'local runs use whatever shells are installed');
    expect(shells.map((spec) => spec.shell)).toEqual(expect.arrayContaining(['zsh', 'bash']));
  });

  for (const spec of shells) {
    test(`${spec.name}: cd → the repo and its 3 changes appear within 5 s`, async ({ page, world }, testInfo) => {
      test.setTimeout(90_000);
      await world.startDaemon();
      await page.goto(`${world.baseURL}/#/`);
      await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
      await expect(page.getByTestId('fleet-empty')).toBeVisible();
      const shell = await world.shell(spec);

      const t0 = performance.now();
      shell.run(cdLine(spec, world.repo.dir));
      const [uiMs, detail] = await Promise.all([
        waitForFleet(page, 'sample-shop').then(() => performance.now() - t0),
        waitForChanges(world.baseURL, 'sample-shop').then((value) => ({ value, ms: performance.now() - t0 })),
      ]);

      // The user follows the row: the Repo screen lists the 3 changes.
      await openRepoScreen(page, 'sample-shop');
      const repoMs = performance.now() - t0;

      const measured =
        `Fleet lot and counters in ${uiMs.toFixed(0)} ms; API 3 changes with stats in ${detail.ms.toFixed(0)} ms; ` +
        `Repo screen with the 3 changes at ${repoMs.toFixed(0)} ms`;
      report(testInfo, measured);
      expectSampleShopChanges(detail.value);
      expect(uiMs, measured).toBeLessThan(DEADLINE_MS);
      expect(detail.ms, measured).toBeLessThan(DEADLINE_MS);
      expect(repoMs, measured).toBeLessThan(DEADLINE_MS);
      // The background track prints no job notice and nothing else.
      expect(shell.output()).not.toMatch(/\[\d+\]|tracked|error/i);
    });
  }
});

test.describe('scenario B: no daemon runs', () => {
  const spec = shells[0];
  test(`${spec?.name ?? 'no shell'}: the cd starts the daemon and the repo with its 3 changes is served within 5 s`, async ({ page, world }, testInfo) => {
    test.skip(spec === undefined, 'no zsh or bash installed');
    if (spec === undefined) return;
    test.setTimeout(90_000);
    // The daemon the hook starts takes its port from state.json.
    await mkdir(world.paths.home, { recursive: true, mode: 0o700 });
    await writeFile(world.paths.state, JSON.stringify({ port: world.port }));
    expect(existsSync(world.paths.daemonJson)).toBe(false);
    const shell = await world.shell(spec);
    // The hook's initial call found no repo, so nothing started a daemon yet.
    expect(existsSync(world.paths.daemonJson)).toBe(false);

    const t0 = performance.now();
    shell.run(cdLine(spec, world.repo.dir));
    const detail = await waitForChanges(world.baseURL, 'sample-shop');
    const apiMs = performance.now() - t0;
    expectSampleShopChanges(detail);

    await page.goto(`${world.baseURL}/#/`);
    await waitForFleet(page, 'sample-shop');
    const uiMs = performance.now() - t0;
    await openRepoScreen(page, 'sample-shop');
    const repoMs = performance.now() - t0;

    const measured =
      `daemon started, API 3 changes with stats in ${apiMs.toFixed(0)} ms; Fleet loaded and showing them at ${uiMs.toFixed(0)} ms; ` +
      `Repo screen with the 3 changes at ${repoMs.toFixed(0)} ms`;
    report(testInfo, measured);
    expect(apiMs, measured).toBeLessThan(DEADLINE_MS);
    expect(uiMs, measured).toBeLessThan(DEADLINE_MS);
    expect(repoMs, measured).toBeLessThan(DEADLINE_MS);
  });
});

test.describe('an untrusted repo', () => {
  const spec = shells[0];
  test('its diffcity.config.js is never imported and the repo carries the "not trusted" note', async ({ page, world }) => {
    test.skip(spec === undefined, 'no zsh or bash installed');
    if (spec === undefined) return;
    test.setTimeout(90_000);
    const marker = join(world.root, 'config-imported.marker');
    const garden = await createRepo({
      name: 'sample-garden',
      files: {
        'src/beds/water.ts': 'export function water(liters: number): number {\n  return liters;\n}\n',
        // Leaves a marker whenever it is imported.
        'diffcity.config.js': [
          "import { appendFileSync } from 'node:fs';",
          `appendFileSync(${JSON.stringify(marker)}, 'imported\\n');`,
          "export default { tier1: ['beds'] };",
          '',
        ].join('\n'),
      },
    });
    world.addRepo(garden);
    await garden.branch('feature/rain');
    await garden.commit('collect the rain', { 'src/beds/rain.ts': 'export const rain = 3;\n' });
    await world.startDaemon();
    await page.goto(`${world.baseURL}/#/`);
    await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

    const shell = await world.shell(spec);
    shell.run(cdLine(spec, garden.dir));
    await waitForLot(page, 'sample-garden');
    const summary = await expect
      .poll(
        async () => {
          const repos = (await (await fetch(`${world.baseURL}/api/repos`)).json()) as RepoSummary[];
          const repo = repos.find((entry) => entry.name === 'sample-garden');
          return repo !== undefined && !repo.collecting && repo.lastEventAt !== null ? repo : undefined;
        },
        { timeout: OBSERVE_MS },
      )
      .toMatchObject({ error: null, notes: [CONFIG_NOT_TRUSTED_NOTE] })
      .then(() => true);
    expect(summary).toBe(true);
    // The branch was collected with the defaults: `beds` is not a tier 1 zone.
    const repos = (await (await fetch(`${world.baseURL}/api/repos`)).json()) as RepoSummary[];
    const id = repos.find((entry) => entry.name === 'sample-garden')?.id ?? 0;
    const detail = (await (await fetch(`${world.baseURL}/api/repos/${String(id)}`)).json()) as RepoDetail;
    const branch = detail.changes.find((change) => change.kind === 'branch');
    expect(branch?.stats?.tier1Files).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});
