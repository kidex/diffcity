// `diffcity up [--port] [--no-open] [--foreground]` (SPEC.md section 3, ADR-015).
// The built CLI starts a detached daemon in a temporary DIFFCITY_HOME; every
// daemon is stopped in afterEach. No test opens a real browser: spawned runs
// pass --no-open, in-process runs inject openUrl.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import type { DaemonInfo } from '../../../src/core/model/types.js';
import { readVersion } from '../../../src/core/version.js';
import { runUp, UP_START_TIMEOUT_MS } from '../../../src/cli/up.js';
import { OWNER_WAIT_MS, sendRequest, spawnDaemon } from '../../../src/daemon/client.js';
import { isProcessAlive, readDaemonInfo, writeDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { CLI_DIST, DAEMON_MAIN_DIST, DaemonTracker, waitFor } from '../../helpers/daemon.js';

let temp: TempHome;
let paths: HomePaths;
const daemons = new DaemonTracker();
const servers: Server[] = [];

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
  daemons.track(temp.home);
});
afterEach(async () => {
  await daemons.cleanup();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await temp.cleanup();
});

const version = readVersion();

async function up(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const run = daemons.cli(['up', ...args], temp.env, temp.userHome);
  const code = await run.exited;
  return { code, stdout: run.stdout(), stderr: run.stderr() };
}

