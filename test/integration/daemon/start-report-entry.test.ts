// The daemon entry and its start report (DC-45): dist/daemon/main.js installs
// the reporter before it loads the daemon, so a daemon that cannot load its
// modules reports exit 1 at once instead of leaving a LaunchServices client to
// its start timeout; a signal while it loads the daemon ends it with 0, not
// the default action (DC-119); and a starting daemon removes stale start
// reports.

import { copyFile, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { homePaths } from '../../../src/core/home.js';
import { readDaemonInfo } from '../../../src/daemon/files.js';
import { START_REPORT_ENV, START_REPORT_TTL_MS } from '../../../src/daemon/start-report.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { DAEMON_MAIN_DIST, DaemonTracker, waitFor } from '../../helpers/daemon.js';

const daemons = new DaemonTracker();
let home: TempHome | null = null;
afterEach(async () => {
  await daemons.cleanup();
  await home?.cleanup();
  home = null;
});

describe('daemon entry start report', () => {
  it('start-report/import-failure-reports-exit-1-at-once', async () => {
    home = await tempHome();
    // The entry and the reporter, without the daemon body: its import throws.
    const dist = join(home.root, 'partial-dist', 'daemon');
    await mkdir(dist, { recursive: true });
    for (const file of ['main.js', 'start-report.js']) await copyFile(join(dirname(DAEMON_MAIN_DIST), file), join(dist, file));
    const report = join(home.root, 'start-ab.report');

    const t0 = performance.now();
    const run = daemons.spawn(join(dist, 'main.js'), ['--port', '0'], { ...home.env, [START_REPORT_ENV]: report });
    expect(await run.exited).toBe(1);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(await readFile(report, 'utf8')).toBe('1\n');
    expect(run.stderr()).toContain('diffcity daemon:');
  });

  it('start-report/startup-sweeps-stale-reports-and-reports-ready', async () => {
    home = await tempHome();
    const paths = homePaths(home.home);
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    const stale = join(paths.home, 'start-0a0b.report');
    await writeFile(stale, '0\n');
    const old = new Date(Date.now() - START_REPORT_TTL_MS - 5000);
    await utimes(stale, old, old);
    const report = join(paths.home, 'start-0c0d.report');

    daemons.spawnDaemon({ ...home.env, [START_REPORT_ENV]: report });
    await waitFor(() => readDaemonInfo(paths).catch(() => null).then((value) => value ?? undefined), 20_000, 'daemon.json');
    await waitFor(() => readFile(report, 'utf8').catch(() => undefined), 5000, 'the ready report');
    expect(await readFile(report, 'utf8')).toBe('ready\n');
    expect((await readdir(paths.home)).filter((name) => name.endsWith('.report'))).toEqual(['start-0c0d.report']);
  });

  it('start-report/port-in-use-reports-exit-3', async () => {
    home = await tempHome();
    // The port is taken between the client's own check and the daemon's bind.
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const report = join(home.root, 'start-3e.report');
    try {
      const run = daemons.spawnDaemon({ ...home.env, [START_REPORT_ENV]: report }, ['--port', String(address.port)]);
      expect(await run.exited).toBe(3);
      expect(await readFile(report, 'utf8')).toBe('3\n');
      expect(run.stderr()).toContain(`port ${String(address.port)} is in use`);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => { resolve(); }));
    }
  });
});

describe('a signal while the entry loads the daemon (DC-119)', () => {
  const slowLoad = fileURLToPath(new URL('../../fixtures/daemon/slow-load.mjs', import.meta.url));
  const gone = (file: string): Promise<boolean> =>
    stat(file).then(
      () => false,
      () => true,
    );

  /** The daemon entry with the load of the daemon body held until `release` exists. */
  async function heldDaemon(): Promise<{ run: ReturnType<DaemonTracker['spawn']>; report: string; release: string; paths: ReturnType<typeof homePaths> }> {
    home = await tempHome();
    const paths = homePaths(home.home);
    const held = join(home.root, 'load-held');
    const release = join(home.root, 'load-release');
    const report = join(home.root, 'start-1a.report');
    const env = { ...home.env, [START_REPORT_ENV]: report, DIFFCITY_TEST_LOAD_HELD: held, DIFFCITY_TEST_LOAD_RELEASE: release };
    const run = daemons.spawn(DAEMON_MAIN_DIST, ['--port', '0'], env, undefined, ['--import', slowLoad]);
    await waitFor(() => gone(held).then((missing) => !missing), 45_000, 'the held load');
    return { run, report, release, paths };
  }

  it.each(['SIGINT', 'SIGTERM'] as const)('daemon/signal-during-load: %s exits 0 at once, reports 0 and leaves no files', async (signal) => {
    const { run, report, paths } = await heldDaemon();
    run.child.kill(signal);
    // The load is still held: only an exit that does not wait for it ends the process.
    expect(await run.exited).toBe(0);
    expect(run.child.signalCode).toBeNull();
    expect(await readFile(report, 'utf8')).toBe('0\n');
    for (const file of [paths.daemonJson, paths.lock, paths.socket]) expect(await gone(file), file).toBe(true);
    expect(run.stdout()).not.toContain('listening on');
  });

  it('daemon/signal-after-load: once loaded, the daemon starts and a signal shuts it down gracefully', async () => {
    const { run, report, release, paths } = await heldDaemon();
    await writeFile(release, '');
    const info = await waitFor(() => readDaemonInfo(paths).catch(() => null).then((value) => value ?? undefined), 45_000, 'daemon.json');
    expect(info.pid).toBe(run.child.pid);
    expect(await readFile(report, 'utf8')).toBe('ready\n');
    run.child.kill('SIGINT');
    expect(await run.exited).toBe(0);
    for (const file of [paths.daemonJson, paths.lock, info.socket]) expect(await gone(file), file).toBe(true);
  });
});
