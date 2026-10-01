// `diffcity stop` (SPEC.md section 3, ADR-015): sends `shutdown` over the
// socket and returns once the daemon process has exited and removed
// daemon.json, the lock and the socket. With no daemon running it says so and
// succeeds. It never creates the home.

import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { homePaths, resolveHome, type HomePaths } from '../core/home.js';
import { findRunningDaemon, isNoDaemonError, sendRequest } from '../daemon/client.js';
import { isProcessAlive } from '../daemon/files.js';
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
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

async function stopped(paths: HomePaths, pid: number, socket: string): Promise<boolean> {
  if (isProcessAlive(pid)) return false;
  for (const file of [paths.daemonJson, paths.lock, socket]) if (await exists(file)) return false;
  return true;
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

  const running = await findRunningDaemon(paths);
  if (running === null) {
    io.stdout('not running\n');
    return 0;
  }
  const { pid, socket } = running.info;
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
