// startDaemon in-process: the plugin API that DC-29 (socket handlers),
// DC-31 (HTTP routes) and DC-33 (watchers) plug into, and the lifecycle order.

import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import type { HealthResponse } from '../../../src/core/model/types.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { startDaemon, type RunningDaemon } from '../../../src/daemon/daemon.js';
import { readDaemonInfo } from '../../../src/daemon/files.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import type { DaemonPlugin } from '../../../src/daemon/plugin.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { openSse } from '../../helpers/daemon.js';

let temp: TempHome;
let paths: HomePaths;
let running: RunningDaemon[];

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
  running = [];
});
afterEach(async () => {
  for (const daemon of running) await daemon.shutdown('test cleanup');
  await temp.cleanup();
});

const quietLog = () => createStreamLogger(new PassThrough());

async function start(plugins: DaemonPlugin[]): Promise<RunningDaemon> {
  const result = await startDaemon({ env: temp.env, port: 0, plugins, log: quietLog() });
  if (result.status !== 'started') throw new Error(`daemon did not start: ${result.status}`);
  running.push(result.daemon);
  return result.daemon;
}

async function getJson(port: number, path: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  return response.json();
}

describe('daemon plugins', () => {
  it('a plugin registers a socket handler and an HTTP route, and feeds the health counter', async () => {
    const plugin: DaemonPlugin = {
      name: 'sample',
      setup(context, http) {
        context.socket.handle('track', (request) => ({ ok: true, repo: { id: 1, name: request.dir } }));
        http.get('/api/sample', () => ({ hello: 'sample-shop' }));
        context.setCollectingCounter(() => 3);
      },
    };
    const daemon = await start([plugin]);
    expect(await sendRequest(daemon.info.socket, { v: 1, type: 'track', dir: '/work/sample-shop', agent: false, at: 'now' })).toEqual({
      ok: true,
      repo: { id: 1, name: '/work/sample-shop' },
    });
    expect(await getJson(daemon.info.port, '/api/sample')).toEqual({ hello: 'sample-shop' });
    expect(((await getJson(daemon.info.port, '/api/health')) as HealthResponse).collecting).toBe(3);
  });

  it('runs setup before listening, start after daemon.json, stop in reverse before the files go', async () => {
    const events: string[] = [];
    const plugin = (name: string): DaemonPlugin => ({
      name,
      setup: async (context) => {
        events.push(`${name}.setup port=${String(context.port())} json=${String((await readDaemonInfo(paths)) !== null)}`);
      },
      start: async (context) => {
        events.push(`${name}.start port>0=${String(context.port() > 0)} json=${String((await readDaemonInfo(paths)) !== null)}`);
      },
      stop: async () => {
        events.push(`${name}.stop json=${String((await readDaemonInfo(paths)) !== null)}`);
      },
    });
    const daemon = await start([plugin('a'), plugin('b')]);
    await daemon.shutdown('test');
    expect(events).toEqual([
      'a.setup port=0 json=false',
      'b.setup port=0 json=false',
      'a.start port>0=true json=true',
      'b.start port>0=true json=true',
      'b.stop json=true',
      'a.stop json=true',
    ]);
    await expect(stat(paths.daemonJson)).rejects.toThrow(/ENOENT/);
  });

  it('a failing plugin stop is logged and the shutdown still cleans up', async () => {
    const daemon = await start([
      {
        name: 'broken',
        stop: () => {
          throw new Error('cannot stop');
        },
      },
    ]);
    await daemon.shutdown('test');
    for (const file of [paths.daemonJson, paths.lock, paths.socket]) await expect(stat(file)).rejects.toThrow(/ENOENT/);
  });

  it('a plugin stop that hangs is abandoned at the deadline; the files are still removed', async () => {
    const result = await startDaemon({
      env: temp.env,
      port: 0,
      log: quietLog(),
      stopTimeoutMs: 200,
      plugins: [{ name: 'hanging', stop: () => new Promise<void>(() => undefined) }],
    });
    if (result.status !== 'started') throw new Error('not started');
    const started = Date.now();
    await result.daemon.shutdown('test');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.daemon.forced).toBe(true);
    for (const file of [paths.daemonJson, paths.lock, paths.socket]) await expect(stat(file)).rejects.toThrow(/ENOENT/);
  });

  it('forceShutdown() ends a shutdown that is waiting on a plugin stop', async () => {
    const result = await startDaemon({
      env: temp.env,
      port: 0,
      log: quietLog(),
      stopTimeoutMs: 60_000,
      plugins: [{ name: 'hanging', stop: () => new Promise<void>(() => undefined) }],
    });
    if (result.status !== 'started') throw new Error('not started');
    const shutdown = result.daemon.shutdown('first signal');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await result.daemon.forceShutdown('second signal');
    await shutdown;
    expect(result.daemon.forced).toBe(true);
    for (const file of [paths.daemonJson, paths.lock, paths.socket]) await expect(stat(file)).rejects.toThrow(/ENOENT/);
  });

  it('a graceful shutdown is not forced', async () => {
    const daemon = await start([]);
    await daemon.shutdown('test');
    expect(daemon.forced).toBe(false);
  });

  it('stop runs once for every plugin whose setup ran, even when its start never did', async () => {
    const events: string[] = [];
    const plugin = (name: string, failSetup = false): DaemonPlugin => ({
      name,
      setup: () => {
        events.push(`${name}.setup`);
        if (failSetup) throw new Error(`${name} setup failed`);
      },
      start: () => {
        events.push(`${name}.start`);
      },
      stop: () => {
        events.push(`${name}.stop`);
      },
    });
    await expect(
      startDaemon({ env: temp.env, port: 0, log: quietLog(), plugins: [plugin('a'), plugin('b', true), plugin('c')] }),
    ).rejects.toThrow(/b setup failed/);
    expect(events).toEqual(['a.setup', 'b.setup', 'b.stop', 'a.stop']);
  });

  it('a failing plugin start stops every plugin once, started or not', async () => {
    const events: string[] = [];
    const plugin = (name: string, failStart = false): DaemonPlugin => ({
      name,
      start: () => {
        events.push(`${name}.start`);
        if (failStart) throw new Error(`${name} start failed`);
      },
      stop: () => {
        events.push(`${name}.stop`);
      },
    });
    await expect(
      startDaemon({ env: temp.env, port: 0, log: quietLog(), plugins: [plugin('a', true), plugin('b')] }),
    ).rejects.toThrow(/a start failed/);
    expect(events).toEqual(['a.start', 'b.stop', 'a.stop']);
    for (const file of [paths.daemonJson, paths.lock, paths.socket]) await expect(stat(file)).rejects.toThrow(/ENOENT/);
  });

  it('a failing plugin setup aborts the start and leaves no files', async () => {
    await expect(
      startDaemon({
        env: temp.env,
        port: 0,
        log: quietLog(),
        plugins: [
          {
            name: 'broken',
            setup: () => {
              throw new Error('no database');
            },
          },
        ],
      }),
    ).rejects.toThrow(/no database/);
    for (const file of [paths.daemonJson, paths.lock, paths.socket]) await expect(stat(file)).rejects.toThrow(/ENOENT/);
  });

  it('broadcast reaches SSE clients', async () => {
    const daemon = await start([]);
    const sse = await openSse(daemon.info.port);
    await sse.until('event: hello');
    daemon.context.broadcast({ event: 'repo', data: { repoId: 9 } });
    expect(await sse.until('event: repo')).toContain('event: repo\ndata: {"repoId":9}\n\n');
    sse.close();
  });

  it('a second start in the same home reports the running daemon', async () => {
    const daemon = await start([]);
    const second = await startDaemon({ env: temp.env, port: 0, plugins: [], log: quietLog() });
    expect(second).toEqual({ status: 'already-running', info: daemon.info, version: daemon.info.version });
    expect(await readFile(paths.lock, 'utf8')).toBe(`${String(process.pid)}\n`);
  });

  it('a socket file bound by another daemon survives this daemon shutdown', async () => {
    const daemon = await start([]);
    // Another process replaced the socket file with its own.
    const { rm } = await import('node:fs/promises');
    await rm(paths.socket);
    const other = createServer();
    await new Promise<void>((resolve) => other.listen(paths.socket, resolve));
    try {
      await daemon.shutdown('test');
      expect((await stat(paths.socket)).isSocket()).toBe(true);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it('a busy port reports port-in-use and releases the lock', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const result = await startDaemon({ env: temp.env, port: address.port, plugins: [], log: quietLog() });
      expect(result).toEqual({ status: 'port-in-use', port: address.port });
      for (const file of [paths.daemonJson, paths.lock, paths.socket]) await expect(stat(file)).rejects.toThrow(/ENOENT/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
