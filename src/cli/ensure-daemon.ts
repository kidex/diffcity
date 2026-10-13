// Finds the running daemon or starts one detached, with the rules of
// `diffcity up` (SPEC.md section 3, ADR-015). Shared by `up` and `start`.
// The module stays light: no Fastify, no parser.

import type { HomePaths } from '../core/home.js';
import type { DaemonInfo } from '../core/model/types.js';
import { readVersion } from '../core/version.js';
import {
  DAEMON_START_TIMEOUT_MS,
  findRunningDaemon,
  portInUseMessage,
  spawnDaemon as defaultSpawnDaemon,
  startDaemon,
} from '../daemon/client.js';
import { isPort, resolvePort, writeState } from '../daemon/files.js';
import { isPortFree } from '../daemon/port.js';

export { isPortFree } from '../daemon/port.js';

export interface CliStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface EnsureDaemonDeps {
  io: CliStreams;
  env: NodeJS.ProcessEnv;
  spawnDaemon?: typeof defaultSpawnDaemon;
  /** Whether nothing accepts a connection on <port> at 127.0.0.1 or ::1 (src/daemon/port.ts). */
  isPortFree?: (port: number) => Promise<boolean>;
  /** Defaults to DAEMON_START_TIMEOUT_MS. */
  startTimeoutMs?: number;
}

export interface EnsureDaemonOptions {
  /** `up` or `start`: prefixes the error messages. */
  command: string;
  paths: HomePaths;
  /** The parsed --port; undefined when not given. */
  explicitPort: number | undefined;
  /**
   * Runs instead of a detached start when no daemon is running and the port is
   * free (`up --foreground`); its result is the exit code.
   */
  runInstead?: (port: number) => Promise<number>;
}

export type EnsureDaemonResult =
  /** A daemon of this version answers on the socket. */
  | { status: 'ready'; info: DaemonInfo }
  /** Nothing more to do: `code` is the exit code; any error was printed. */
  | { status: 'done'; code: number };

export const urlOf = (info: Pick<DaemonInfo, 'port'>): string => `http://127.0.0.1:${String(info.port)}`;

/** The --port value: undefined when absent, null when invalid. */
export function parsePort(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return isPort(port) ? port : null;
}

/**
 * Accepts a running daemon: false (after printing why) when its version is not
 * the CLI's. Warns when an explicit --port differs from the running daemon's,
 * and records an explicit port the daemon runs on in state.json.
 */
export async function acceptDaemon(
  options: EnsureDaemonOptions,
  io: CliStreams,
  info: DaemonInfo,
  version: string,
  startedByUs: boolean,
): Promise<boolean> {
  const cliVersion = readVersion();
  if (version !== cliVersion) {
    io.stderr(`daemon v${version} is running, CLI is v${cliVersion}; stop it and run ${options.command} again\n`);
    return false;
  }
  const { explicitPort, paths } = options;
  if (!startedByUs && explicitPort !== undefined && explicitPort !== 0 && explicitPort !== info.port) {
    io.stderr(`daemon already running on port ${String(info.port)}\n`);
  }
  if (explicitPort !== undefined && explicitPort !== 0 && explicitPort === info.port) {
    await writeState(paths, { port: explicitPort });
  }
  return true;
}

/** The running daemon, or a newly started one when none answers `ping`. */
export async function ensureDaemon(options: EnsureDaemonOptions, deps: EnsureDaemonDeps): Promise<EnsureDaemonResult> {
  const { io } = deps;
  const { command, paths } = options;
  const accept = async (info: DaemonInfo, version: string, startedByUs: boolean): Promise<EnsureDaemonResult> =>
    (await acceptDaemon(options, io, info, version, startedByUs)) ? { status: 'ready', info } : { status: 'done', code: 1 };

  const running = await findRunningDaemon(paths);
  if (running !== null) return accept(running.info, running.version, false);

  const port = await resolvePort(paths, options.explicitPort);
  if (port !== 0 && !(await (deps.isPortFree ?? isPortFree)(port))) {
    io.stderr(`${portInUseMessage(port)}\n`);
    return { status: 'done', code: 1 };
  }

  if (options.runInstead !== undefined) return { status: 'done', code: await options.runInstead(port) };

  const timeoutMs = deps.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS;
  const started = await startDaemon({ paths, port, env: deps.env, spawn: deps.spawnDaemon ?? defaultSpawnDaemon, timeoutMs });
  if (!started.ok) {
    switch (started.reason) {
      case 'port-in-use':
        io.stderr(`${portInUseMessage(port)}\n`);
        break;
      case 'exited':
        io.stderr(`diffcity ${command}: the daemon exited with code ${String(started.exitCode)}; see ${paths.log}\n`);
        break;
      case 'timeout':
        io.stderr(`diffcity ${command}: the daemon did not start within ${String(timeoutMs / 1000)} s; see ${paths.log}\n`);
        break;
    }
    return { status: 'done', code: 1 };
  }
  return accept(started.info, started.version, true);
}
