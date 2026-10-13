// `diffcity start [<dir>]` and `diffcity stop` (SPEC.md section 3, ADR-015,
// ADR-016) through the built CLI in a temporary DIFFCITY_HOME. Spawned runs
// pass --no-open; the in-process run injects the opener. Every daemon is
// stopped in afterEach.

import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStart } from '../../../src/cli/start.js';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import type { RepoSummary } from '../../../src/core/model/types.js';
import { spawnDaemon } from '../../../src/daemon/client.js';
import { isProcessAlive, readDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { listenOn } from '../../helpers/port.js';
import { DAEMON_MAIN_DIST, DaemonTracker } from '../../helpers/daemon.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

let temp: TempHome;
let paths: HomePaths;
let shop: TempRepo;
let orders: TempRepo;
const daemons = new DaemonTracker();

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
  daemons.track(temp.home);
  shop = await createRepo({ name: 'sample-shop', files: { 'src/cart.ts': 'export const cart = 1;\n' } });
  orders = await createRepo({ name: 'order-service', files: { 'src/order.ts': 'export const order = 1;\n' } });
});
afterEach(async () => {
  await daemons.cleanup();
  await shop.cleanup();
  await orders.cleanup();
  await temp.cleanup();
});

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], cwd: string): Promise<CliRun> {
  const run = daemons.cli(args, temp.env, cwd);
  const code = await run.exited;
  return { code, stdout: run.stdout(), stderr: run.stderr() };
}

const missing = (file: string): Promise<boolean> =>
  stat(file).then(
    () => false,
    () => true,
  );

async function runningPort(): Promise<number> {
  const info = await readDaemonInfo(paths);
  if (info === null) throw new Error('no daemon.json');
  expect(isProcessAlive(info.pid)).toBe(true);
  return info.port;
}

async function repos(port: number): Promise<RepoSummary[]> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/repos`);
  expect(response.status).toBe(200);
  return (await response.json()) as RepoSummary[];
}

/** The repo URL printed by start, split into port and repo id. */
function parseRepoUrl(stdout: string): { port: number; id: number } {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/#\/repo\/(\d+)\n$/.exec(stdout);
  if (match === null) throw new Error(`unexpected start output: ${JSON.stringify(stdout)}`);
  return { port: Number(match[1]), id: Number(match[2]) };
}

describe('diffcity start', () => {
  it('cli/start-in-repo: inside a repo, starts the daemon, registers the repo as active and prints its URL', async () => {
    const run = await cli(['start', '--port', '0', '--no-open'], join(shop.dir, 'src'));
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const { port, id } = parseRepoUrl(run.stdout);
    expect(port).toBe(await runningPort());
    const listed = await repos(port);
    expect(listed.map((repo) => [repo.id, repo.name, repo.active])).toEqual([[id, 'sample-shop', true]]);
  });

  it('cli/start-with-path: registers the repo at <dir>, relative to the cwd', async () => {
    const run = await cli(['start', 'sample-shop', '--port', '0', '--no-open'], join(shop.dir, '..'));
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const { port, id } = parseRepoUrl(run.stdout);
    expect((await repos(port)).map((repo) => [repo.id, repo.name])).toEqual([[id, 'sample-shop']]);
  });

  it('cli/start-outside-repo: outside any repo, starts the daemon and opens the Fleet with a one-line hint', async () => {
    const run = await cli(['start', '--port', '0', '--no-open'], temp.userHome);
    expect(run.code).toBe(0);
    const port = await runningPort();
    expect(run.stdout).toBe(`http://127.0.0.1:${String(port)}/#/\n`);
    expect(run.stderr).toBe('not inside a git repository: opening the Fleet; run diffcity start <dir> to open a repo\n');
    expect(run.stderr.split('\n')).toHaveLength(2);
    expect(await repos(port)).toEqual([]);
  });

  it('cli/start-not-a-repo: a <dir> that is not a git repo exits 1 with a clear error and starts nothing', async () => {
    const plain = join(temp.root, 'plain-folder');
    await mkdir(plain);
    const run = await cli(['start', plain, '--port', '0', '--no-open'], temp.userHome);
    expect(run).toEqual({ code: 1, stdout: '', stderr: `diffcity start: not a git repository: ${plain}\n` });
    expect(await missing(paths.lock)).toBe(true);
    expect(await missing(paths.daemonJson)).toBe(true);
  });

  it('cli/start-second-run: a second start while the daemon runs adds the repo to the same daemon', async () => {
    const first = await cli(['start', '--port', '0', '--no-open'], shop.dir);
    expect(first.code).toBe(0);
    const before = await readDaemonInfo(paths);
    if (before === null) throw new Error('no daemon.json');

    const second = await cli(['start', '--no-open'], orders.dir);
    expect(second.stderr).toBe('');
    expect(second.code).toBe(0);
    const { port, id } = parseRepoUrl(second.stdout);
    expect(port).toBe(before.port);
    expect((await readDaemonInfo(paths))?.pid).toBe(before.pid);
    const listed = await repos(port);
    expect(listed.map((repo) => repo.name).sort()).toEqual(['order-service', 'sample-shop']);
    expect(listed.find((repo) => repo.name === 'order-service')?.id).toBe(id);
  });

  it('cli/start-opens-url: opens the printed repo URL in the browser', async () => {
    const opened: string[] = [];
    let stdout = '';
    let stderr = '';
    const code = await runStart(undefined, { port: '0' }, {
      io: { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
      env: temp.env,
      cwd: shop.dir,
      openUrl: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      spawnDaemon: (options) => spawnDaemon({ ...options, main: DAEMON_MAIN_DIST }),
    });
    expect(stderr).toBe('');
    expect(code).toBe(0);
    parseRepoUrl(stdout);
    expect(opened).toEqual([stdout.trimEnd()]);
  });

  it('cli/start-port-wildcard: a port held on 0.0.0.0 exits 1 with the port message, as on 127.0.0.1 (DC-117)', async () => {
    const blocker = await listenOn('0.0.0.0');
    try {
      const run = await cli(['start', '--port', String(blocker.port), '--no-open'], shop.dir);
      expect(run).toEqual({ code: 1, stdout: '', stderr: `port ${String(blocker.port)} is in use; pass --port\n` });
      expect(await missing(paths.lock)).toBe(true);
    } finally {
      await blocker.close();
    }
  });

  it('cli/start-bad-port: an invalid --port exits 1 before anything starts', async () => {
    const run = await cli(['start', '--port', 'abc', '--no-open'], shop.dir);
    expect(run).toEqual({ code: 1, stdout: '', stderr: 'diffcity start: invalid --port: abc\n' });
    expect(await missing(paths.lock)).toBe(true);
  });
});

describe('diffcity stop', () => {
  it('cli/stop: stops the daemon and returns once it has exited and its files are gone', async () => {
    const started = await cli(['start', '--port', '0', '--no-open'], shop.dir);
    expect(started.code).toBe(0);
    const info = await readDaemonInfo(paths);
    if (info === null) throw new Error('no daemon.json');

    const run = await cli(['stop'], temp.userHome);
    expect(run).toEqual({ code: 0, stdout: 'stopped\n', stderr: '' });
    expect(isProcessAlive(info.pid)).toBe(false);
    for (const file of [paths.daemonJson, paths.lock, info.socket]) expect(await missing(file)).toBe(true);
  });

  it('cli/stop-not-running: with no daemon, prints "not running" and exits 0', async () => {
    const run = await cli(['stop'], temp.userHome);
    expect(run).toEqual({ code: 0, stdout: 'not running\n', stderr: '' });
    expect(await missing(paths.home)).toBe(true);
  });
});
