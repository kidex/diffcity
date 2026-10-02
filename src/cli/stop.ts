// `diffcity stop` (SPEC.md section 3, ADR-015): sends `shutdown` over the
// socket and returns once the daemon process has exited and removed
// daemon.json, the lock and the socket. With no daemon running it says so and
// succeeds. It never creates the home.

import { readFile, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { homePaths, resolveHome, type HomePaths } from '../core/home.js';
import { CLIENT_TIMEOUT_MS, findRunningDaemon, isNoDaemonError, sendRequest } from '../daemon/client.js';
import { isProcessAlive, readDaemonInfo } from '../daemon/files.js';
import type { CliStreams } from './ensure-daemon.js';

/**
 * How long stop waits for the daemon to exit: the daemon's own shutdown
 * deadline (SHUTDOWN_TIMEOUT_MS in src/daemon/daemon.ts, 10 s) plus time to
 * remove its files and exit.
 */
export const STOP_TIMEOUT_MS = 15_000;

export interface StopDeps {
  io: CliStreams;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * Second `ping` wait for a daemon that did not answer the quick first one;
   * defaults to CLIENT_TIMEOUT_MS.
   */
  pingTimeoutMs?: number;
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

async function readLockPid(paths: HomePaths): Promise<number | null> {
  const text = await readFile(paths.lock, 'utf8').catch(() => null);
  if (text === null) return null;
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * True once `pid` has exited and its files are gone. A daemon started in the
 * meantime (another pid in daemon.json or the lock) owns the files it wrote,
 * the socket included, so they do not keep the stop waiting.
 */
async function stopped(paths: HomePaths, pid: number, socket: string): Promise<boolean> {
  if (isProcessAlive(pid)) return false;
  const info = await readDaemonInfo(paths);
  const lockPid = await readLockPid(paths);
  if (info?.pid === pid || lockPid === pid) return false;
  if (await exists(paths.lock) && lockPid === null) return false;
  const successor = (info !== null && info.pid !== pid) || (lockPid !== null && lockPid !== pid);
  return successor || !(await exists(socket));
}

/**
 * The daemon to stop. A daemon that misses the quick ping gets a second, longer
 * one on the socket from daemon.json: no listener there means not running,
 * anything else (a timeout, a bad answer) means a daemon that does not answer.
 */
async function findTarget(
  paths: HomePaths,
  pingTimeoutMs: number,
): Promise<{ pid: number; socket: string } | { hung: number } | 'not running'> {
  const running = await findRunningDaemon(paths);
  if (running !== null) return { pid: running.info.pid, socket: running.info.socket };
  const info = await readDaemonInfo(paths);
  if (info === null) return 'not running';
  try {
    const response = await sendRequest(info.socket, { v: 1, type: 'ping' }, { timeoutMs: pingTimeoutMs });
    return response.ok ? { pid: response.pid, socket: info.socket } : { hung: info.pid };
  } catch (error) {
    return isNoDaemonError(error) ? 'not running' : { hung: info.pid };
  }
}

/** Runs the command; resolves with the process exit code (0 or 1). */
export async function runStop(deps: StopDeps): Promise<number> {
  const { io } = deps;
  const fail = (message: string): number => {
    io.stderr(`diffcity stop: ${message}\n`);
    return 1;
  };
  let paths: HomePaths;
  try {
    paths = homePaths(resolveHome(deps.env ?? process.env));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const target = await findTarget(paths, deps.pingTimeoutMs ?? CLIENT_TIMEOUT_MS);
  if (target === 'not running') {
    io.stdout('not running\n');
    return 0;
  }
  if ('hung' in target) return fail(`the daemon (pid ${String(target.hung)}) does not answer; see ${paths.log}`);
  const { pid, socket } = target;
  try {
    const response = await sendRequest(socket, { v: 1, type: 'shutdown' });
    if (!response.ok) return fail(response.error);
  } catch (error) {
    // The daemon went away between ping and shutdown: still wait for its files.
    if (!isNoDaemonError(error)) return fail(`cannot reach the daemon: ${error instanceof Error ? error.message : String(error)}`);
  }

  const timeoutMs = deps.timeoutMs ?? STOP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (!(await stopped(paths, pid, socket))) {
    if (Date.now() >= deadline) {
      return fail(`the daemon (pid ${String(pid)}) did not stop within ${String(timeoutMs / 1000)} s; see ${paths.log}`);
    }
    await sleep(25);
  }
  io.stdout('stopped\n');
  return 0;
}
