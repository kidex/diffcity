// The socket client (ADR-016) and the helpers that find, start and wait for a
// daemon (ADR-015). The CLI uses it for `up` and `track`, the daemon for the
// "is the lock owner really running" check. It stays light: `track` loads it
// from the shell hook, so it imports node builtins and small core modules only.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { HomePaths } from '../core/home.js';
import type { DaemonInfo, SocketRequest, SocketResponseFor } from '../core/model/types.js';
import { readDaemonInfo, resolvePort } from './files.js';
import { START_REPORT_ENV, startReportPath, watchStartReport, type StartReportWatch } from './start-report.js';

/** Exit code of the daemon script when its port is taken. */
export const EXIT_PORT_IN_USE = 3;

export function portInUseMessage(port: number): string {
  return `port ${String(port)} is in use; pass --port`;
}

/**
 * How long a starting daemon gives a live lock owner to answer `ping` before
 * it takes the lock as stale (a reused pid). Callers that wait for a daemon
 * they spawned must wait longer than this.
 */
export const OWNER_WAIT_MS = 10_000;

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

/** The built CLI entry: the file a globally installed `diffcity` bin executes. */
export const CLI_ENTRY = fileURLToPath(new URL('../cli/index.js', import.meta.url));

/**
 * How spawnDaemon starts the daemon (DC-45):
 * - `child`: a detached child of this process;
 * - `launch-services`: through macOS LaunchServices (`open -a <node>`), so the
 *   daemon is not a descendant of this process.
 */
export type DaemonLauncher = 'child' | 'launch-services';

const OPEN = '/usr/bin/open';
const XATTR = '/usr/bin/xattr';
const PROVENANCE = 'com.apple.provenance';

/** Runs a program without a shell; the subset of spawnSync these helpers use. */
export type RunSync = (file: string, args: string[]) => { status: number | null };

const runSync: RunSync = (file, args) => spawnSync(file, args, { stdio: 'ignore', timeout: 5000 });

/** True when `file` carries the com.apple.provenance extended attribute (macOS). */
export function hasProvenance(file: string, run: RunSync = runSync): boolean {
  return run(XATTR, ['-p', PROVENANCE, file]).status === 0;
}

/**
 * The launcher for this installation. On macOS, a process started by
 * executing a script that carries com.apple.provenance (a bin written by a
 * provenance-tracked process, an agent's `npm link` say) has every process
 * spawn checked by syspolicyd, and so has every process below it: under load,
 * 0.15 to 3 s per spawn, for the daemon's whole life. The taint follows the
 * process tree (a detached child, a re-exec through node, /bin/sh all keep
 * it), so when the CLI's own entry carries the attribute the daemon starts
 * through LaunchServices instead, which makes it a process of its own,
 * whichever way this one was started. Elsewhere it is a detached child.
 */
export function defaultLauncher({
  platform = process.platform,
  tagged = () => hasProvenance(CLI_ENTRY),
}: { platform?: NodeJS.Platform; tagged?: () => boolean } = {}): DaemonLauncher {
  return platform === 'darwin' && tagged() ? 'launch-services' : 'child';
}

/**
 * The `open` arguments that start `<execPath> <args>` through LaunchServices:
 * in the background (`-g`), always a new process (`-n`), with exactly `env`
 * (a launched process otherwise gets launchd's environment, without the
 * user's PATH or DIFFCITY_HOME) and stdout and stderr appended to `log`.
 */
export function launchServicesArgs({
  execPath,
  args,
  env,
  log,
}: {
  execPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  log: string;
}): string[] {
  const vars = Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : ['--env', `${name}=${value}`]));
  return ['-g', '-n', '-a', execPath, '--stdout', log, '--stderr', log, ...vars, '--args', ...args];
}

export interface SpawnDaemonOptions {
  paths: HomePaths;
  /** Passed as `--port`; omitted, the daemon uses state.json or 4321. */
  port?: number;
  env?: NodeJS.ProcessEnv;
  /** The daemon script; defaults to DAEMON_MAIN. */
  main?: string;
  /** Defaults to defaultLauncher(). */
  launcher?: DaemonLauncher;
  /** Runs `open` for the launch-services launcher; resolves with its exit code. Tests inject a stub. */
  runOpen?: (args: string[]) => Promise<number | null>;
}

