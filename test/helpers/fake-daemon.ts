// A stand-in daemon for CLI tests (ADR-016): the real socket server and
// protocol v1 in this process, with `track` and `register` answered by test
// handlers and every request recorded. It writes daemon.json like a real
// daemon, so the CLI finds it the same way. No collection, no HTTP, no DB.

import { PassThrough } from 'node:stream';
import { identifyRepo } from '../../src/core/changes/identity.js';
import { ensureHome, type HomePaths } from '../../src/core/home.js';
import type { DaemonInfo, SocketRequest, SocketResponseFor } from '../../src/core/model/types.js';
import { readVersion } from '../../src/core/version.js';
import type { SpawnDaemonOptions, SpawnedDaemon } from '../../src/daemon/client.js';
import { writeDaemonInfo } from '../../src/daemon/files.js';
import { createStreamLogger } from '../../src/daemon/log.js';
import { createSocketServer, type SocketRequestOf } from '../../src/daemon/socket/server.js';

export interface FakeDaemonHandlers {
  track?: (request: SocketRequestOf<'track'>) => SocketResponseFor<'track'> | Promise<SocketResponseFor<'track'>>;
  register?: (request: SocketRequestOf<'register'>) => SocketResponseFor<'register'>;
}

export interface FakeDaemon {
  /** Every track and register request, in arrival order. */
  readonly requests: SocketRequest[];
  readonly info: DaemonInfo;
  close(): Promise<void>;
}

/** Default handlers: track identifies the repo like the daemon does; register counts dirs it saw before as known. */
function defaultHandlers(): Required<FakeDaemonHandlers> {
  const known = new Set<string>();
  let nextId = 1;
  return {
    track: async (request) => ({ ok: true, repo: { id: nextId++, name: (await identifyRepo(request.dir)).name } }),
    register: (request) => {
      let registered = 0;
      for (const dir of request.dirs) {
        if (known.has(dir)) continue;
        known.add(dir);
        registered++;
      }
      return { ok: true, registered, known: request.dirs.length - registered };
    },
  };
}

/** Listens on the home's socket and writes daemon.json. */
export async function startFakeDaemon(paths: HomePaths, handlers: FakeDaemonHandlers = {}): Promise<FakeDaemon> {
  await ensureHome(paths.home);
  const { track, register } = { ...defaultHandlers(), ...handlers };
  const requests: SocketRequest[] = [];
  const info: DaemonInfo = { pid: process.pid, port: 4999, socket: paths.socket, version: readVersion(), startedAt: new Date().toISOString() };
  const server = createSocketServer({
    path: paths.socket,
    log: createStreamLogger(new PassThrough()),
    ping: () => ({ ok: true, version: info.version, pid: info.pid, port: info.port }),
    shutdown: () => undefined,
  });
  server.handlers.handle('track', (request) => {
    requests.push(request);
    return track(request);
  });
  server.handlers.handle('register', (request) => {
    requests.push(request);
    return register(request);
  });
  await server.listen();
  await writeDaemonInfo(paths, info);
  return { requests, info, close: () => server.close() };
}

/**
 * A spawnDaemon replacement that starts a fake daemon instead of a process.
 * `started` holds the fake once it listens; `calls` counts the spawns.
 */
export function fakeSpawner(handlers: FakeDaemonHandlers = {}): {
  spawn: (options: SpawnDaemonOptions) => SpawnedDaemon;
  readonly calls: SpawnDaemonOptions[];
  started: () => Promise<FakeDaemon>;
} {
  const calls: SpawnDaemonOptions[] = [];
  let starting: Promise<FakeDaemon> | null = null;
  return {
    calls,
    spawn: (options) => {
      calls.push(options);
      // Like a real daemon, it becomes ready a little after the spawn.
      starting ??= new Promise((resolve) => setTimeout(resolve, 50)).then(() => startFakeDaemon(options.paths, handlers));
      return { pid: undefined, exited: new Promise(() => undefined) };
    },
    started: () => {
      if (starting === null) throw new Error('the daemon was never spawned');
      return starting;
    },
  };
}
