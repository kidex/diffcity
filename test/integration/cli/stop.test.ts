// `diffcity stop` edge cases (SPEC.md section 3, ADR-015) against stand-in
// daemons in this process: a stale daemon.json, a daemon that ignores
// `shutdown`, a hung daemon, and a new daemon that starts while stop waits.
// stop never signals a process; the happy paths run on the built CLI in
// start-stop.test.ts.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStop, type StopDeps } from '../../../src/cli/stop.js';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import type { DaemonInfo } from '../../../src/core/model/types.js';
import { readVersion } from '../../../src/core/version.js';
import { isProcessAlive, writeDaemonInfo } from '../../../src/daemon/files.js';
import { startFakeDaemon, type FakeDaemon } from '../../helpers/fake-daemon.js';
import { tempHome, type TempHome } from '../../helpers/config.js';

let temp: TempHome;
let paths: HomePaths;
const servers: Server[] = [];
const sockets: Socket[] = [];
const fakes: FakeDaemon[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const fake of fakes.splice(0)) await fake.close();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await temp.cleanup();
});

async function stop(deps: Partial<StopDeps> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runStop({
    io: { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
    env: temp.env,
    ...deps,
  });
  return { code, stdout, stderr };
}

const infoFor = (pid: number): DaemonInfo => ({
  pid,
  port: 4999,
  socket: paths.socket,
  version: readVersion(),
  startedAt: '2026-01-01T00:00:00.000Z',
});

/** A socket server whose `respond` decides the answer to each request line (null: never answer). */
async function listen(respond: (request: { type: string }, socket: Socket) => object | null): Promise<Server> {
  await rm(paths.socket, { force: true });
  const server = createServer((socket) => {
    sockets.push(socket);
    let received = '';
    socket.setEncoding('utf8').on('data', (chunk: string) => {
      received += chunk;
      if (!received.includes('\n')) return;
      const answer = respond(JSON.parse(received.split('\n', 1)[0] ?? '') as { type: string }, socket);
      if (answer !== null) socket.end(`${JSON.stringify(answer)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
  servers.push(server);
  return server;
}

/** A live process that stands in for a daemon's pid; stop must never signal it. */
function idleProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  children.push(child);
  if (child.pid === undefined) throw new Error('no pid');
  return child;
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

describe('diffcity stop, edge cases', () => {
  it('cli/stop-stale-daemon-json: a daemon.json of a dead pid with no socket is "not running", files untouched', async () => {
    await writeDaemonInfo(paths, infoFor(999_999));
    await writeFile(paths.lock, '999999\n');
    const before = await readFile(paths.daemonJson, 'utf8');

    expect(await stop()).toEqual({ code: 0, stdout: 'not running\n', stderr: '' });
    expect(await readFile(paths.daemonJson, 'utf8')).toBe(before);
    expect(await readFile(paths.lock, 'utf8')).toBe('999999\n');
  });

  it('cli/stop-hung-daemon: a daemon that never answers is reported, exit 1, and no process is signalled', async () => {
    const child = idleProcess();
    const pid = child.pid ?? 0;
    await listen(() => null);
    await writeDaemonInfo(paths, infoFor(pid));

    const result = await stop({ pingTimeoutMs: 300 });
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: `diffcity stop: the daemon (pid ${String(pid)}) does not answer; see ${paths.log}\n`,
    });
    expect(isProcessAlive(pid)).toBe(true);
    expect(await exists(paths.daemonJson)).toBe(true);
  });

  it('cli/stop-slow-ping: a daemon that answers ping late is still stopped', async () => {
    const child = idleProcess();
    const pid = child.pid ?? 0;
    let pings = 0;
    await listen((request, socket) => {
      if (request.type === 'ping') {
        pings++;
        // The first ping (findRunningDaemon) gets no answer; the retry does.
        return pings === 1 ? null : { ok: true, version: readVersion(), pid, port: 4999 };
      }
      setTimeout(() => {
        child.kill('SIGKILL');
        void rm(paths.daemonJson, { force: true });
        socket.destroy();
        servers.splice(0).forEach((server) => server.close());
      }, 20);
      return { ok: true };
    });
    await writeDaemonInfo(paths, infoFor(pid));

    expect(await stop({ pingTimeoutMs: 3000 })).toEqual({ code: 0, stdout: 'stopped\n', stderr: '' });
  }, 15_000);

  it('cli/stop-shutdown-ignored: a daemon that answers shutdown but never exits makes stop fail after its timeout', async () => {
    fakes.push(await startFakeDaemon(paths));
    const result = await stop({ timeoutMs: 300 });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`diffcity stop: the daemon (pid ${String(process.pid)}) did not stop within 0.3 s; see ${paths.log}\n`);
  });

  it('cli/stop-concurrent-start: a new daemon that starts while stop waits does not turn the stop into a timeout', async () => {
    const old = idleProcess();
    const oldPid = old.pid ?? 0;
    await writeFile(paths.lock, `${String(oldPid)}\n`);
    await writeDaemonInfo(paths, infoFor(oldPid));
    await listen((request) => {
      if (request.type === 'ping') return { ok: true, version: readVersion(), pid: oldPid, port: 4999 };
      setTimeout(() => {
        void (async () => {
          // The old daemon exits; a new one (this process) takes the lock, the socket and daemon.json at once.
          old.kill('SIGKILL');
          for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
          await writeFile(paths.lock, `${String(process.pid)}\n`);
          fakes.push(await startFakeDaemon(paths));
        })();
      }, 20);
      return { ok: true };
    });

    expect(await stop({ timeoutMs: 5000 })).toEqual({ code: 0, stdout: 'stopped\n', stderr: '' });
  }, 15_000);

  it('cli/stop-successor-while-old-alive: stop keeps waiting while the old pid lives, even once a successor holds the lock and daemon.json', async () => {
    const old = idleProcess();
    const oldPid = old.pid ?? 0;
    await writeFile(paths.lock, `${String(oldPid)}\n`);
    await writeDaemonInfo(paths, infoFor(oldPid));
    let successorReady = false;
    const timeline: { oldKilledAt: number | null } = { oldKilledAt: null };
    await listen((request) => {
      if (request.type === 'ping') return { ok: true, version: readVersion(), pid: oldPid, port: 4999 };
      setTimeout(() => {
        void (async () => {
          // A successor (this process) takes the lock, the socket and daemon.json while the old pid is still alive.
          for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
          await writeFile(paths.lock, `${String(process.pid)}\n`);
          fakes.push(await startFakeDaemon(paths));
          successorReady = true;
          // Only well after that does the old process exit.
          setTimeout(() => {
            old.kill('SIGKILL');
            timeline.oldKilledAt = Date.now();
          }, 600);
        })();
      }, 20);
      return { ok: true };
    });

    const result = await stop({ timeoutMs: 5000 });
    const returnedAt = Date.now();

    expect(result).toEqual({ code: 0, stdout: 'stopped\n', stderr: '' });
    expect(successorReady).toBe(true);
    // stop returned only after the old pid was gone, not as soon as the successor appeared.
    expect(timeline.oldKilledAt).not.toBeNull();
    expect(returnedAt).toBeGreaterThanOrEqual(timeline.oldKilledAt ?? Number.POSITIVE_INFINITY);
    expect(isProcessAlive(oldPid)).toBe(false);
  }, 15_000);
});