export interface SpawnedDaemon {
  /** Undefined when the daemon was started through LaunchServices. */
  pid: number | undefined;
  /** Resolves with the exit code if the process exits before it is ready, while this one still runs. */
  exited: Promise<number | null>;
  /** Stops watching the start and removes what it left (the start report); startDaemon calls it on every outcome. */
  dispose?: () => void;
}

/**
 * Starts the daemon detached (ADR-015): its own process group (or, through
 * LaunchServices, its own process outside this one's tree), stdout and stderr
 * appended to daemon.log for anything printed before its logger opens, and
 * nothing that keeps the caller from exiting.
 */
export function spawnDaemon(options: SpawnDaemonOptions): SpawnedDaemon {
  const args = [options.main ?? DAEMON_MAIN];
  if (options.port !== undefined) args.push('--port', String(options.port));
  // The log exists with its mode before anything opens it.
  closeSync(openSync(options.paths.log, 'a', 0o600));
  return (options.launcher ?? defaultLauncher()) === 'launch-services' ? launchDaemon(options, args) : spawnChild(options, args);
}

function spawnChild(options: SpawnDaemonOptions, args: string[]): SpawnedDaemon {
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

const runOpen = (args: string[]): Promise<number | null> =>
  new Promise((resolve) => {
    const child = spawn(OPEN, args, { stdio: 'ignore' });
    child.once('exit', (code) => {
      resolve(code);
    });
    child.once('error', () => {
      resolve(null);
    });
  });

/**
 * Starts the daemon through LaunchServices. It reports `ready` or its early
 * exit code in a file of the home (start-report.ts), which stands in for the
 * exit event of a child. When `open` fails (no GUI session, say), the daemon
 * starts as a detached child instead.
 */
function launchDaemon(options: SpawnDaemonOptions, args: string[]): SpawnedDaemon {
  const report = startReportPath(options.paths.home, randomBytes(6).toString('hex'));
  const env = { ...(options.env ?? process.env), [START_REPORT_ENV]: report };
  const state: { watch: StartReportWatch | null; disposed: boolean } = { watch: null, disposed: false };
  const launched = (options.runOpen ?? runOpen)(launchServicesArgs({ execPath: process.execPath, args, env, log: options.paths.log }));
  const exited = launched.then((code) => {
    if (code !== 0) return spawnChild(options, args).exited;
    if (state.disposed) {
      // The caller found the daemon before `open` returned.
      rmSync(report, { force: true });
      return new Promise<number | null>(() => undefined);
    }
    state.watch = watchStartReport(report, { timeoutMs: DAEMON_START_TIMEOUT_MS });
    return state.watch.exited;
  });
  const dispose = (): void => {
    state.disposed = true;
    state.watch?.stop();
    rmSync(report, { force: true });
  };
  return { pid: undefined, exited, dispose };
}

/**
 * How long a client waits for a daemon it spawned to write daemon.json: longer
 * than the daemon's own wait for a live lock owner (OWNER_WAIT_MS) before it
 * takes the lock over, plus 10 s to start. Used by `up`, `track` and `scan`.
 */
export const DAEMON_START_TIMEOUT_MS = OWNER_WAIT_MS + 10_000;

export type StartDaemonResult =
  | { ok: true; info: DaemonInfo; version: string }
  /** The daemon exited with EXIT_PORT_IN_USE. */
  | { ok: false; reason: 'port-in-use' }
  /** The daemon exited with another code (null: killed by a signal) before it was ready. */
  | { ok: false; reason: 'exited'; exitCode: number | null }
  | { ok: false; reason: 'timeout'; timeoutMs: number };

export interface StartDaemonOptions {
  paths: HomePaths;
  /** Passed as `--port`; omitted, the daemon uses state.json or 4321. */
  port?: number;
  env?: NodeJS.ProcessEnv;
  /** Defaults to spawnDaemon. */
  spawn?: (options: SpawnDaemonOptions) => SpawnedDaemon;
  /** Defaults to DAEMON_START_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Spawns a detached daemon and waits until a daemon answers `ping`. When the
 * spawned process exits with code 0, another daemon won the lock: the wait
 * goes on for that one.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<StartDaemonResult> {
  const { paths } = options;
  const spawnOptions: SpawnDaemonOptions = { paths };
  if (options.port !== undefined) spawnOptions.port = options.port;
  if (options.env !== undefined) spawnOptions.env = options.env;
  const spawned = (options.spawn ?? spawnDaemon)(spawnOptions);
  try {
    return await waitForSpawned(options, spawned);
  } finally {
    spawned.dispose?.();
  }
}

async function waitForSpawned(options: StartDaemonOptions, spawned: SpawnedDaemon): Promise<StartDaemonResult> {
  const { paths } = options;
  const timeoutMs = options.timeoutMs ?? DAEMON_START_TIMEOUT_MS;
  const started = Date.now();
  let ready = await waitForDaemon(paths, { timeoutMs, stop: spawned.exited });
  if (ready === null) {
    const exitCode = await Promise.race([spawned.exited, Promise.resolve('running' as const)]);
    if (exitCode === 0) {
      // Another daemon won the lock; it answered our daemon before this one exited.
      ready = await waitForDaemon(paths, { timeoutMs: Math.max(0, timeoutMs - (Date.now() - started)) });
    } else if (exitCode === EXIT_PORT_IN_USE) {
      return { ok: false, reason: 'port-in-use' };
    } else if (exitCode !== 'running') {
      return { ok: false, reason: 'exited', exitCode };
    }
  }
  if (ready === null) return { ok: false, reason: 'timeout', timeoutMs };
  return { ok: true, ...ready };
}

/** True for the connection errors that mean no daemon listens on the socket. */
export function isNoDaemonError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

export type AutostartResult<T extends SocketRequest['type']> =
  | { ok: true; response: SocketResponseFor<T> }
  /** The request could not be delivered; `error` is a message for the user. */
  | { ok: false; error: string };

export interface RequestWithAutostartOptions extends Omit<StartDaemonOptions, 'paths' | 'port'> {
  /** Wait for the response, per attempt. Defaults to CLIENT_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

/**
 * Sends `request` to the daemon of `paths`, starting the daemon detached when
 * no daemon listens on the socket (ENOENT or ECONNREFUSED, ADR-016). A daemon
 * started here takes its port from state.json, else the default.
 */
export async function requestWithAutostart<R extends SocketRequest>(
  paths: HomePaths,
  request: R,
  options: RequestWithAutostartOptions = {},
): Promise<AutostartResult<R['type']>> {
  const timeoutMs = options.requestTimeoutMs ?? CLIENT_TIMEOUT_MS;
  const send = async (socketPath: string): Promise<AutostartResult<R['type']>> => ({
    ok: true,
    response: await sendRequest(socketPath, request, { timeoutMs }),
  });
  try {
    return await send(paths.socket);
  } catch (error) {
    if (!isNoDaemonError(error)) return { ok: false, error: `cannot reach the daemon: ${messageOf(error)}` };
  }

  const started = await startDaemon({ ...options, paths });
  if (!started.ok) return { ok: false, error: await startFailureMessage(started, paths) };
  try {
    return await send(started.info.socket);
  } catch (error) {
    return { ok: false, error: `cannot reach the daemon: ${messageOf(error)}` };
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The message for a daemon that `track` or `scan` could not start. */
async function startFailureMessage(result: Exclude<StartDaemonResult, { ok: true }>, paths: HomePaths): Promise<string> {
  switch (result.reason) {
    case 'port-in-use':
      return `${portInUseMessage(await resolvePort(paths, undefined))} to diffcity up`;
    case 'exited':
      return `the daemon exited with code ${String(result.exitCode)}; see ${paths.log}`;
    case 'timeout':
      return `the daemon did not start within ${String(result.timeoutMs / 1000)} s; see ${paths.log}`;
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
