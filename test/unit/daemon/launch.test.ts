// How the client starts a daemon (DC-45): through LaunchServices on macOS when
// the CLI's own entry carries com.apple.provenance (the daemon then escapes the
// slow-spawn taint of a directly executed shim), as a detached child otherwise;
// and the start report through which a LaunchServices daemon tells the client
// whether it came up. `open` is stubbed: nothing here starts a real daemon.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import {
  DAEMON_START_TIMEOUT_MS,
  defaultLauncher,
  hasProvenance,
  launchServicesArgs,
  spawnDaemon,
  startDaemon,
  type RunSync,
} from '../../../src/daemon/client.js';
import {
  parseStartReport,
  START_REPORT_ENV,
  START_REPORT_TTL_MS,
  sweepStartReports,
  takeStartReporter,
  watchStartReport,
} from '../../../src/daemon/start-report.js';
import { startFakeDaemon } from '../../helpers/fake-daemon.js';

let root: string;
let paths: HomePaths;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dc-launch-'));
  paths = homePaths(join(root, 'home'));
  await mkdir(paths.home, { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const pending = Symbol('pending');
/** The promise's value if it settles within `ms`, else `pending`. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | typeof pending> =>
  Promise.race([promise, new Promise<typeof pending>((resolve) => setTimeout(() => { resolve(pending); }, ms))]);

describe('daemon launcher', () => {
  it('launch/launch-services-only-on-macos-with-a-provenance-tagged-cli', () => {
    expect(defaultLauncher({ platform: 'darwin', tagged: () => true })).toBe('launch-services');
    expect(defaultLauncher({ platform: 'darwin', tagged: () => false })).toBe('child');
    let asked = false;
    expect(defaultLauncher({ platform: 'linux', tagged: () => (asked = true) })).toBe('child');
    expect(asked).toBe(false);
  });

  it('launch/provenance-read-with-xattr-argv-no-shell', () => {
    const calls: [string, string[]][] = [];
    const run = (status: number): RunSync => (file, args) => {
      calls.push([file, args]);
      return { status };
    };
    expect(hasProvenance('/opt/sample tool/cli.js', run(0))).toBe(true);
    expect(hasProvenance('/opt/sample tool/cli.js', run(1))).toBe(false);
    expect(calls[0]).toEqual(['/usr/bin/xattr', ['-p', 'com.apple.provenance', '/opt/sample tool/cli.js']]);
  });

  it('launch/open-args-carry-env-log-and-daemon-argv', () => {
    const args = launchServicesArgs({
      execPath: '/opt/node/bin/node',
      args: ['/opt/sample/dist/daemon/main.js', '--port', '4555'],
      env: { PATH: '/opt/bin:/usr/bin', DIFFCITY_HOME: '/tmp/dc-x/home', EQUALS: 'a=b', UNSET: undefined },
      log: '/tmp/dc-x/home/daemon.log',
    });
    expect(args).toEqual([
      '-g', '-n', '-a', '/opt/node/bin/node',
      '--stdout', '/tmp/dc-x/home/daemon.log',
      '--stderr', '/tmp/dc-x/home/daemon.log',
      '--env', 'PATH=/opt/bin:/usr/bin',
      '--env', 'DIFFCITY_HOME=/tmp/dc-x/home',
      '--env', 'EQUALS=a=b',
      '--args', '/opt/sample/dist/daemon/main.js', '--port', '4555',
    ]);
  });

  it('launch/launch-services-start-reads-the-early-exit-code-from-the-report', async () => {
    let openArgs: string[] = [];
    const spawned = spawnDaemon({
      paths,
      port: 4555,
      env: { DIFFCITY_HOME: paths.home },
      main: '/opt/sample/main.js',
      launcher: 'launch-services',
      runOpen: (args) => {
        openArgs = args;
        return Promise.resolve(0);
      },
    });
    expect(spawned.pid).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    const reportVar = openArgs.find((arg) => arg.startsWith(`${START_REPORT_ENV}=`));
    expect(reportVar).toBeDefined();
    const report = (reportVar ?? '').slice(START_REPORT_ENV.length + 1);
    expect(report.startsWith(`${paths.home}/start-`)).toBe(true);
    expect(openArgs.slice(-3)).toEqual(['/opt/sample/main.js', '--port', '4555']);
    // The log exists, private, before `open` appends to it.
    expect((await stat(paths.log)).mode & 0o777).toBe(0o600);

    expect(await within(spawned.exited, 100)).toBe(pending);
    await writeFile(report, '3\n');
    expect(await spawned.exited).toBe(3);
    expect(await exists(report)).toBe(false);
  });

  it('launch/open-failure-falls-back-to-a-detached-child', async () => {
    const main = join(root, 'exit-seven.mjs');
    await writeFile(main, 'process.exit(7);\n');
    const spawned = spawnDaemon({ paths, env: { ...process.env }, main, launcher: 'launch-services', runOpen: () => Promise.resolve(1) });
    expect(await spawned.exited).toBe(7);
  });
});

const reports = async (): Promise<string[]> => (await readdir(paths.home)).filter((name) => name.endsWith('.report'));

describe('start report cleanup', () => {
  it('launch/no-report-left-when-the-client-finds-the-daemon-first', async () => {
    // A daemon already answers; `open` returns only after startDaemon found it,
    // and the daemon's `ready` lands in the report before that.
    const fake = await startFakeDaemon(paths);
    try {
      let openReturned: Promise<void> = Promise.resolve();
      const result = await startDaemon({
        paths,
        env: { DIFFCITY_HOME: paths.home },
        spawn: (options) =>
          spawnDaemon({
            ...options,
            launcher: 'launch-services',
            runOpen: async (args) => {
              const report = (args.find((arg) => arg.startsWith(`${START_REPORT_ENV}=`)) ?? '').slice(START_REPORT_ENV.length + 1);
              await writeFile(report, 'ready\n');
              let release = (): void => undefined;
              openReturned = new Promise((resolve) => { release = resolve; });
              setTimeout(release, 200);
              await openReturned;
              return 0;
            },
          }),
      });
      expect(result.ok).toBe(true);
      expect(await reports()).toEqual([]);
      await openReturned;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await reports()).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it('launch/no-report-left-when-the-poll-was-still-running', async () => {
    const fake = await startFakeDaemon(paths);
    try {
      const result = await startDaemon({
        paths,
        spawn: (options) => spawnDaemon({ ...options, launcher: 'launch-services', runOpen: () => Promise.resolve(0) }),
      });
      expect(result.ok).toBe(true);
      expect(await reports()).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it('launch/daemon-removes-its-ready-report-after-the-ttl', async () => {
    const file = join(paths.home, 'start-ab12.report');
    takeStartReporter({ [START_REPORT_ENV]: file }, { cleanupAfterMs: 30 })('ready');
    expect(await readFile(file, 'utf8')).toBe('ready\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await exists(file)).toBe(false);
  });

  it('launch/startup-sweep-removes-only-stale-reports', async () => {
    const stale = join(paths.home, 'start-0a0b.report');
    const fresh = join(paths.home, 'start-0c0d.report');
    const other = join(paths.home, 'start-notes.txt');
    for (const file of [stale, fresh, other]) await writeFile(file, 'ready\n');
    const old = new Date(Date.now() - START_REPORT_TTL_MS - 5000);
    await utimes(stale, old, old);
    await utimes(other, old, old);
    sweepStartReports(paths.home);
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(other)).toBe(true);
    // A missing home is not an error.
    expect(() => { sweepStartReports(join(root, 'missing')); }).not.toThrow();
  });

  it('launch/report-ttl-covers-the-client-wait', () => {
    expect(START_REPORT_TTL_MS).toBeGreaterThanOrEqual(DAEMON_START_TIMEOUT_MS);
  });
});

describe('start report', () => {
  it('launch/report-parses-only-complete-lines', () => {
    expect(parseStartReport('ready\n')).toBe('ready');
    expect(parseStartReport('3\n')).toBe(3);
    expect(parseStartReport('0\n')).toBe(0);
    expect(parseStartReport('3')).toBeNull();
    expect(parseStartReport('')).toBeNull();
    expect(parseStartReport('ready now\n')).toBeNull();
  });

  it('launch/reporter-writes-the-first-outcome-and-leaves-the-env', async () => {
    const file = join(root, 'r.report');
    const env: NodeJS.ProcessEnv = { [START_REPORT_ENV]: file, KEEP: '1' };
    const report = takeStartReporter(env);
    expect(env).toEqual({ KEEP: '1' });
    report('ready');
    report(1);
    expect(await readFile(file, 'utf8')).toBe('ready\n');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // Without the variable, nothing is written anywhere.
    expect(() => { takeStartReporter({})(2); }).not.toThrow();
  });

  it('launch/watch-stops-on-ready-without-resolving', async () => {
    const file = join(root, 'r.report');
    const watched = watchStartReport(file, { timeoutMs: 5000, intervalMs: 10 });
    await writeFile(file, 'ready\n');
    expect(await within(watched.exited, 200)).toBe(pending);
    expect(await exists(file)).toBe(false);
  });

  it('launch/watch-gives-up-after-its-timeout', async () => {
    const file = join(root, 'r.report');
    const watched = watchStartReport(file, { timeoutMs: 30, intervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await writeFile(file, '5\n');
    expect(await within(watched.exited, 100)).toBe(pending);
    expect(await exists(file)).toBe(true);
  });

  it('launch/watch-stop-removes-the-report-and-stops-polling', async () => {
    const file = join(root, 'r.report');
    const watched = watchStartReport(file, { timeoutMs: 5000, intervalMs: 10 });
    watched.stop();
    await writeFile(file, '4\n');
    expect(await within(watched.exited, 100)).toBe(pending);
    watched.stop();
    expect(await exists(file)).toBe(false);
  });
});
