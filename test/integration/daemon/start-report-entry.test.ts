// The daemon entry and its start report (DC-45): dist/daemon/main.js installs
// the reporter before it loads the daemon, so a daemon that cannot load its
// modules reports exit 1 at once instead of leaving a LaunchServices client to
// its start timeout; and a starting daemon removes stale start reports.

import { copyFile, mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
});
