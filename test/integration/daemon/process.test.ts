// The daemon script from dist/ as a real process (ADR-015, ADR-016, ADR-017):
// single instance, stale locks, shutdown cleanup, the relocated socket and
// the HTTP surface. Every daemon is stopped in afterEach.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths, MAX_SOCKET_PATH_BYTES, type HomePaths } from '../../../src/core/home.js';
import type { DaemonInfo, HealthResponse } from '../../../src/core/model/types.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { isProcessAlive, readDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { DaemonTracker, openSse, waitFor } from '../../helpers/daemon.js';

let temp: TempHome;
let paths: HomePaths;
const daemons = new DaemonTracker();

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
});
afterEach(async () => {
  await daemons.cleanup();
  await temp.cleanup();
});

const ready = (): Promise<DaemonInfo> => waitFor(() => readDaemonInfo(paths).then((info) => info ?? undefined), 45_000, 'daemon.json');

async function gone(file: string): Promise<boolean> {
  return stat(file).then(
    () => false,
    () => true,
  );
}

describe('daemon process', () => {
  it('writes daemon.json once ready, with a socket that answers ping and an HTTP port', async () => {
    const spawned = daemons.spawnDaemon(temp.env);
    const info = await ready();
    expect(info.pid).toBe(spawned.child.pid);
    expect(info.port).toBeGreaterThan(0);
    expect(info.socket).toBe(paths.socket);
    expect(await readFile(paths.lock, 'utf8')).toBe(`${String(info.pid)}\n`);
    expect(await sendRequest(info.socket, { v: 1, type: 'ping' })).toEqual({ ok: true, version: info.version, pid: info.pid, port: info.port });
    expect((await stat(info.socket)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.home)).mode & 0o777).toBe(0o700);
    expect(await readFile(paths.log, 'utf8')).toMatch(/ready on http:\/\/127\.0\.0\.1:\d+/);
  });

  it('daemon/lock-race: two simultaneous starts leave exactly one daemon', async () => {
    const a = daemons.spawnDaemon(temp.env);
    const b = daemons.spawnDaemon(temp.env);
    const info = await ready();
    const [winner, loser] = info.pid === a.child.pid ? [a, b] : [b, a];
    expect(await loser.exited).toBe(0);
    expect(loser.stdout()).toContain(`daemon already running at http://127.0.0.1:${String(info.port)}`);
    expect(winner.child.exitCode).toBeNull();
    expect(isProcessAlive(info.pid)).toBe(true);
  });

  it('daemon/stale-lock: a lock with a dead pid and a leftover socket are recovered', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    await writeFile(paths.lock, `${dead.stdout}\n`);
    await writeFile(paths.socket, '');
    const spawned = daemons.spawnDaemon(temp.env);
    const info = await ready();
    expect(info.pid).toBe(spawned.child.pid);
    expect(await readFile(paths.lock, 'utf8')).toBe(`${String(info.pid)}\n`);
    expect(await sendRequest(info.socket, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
  });

  it('daemon/stale-lock-race: separate processes racing for a stale lock, exactly one acquires it', async () => {
    const dist = (path: string): string => fileURLToPath(new URL(`../../../dist/${path}`, import.meta.url));
    const release = join(temp.root, 'release');
    // Each racer tries the lock, prints the result, and stays alive (holding a
    // won lock) until the test has every result: an exited winner would make
    // a late racer's takeover legitimate.
    const script = [
      `import { existsSync } from 'node:fs';`,
      `import { acquireLock } from ${JSON.stringify(dist('daemon/files.js'))};`,
      `import { homePaths } from ${JSON.stringify(dist('core/home.js'))};`,
      `const result = await acquireLock(homePaths(process.env.DIFFCITY_HOME), { pid: process.pid });`,
      'process.stdout.write(JSON.stringify(result) + "\\n");',
      `while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
    ].join('\n');
    const race = (): { result: Promise<{ acquired: boolean }>; exited: Promise<number | null> } => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: temp.env, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      const result = new Promise<{ acquired: boolean }>((resolve, reject) => {
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          out += chunk;
          if (out.includes('\n')) resolve(JSON.parse(out) as { acquired: boolean });
        });
        child.once('exit', (code) => {
          reject(new Error(`racer exited with ${String(code)} before reporting`));
        });
      });
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      return { result, exited };
    };
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    for (let run = 0; run < 15; run++) {
      await rm(release, { force: true });
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
      await writeFile(paths.lock, `${dead.stdout}\n`);
      const racers = [race(), race(), race()];
      const results = await Promise.all(racers.map((racer) => racer.result));
      await writeFile(release, '');
      await Promise.all(racers.map((racer) => racer.exited));
      expect(results.filter((result) => result.acquired), `run ${String(run)}`).toHaveLength(1);
    }
    // 15 runs start 60 node processes; under parallel load each start can take seconds.
  }, 180_000);

  it.each(['shutdown request', 'SIGTERM', 'SIGINT'] as const)('daemon/shutdown-cleans-files: %s removes daemon.json, the socket and the lock', async (how) => {
    const spawned = daemons.spawnDaemon(temp.env);
    const info = await ready();
    if (how === 'shutdown request') expect(await sendRequest(info.socket, { v: 1, type: 'shutdown' })).toEqual({ ok: true });
    else spawned.child.kill(how);
    expect(await spawned.exited).toBe(0);
    for (const file of [paths.daemonJson, info.socket, paths.lock]) expect(await gone(file)).toBe(true);
    expect(await readFile(paths.log, 'utf8')).toContain('daemon stopped');
  });

  describe('a signal during startup (DC-56)', () => {
    const stages = ['begin', 'lock-acquired', 'plugins-set-up', 'http-listening', 'socket-listening', 'daemon-json-written', 'plugins-started'] as const;

    it.each(stages.flatMap((stage) => (['SIGINT', 'SIGTERM'] as const).map((signal) => [stage, signal] as const)))(
      'daemon/signal-during-start: %s then %s exits 0 and leaves no files',
      async (stage, signal) => {
        const spawned = daemons.spawnDaemon({ ...temp.env, DIFFCITY_TEST: '1', DIFFCITY_TEST_PAUSE_AT: stage });
        await waitFor(() => spawned.stdout().includes(`paused ${stage}`), 45_000, `the pause at ${stage}`);
        spawned.child.kill(signal);
        expect(await spawned.exited).toBe(0);
        for (const file of [paths.daemonJson, paths.socket, paths.lock]) expect(await gone(file), file).toBe(true);
        expect(spawned.stdout()).not.toContain('listening on');
      },
    );
  });

  describe('the startup pause seam (DC-56)', () => {
    it.each([{ label: 'unset', extra: {} }, { label: '0', extra: { DIFFCITY_TEST: '0' } }])(
      'daemon/pause-seam-guarded: DIFFCITY_TEST=$label ignores DIFFCITY_TEST_PAUSE_AT',
      async ({ extra }) => {
        const spawned = daemons.spawnDaemon({ ...temp.env, ...extra, DIFFCITY_TEST_PAUSE_AT: 'begin' });
        const info = await ready();
        expect(info.pid).toBe(spawned.child.pid);
        expect(spawned.stdout()).not.toContain('paused');
        expect(await sendRequest(info.socket, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
      },
    );
  });

  it('daemon/signal-while-waiting: a second daemon waiting for the lock owner exits 0 on SIGINT and leaves the first daemon alone', async () => {
    const first = daemons.spawnDaemon(temp.env);
    const info = await ready();
    const lockBefore = await readFile(paths.lock, 'utf8');
    const socketBefore = await stat(info.socket);
    // With daemon.json hidden the lock owner does not look like a running
    // daemon, so the second one waits in waitForDaemon.
    const infoText = await readFile(paths.daemonJson, 'utf8');
    await rm(paths.daemonJson);
    const second = daemons.spawnDaemon(temp.env);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(second.child.exitCode, 'the second daemon is still waiting').toBeNull();
    expect(second.stdout()).not.toContain('already running');
    const started = Date.now();
    second.child.kill('SIGINT');
    expect(await second.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    // The first daemon's files are untouched: the second did not write or remove any.
    expect(await gone(paths.daemonJson)).toBe(true);
    expect(await readFile(paths.lock, 'utf8')).toBe(lockBefore);
    const socketAfter = await stat(info.socket);
    expect(socketAfter.ino).toBe(socketBefore.ino);
    expect(first.child.exitCode).toBeNull();
    expect(isProcessAlive(info.pid)).toBe(true);
    await writeFile(paths.daemonJson, infoText);
    expect(await sendRequest(info.socket, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
    const response = await fetch(`http://127.0.0.1:${String(info.port)}/api/health`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as HealthResponse).pid).toBe(info.pid);
    expect(await readDaemonInfo(paths)).toEqual(info);
  });

  it('daemon/shutdown-cleans-files: repeated SIGINTs right after daemon.json never hit the default action', async () => {
    // DIFFCITY_TEST_LOOP raises the count for a soak run.
    const runs = Number(process.env.DIFFCITY_TEST_LOOP ?? 10);
    for (let run = 0; run < runs; run++) {
      const home = await tempHome();
      try {
        const spawned = daemons.spawnDaemon(home.env);
        const info = await waitFor(() => readDaemonInfo(homePaths(home.home)).then((value) => value ?? undefined), 45_000, 'daemon.json');
        spawned.child.kill('SIGINT');
        expect(await spawned.exited, `run ${String(run)}`).toBe(0);
        for (const file of [homePaths(home.home).daemonJson, info.socket, homePaths(home.home).lock]) expect(await gone(file), `run ${String(run)}`).toBe(true);
      } finally {
        await home.cleanup();
      }
    }
  }, 300_000);

  it('shuts down promptly with an SSE client still connected', async () => {
    const spawned = daemons.spawnDaemon(temp.env);
    const info = await ready();
    const sse = await openSse(info.port);
    await sse.until('event: hello');
    const started = Date.now();
    await sendRequest(info.socket, { v: 1, type: 'shutdown' });
    expect(await spawned.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    sse.close();
  });

  describe('shutdown deadline', () => {
    const fixture = fileURLToPath(new URL('../../fixtures/daemon/hanging-stop.mjs', import.meta.url));

    it('a plugin stop that hangs past the deadline: exit 1, files removed', async () => {
      const spawned = daemons.spawn(fixture, ['300'], temp.env);
      await waitFor(() => spawned.stdout().includes('ready'), 45_000, 'ready');
      const started = Date.now();
      spawned.child.kill('SIGTERM');
      expect(await spawned.exited).toBe(1);
      expect(Date.now() - started).toBeLessThan(5000);
      for (const file of [paths.daemonJson, paths.socket, paths.lock]) expect(await gone(file)).toBe(true);
      expect(await readFile(paths.log, 'utf8')).toMatch(/did not stop within 300 ms/);
    });

    it('a second signal forces the exit at once', async () => {
      const spawned = daemons.spawn(fixture, ['60000'], temp.env);
      await waitFor(() => spawned.stdout().includes('ready'), 45_000, 'ready');
      spawned.child.kill('SIGTERM');
      await waitFor(async () => (await readFile(paths.log, 'utf8')).includes('shutting down'), 5000, 'the shutdown to start');
      const started = Date.now();
      spawned.child.kill('SIGINT');
      expect(await spawned.exited).toBe(1);
      expect(Date.now() - started).toBeLessThan(3000);
      for (const file of [paths.daemonJson, paths.socket, paths.lock]) expect(await gone(file)).toBe(true);
    });
  });

  it('daemon/long-home-socket-path: a long home puts the socket in the temporary directory', async () => {
    const longHome = join(temp.root, 'a-rather-long-directory-name-for-the-socket-test', 'x'.repeat(60));
    const env = { ...temp.env, DIFFCITY_HOME: longHome };
    const longPaths = homePaths(longHome);
    expect(Buffer.byteLength(join(longHome, 'daemon.sock'))).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
    const spawned = daemons.spawnDaemon(env);
    const info = await waitFor(() => readDaemonInfo(longPaths).then((value) => value ?? undefined), 45_000, 'daemon.json');
    expect(info.socket).toBe(longPaths.socket);
    expect(info.socket.startsWith(longHome)).toBe(false);
    expect(await sendRequest(info.socket, { v: 1, type: 'shutdown' })).toEqual({ ok: true });
    expect(await spawned.exited).toBe(0);
    expect(await gone(info.socket)).toBe(true);
  });

  it('refuses an invalid --port', async () => {
    const spawned = daemons.spawnDaemon(temp.env, ['--port', 'abc']);
    expect(await spawned.exited).toBe(1);
    expect(spawned.stderr()).toContain('invalid --port: abc');
  });

  it('the daemon keeps running after bad socket requests', async () => {
    daemons.spawnDaemon(temp.env);
    const info = await ready();
    const { connect } = await import('node:net');
    await new Promise<void>((resolve) => {
      const socket = connect(info.socket);
      socket.on('connect', () => socket.end('garbage\n'));
      socket.on('close', () => {
        resolve();
      });
      socket.resume();
    });
    expect(await sendRequest(info.socket, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
  });
});

describe('daemon HTTP', () => {
  it('api/health answers over real HTTP on 127.0.0.1', async () => {
    daemons.spawnDaemon(temp.env);
    const info = await ready();
    const response = await fetch(`http://127.0.0.1:${String(info.port)}/api/health`);
    expect(response.status).toBe(200);
    expect((await response.json()) as HealthResponse).toEqual({ version: info.version, pid: info.pid, startedAt: info.startedAt, collecting: 0 });
  });

  it('api/host-header-rejected: a foreign Host over real HTTP gets 421', async () => {
    daemons.spawnDaemon(temp.env);
    const info = await ready();
    const { request } = await import('node:http');
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: info.port, path: '/api/health', headers: { host: 'rebound.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('sse/hello-and-ping: /api/events sends hello on connect', async () => {
    daemons.spawnDaemon(temp.env);
    const info = await ready();
    const sse = await openSse(info.port);
    expect(sse.contentType).toMatch(/^text\/event-stream/);
    expect(await sse.until('event: hello')).toContain(`data: ${JSON.stringify({ version: info.version, startedAt: info.startedAt })}`);
    sse.close();
  });
});