async function listening(): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = portOf(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const missing = (file: string): Promise<boolean> =>
  stat(file).then(
    () => false,
    () => true,
  );

describe('diffcity up', () => {
  it('daemon/up-port-zero: --port 0 starts a detached daemon on a real port, prints its URL, writes no state.json', async () => {
    const result = await up(['--port', '0', '--no-open']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const info = await readDaemonInfo(paths);
    if (info === null) throw new Error('no daemon.json');
    expect(info.port).toBeGreaterThan(0);
    expect(result.stdout).toBe(`http://127.0.0.1:${String(info.port)}\n`);
    expect(isProcessAlive(info.pid)).toBe(true);
    expect(await missing(paths.state)).toBe(true);
    const health = await fetch(`http://127.0.0.1:${String(info.port)}/api/health`);
    expect(health.status).toBe(200);
  });

  it('daemon/up-already-running: a second up prints the same URL and exits 0', async () => {
    await up(['--port', '0', '--no-open']);
    const info = await readDaemonInfo(paths);
    if (info === null) throw new Error('no daemon.json');
    const again = await up(['--no-open']);
    expect(again).toEqual({ code: 0, stdout: `http://127.0.0.1:${String(info.port)}\n`, stderr: '' });

    const other = await up(['--port', String(info.port + 1), '--no-open']);
    expect(other.code).toBe(0);
    expect(other.stdout).toBe(`http://127.0.0.1:${String(info.port)}\n`);
    expect(other.stderr).toBe(`daemon already running on port ${String(info.port)}\n`);
    expect((await readDaemonInfo(paths))?.pid).toBe(info.pid);
  });

  it('up --port N writes state.json, and a later up without --port uses it', async () => {
    const port = await freePort();
    const first = await up(['--port', String(port), '--no-open']);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(`http://127.0.0.1:${String(port)}\n`);
    expect(JSON.parse(await readFile(paths.state, 'utf8'))).toEqual({ port });

    const info = await readDaemonInfo(paths);
    if (info === null) throw new Error('no daemon.json');
    await sendRequest(info.socket, { v: 1, type: 'shutdown' });
    await waitFor(() => missing(paths.lock), 5000, 'the daemon to stop');

    const second = await up(['--no-open']);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(`http://127.0.0.1:${String(port)}\n`);
  });

  it('daemon/up-port-busy: a port taken by another process exits 1 with the message, leaving nothing behind', async () => {
    const port = portOf(await listening());
    const result = await up(['--port', String(port), '--no-open']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`port ${String(port)} is in use; pass --port\n`);
    expect(result.stdout).toBe('');
    for (const file of [paths.daemonJson, paths.lock, paths.state]) expect(await missing(file)).toBe(true);
  });

  it('daemon/version-mismatch-message: a daemon of another version is reported, not restarted', async () => {
    const fake = createServer((socket) => {
      socket.once('data', () => {
        socket.end(`${JSON.stringify({ ok: true, version: '0.0.1', pid: 999_999, port: 4999 })}\n`);
      });
    });
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    await rm(paths.socket, { force: true });
    await new Promise<void>((resolve) => fake.listen(paths.socket, resolve));
    servers.push(fake);
    const info: DaemonInfo = { pid: 999_999, port: 4999, socket: paths.socket, version: '0.0.1', startedAt: '2026-01-01T00:00:00.000Z' };
    await writeDaemonInfo(paths, info);

    const result = await up(['--no-open']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`daemon v0.0.1 is running, CLI is v${version}; stop it and run up again\n`);
    expect(result.stdout).toBe('');
    expect(await missing(paths.lock)).toBe(true);
  });

  it('a daemon.json left by a dead daemon does not stop up from starting a new one', async () => {
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    await writeDaemonInfo(paths, { pid: 999_999, port: 4999, socket: paths.socket, version, startedAt: '2026-01-01T00:00:00.000Z' });
    const result = await up(['--port', '0', '--no-open']);
    expect(result.code).toBe(0);
    const info = await readDaemonInfo(paths);
    expect(info?.pid).not.toBe(999_999);
    expect(result.stdout).toBe(`http://127.0.0.1:${String(info?.port)}\n`);
  });

  it('waits past the owner wait: a lock held by a live non-daemon process is taken over and up succeeds', async () => {
    expect(UP_START_TIMEOUT_MS).toBe(OWNER_WAIT_MS + 10_000);
    // A live process whose pid sits in the lock but never answers ping (a reused pid).
    const holder = daemons.spawn('-e', ['setInterval(() => undefined, 1000)'], temp.env);
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    await writeFile(paths.lock, `${String(holder.child.pid)}\n`);
    const started = Date.now();
    const result = await up(['--port', '0', '--no-open']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(OWNER_WAIT_MS);
    const info = await readDaemonInfo(paths);
    expect(result.stdout).toBe(`http://127.0.0.1:${String(info?.port)}\n`);
    holder.child.kill('SIGKILL');
  }, 60_000);

  it.each(['abc', '-1', '65536', '1.5'])('refuses --port %s', async (port) => {
    const result = await up(['--port', port, '--no-open']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`diffcity up: invalid --port: ${port}\n`);
    expect(await missing(paths.lock)).toBe(true);
  });

  it('--foreground runs the daemon in the CLI process, logging to stderr, until SIGTERM', async () => {
    const run = daemons.cli(['up', '--foreground', '--port', '0', '--no-open'], temp.env, temp.userHome);
    const info = await waitFor(() => readDaemonInfo(paths).then((value) => value ?? undefined), 10_000, 'daemon.json');
    expect(info.pid).toBe(run.child.pid);
    await waitFor(() => run.stdout().includes('\n'), 5000, 'the URL');
    expect(run.stdout()).toBe(`http://127.0.0.1:${String(info.port)}\n`);
    await waitFor(() => run.stderr().includes(' info daemon v'), 5000, 'the log on stderr');
    expect(await missing(paths.log)).toBe(true);
    run.child.kill('SIGTERM');
    expect(await run.exited).toBe(0);
    for (const file of [paths.daemonJson, paths.lock, paths.socket]) expect(await missing(file)).toBe(true);
  });

  it('--foreground on a busy port exits 1 with the message', async () => {
    const port = portOf(await listening());
    const result = await up(['--foreground', '--port', String(port), '--no-open']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`port ${String(port)} is in use; pass --port\n`);
  });
});

describe('up stays light', () => {
  const loadsFastify = (url: string): boolean => url.includes('/node_modules/fastify/') || url.includes('/node_modules/@fastify/');
  const loadsServer = (url: string): boolean => url.endsWith('/dist/daemon/daemon.js') || url.endsWith('/dist/daemon/http/server.js');

  it('up without --foreground loads neither Fastify nor the daemon server', async () => {
    const recorder = fileURLToPath(new URL('../../helpers/import-recorder.mjs', import.meta.url));
    const log = join(temp.root, 'imports.log');
    const env = { ...temp.env, DIFFCITY_TEST_IMPORT_LOG: log };
    const run = daemons.spawn(CLI_DIST, ['up', '--port', '0', '--no-open'], env, temp.userHome, ['--import', recorder]);
    expect(await run.exited).toBe(0);
    const urls = (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '');
    expect(urls.some((url) => url.endsWith('/dist/cli/up.js'))).toBe(true);
    expect(urls.filter(loadsFastify)).toEqual([]);
    expect(urls.filter(loadsServer)).toEqual([]);
  });
});

describe('runUp in-process', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) } };
  };
  const spawnFromDist: typeof spawnDaemon = (options) => spawnDaemon({ ...options, main: DAEMON_MAIN_DIST });

  it('opens the URL unless --no-open', async () => {
    const opened: string[] = [];
    const openUrl = (url: string) => {
      opened.push(url);
      return Promise.resolve(true);
    };
    const first = io();
    expect(await runUp({ port: '0', open: true }, { io: first.io, env: temp.env, openUrl, spawnDaemon: spawnFromDist })).toBe(0);
    const info = await readDaemonInfo(paths);
    const url = `http://127.0.0.1:${String(info?.port)}`;
    expect(opened).toEqual([url]);

    const second = io();
    expect(await runUp({ open: false }, { io: second.io, env: temp.env, openUrl, spawnDaemon: spawnFromDist })).toBe(0);
    expect(opened).toEqual([url]);
    expect(second.out).toEqual([`${url}\n`]);

    const third = io();
    expect(await runUp({ open: true }, { io: third.io, env: temp.env, openUrl, spawnDaemon: spawnFromDist })).toBe(0);
    expect(opened).toEqual([url, url]);
  });

  it('a browser that fails to open is a hint, not an error', async () => {
    const out = io();
    const code = await runUp({ port: '0', open: true }, { io: out.io, env: temp.env, openUrl: () => Promise.resolve(false), spawnDaemon: spawnFromDist });
    expect(code).toBe(0);
    expect(out.err.join('')).toMatch(/^could not open a browser; open http:\/\/127\.0\.0\.1:\d+ yourself\n$/);
  });

  it('a port taken between the check and the daemon start still gives the port message', async () => {
    const port = portOf(await listening());
    const out = io();
    const code = await runUp(
      { port: String(port), open: false },
      { io: out.io, env: temp.env, spawnDaemon: spawnFromDist, isPortFree: () => Promise.resolve(true) },
    );
    expect(code).toBe(1);
    expect(out.err).toEqual([`port ${String(port)} is in use; pass --port\n`]);
  });
});
