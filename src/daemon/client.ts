// The socket client (ADR-016) and the helpers that find, start and wait for a
// daemon (ADR-015). The CLI uses it for `up` and `track`, the daemon for the
// "is the lock owner really running" check. It stays light: `track` loads it
// from the shell hook, so it imports node builtins and small core modules only.

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { HomePaths } from '../core/home.js';
import type { DaemonInfo, SocketRequest, SocketResponseFor } from '../core/model/types.js';
import { readDaemonInfo } from './files.js';

/** Exit code of the daemon script when its port is taken. */
export const EXIT_PORT_IN_USE = 3;

export function portInUseMessage(port: number): string {
  return `port ${String(port)} is in use; pass --port`;
}

/** Default wait for one socket exchange. */
export const CLIENT_TIMEOUT_MS = 5000;

/**
 * Sends one request and resolves with the parsed response line. Rejects with
 * the connection error (`code` ENOENT or ECONNREFUSED when no daemon listens),
 * on a timeout, or when the response is not JSON.
 */
export function sendRequest<R extends SocketRequest>(
  socketPath: string,
  request: R,
  { timeoutMs = CLIENT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<SocketResponseFor<R['type']>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let received = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        reject(Object.assign(new Error(`no response from the daemon within ${String(timeoutMs)} ms`), { code: 'ETIMEDOUT' }));
      });
    }, timeoutMs);

    const finish = (): void => {
      const line = received.split('\n', 1)[0] ?? '';
      settle(() => {
        try {
          // The daemon is the other end of the protocol; its responses are trusted to match the request type.
          resolve(JSON.parse(line) as SocketResponseFor<R['type']>);
        } catch {
          reject(new Error(`invalid response from the daemon: ${JSON.stringify(line)}`));
        }
      });
    };

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (received.includes('\n')) finish();
    });
    socket.on('end', finish);
    socket.on('error', (error) => {
      settle(() => {
        reject(error);
      });
    });
  });
}

/** daemon.json when the daemon it describes answers `ping`; null otherwise. */
export async function findRunningDaemon(
  paths: HomePaths,
  { timeoutMs = 2000 }: { timeoutMs?: number } = {},
): Promise<{ info: DaemonInfo; version: string } | null> {
  const info = await readDaemonInfo(paths);
  if (info === null) return null;
  try {
    const response = await sendRequest(info.socket, { v: 1, type: 'ping' }, { timeoutMs });
    if (!response.ok) return null;
    return { info: { ...info, pid: response.pid, port: response.port }, version: response.version };
  } catch {
    return null;
  }
}

/** The built daemon entry, next to this module in dist/daemon/. */
export const DAEMON_MAIN = fileURLToPath(new URL('./main.js', import.meta.url));

export interface SpawnDaemonOptions {
  paths: HomePaths;
  /** Passed as `--port`; omitted, the daemon uses state.json or 4321. */
  port?: number;
  env?: NodeJS.ProcessEnv;
  /** The daemon script; defaults to DAEMON_MAIN. */
  main?: string;
}

export interface SpawnedDaemon {
  pid: number | undefined;
  /** Resolves with the exit code if the process exits while this one still runs. */
  exited: Promise<number | null>;
}

/**
 * Starts the daemon detached (ADR-015): its own process group, stdout and
 * stderr appended to daemon.log for anything printed before its logger opens,
 * and unref'd so the caller can exit.
 */
export function spawnDaemon(options: SpawnDaemonOptions): SpawnedDaemon {
  const args = [options.main ?? DAEMON_MAIN];
  if (options.port !== undefined) args.push('--port', String(options.port));
  const logFd = openSync(options.paths.log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: options.env ?? process.env,
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
      child.once('error', () => {
        resolve(null);
      });
    });
    child.unref();
    return { pid: child.pid, exited };
  } finally {
    closeSync(logFd);
  }
}

/**
 * Polls daemon.json until a daemon answers `ping`, up to `timeoutMs`. Stops
 * early with `null` when `stop` resolves first (the spawned process exited).
 */
export async function waitForDaemon(
  paths: HomePaths,
  { timeoutMs, stop }: { timeoutMs: number; stop?: Promise<unknown> },
): Promise<{ info: DaemonInfo; version: string } | null> {
  const state = { stopped: false };
  void stop?.then(() => {
    state.stopped = true;
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const running = await findRunningDaemon(paths, { timeoutMs: 1000 });
    if (running !== null) return running;
    if (state.stopped || Date.now() >= deadline) return null;
    await sleep(50);
  }
}
