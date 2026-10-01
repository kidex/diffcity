// `diffcity up [--port <n>] [--no-open] [--foreground]` (SPEC.md section 3, ADR-015).
// Prints the URL of the running daemon, starting it detached when needed, and
// opens it in the browser. The module stays light: the daemon itself (Fastify)
// is loaded only for --foreground.

import { createServer } from 'node:net';
import { ensureHome, homePaths, resolveHome, type HomePaths } from '../core/home.js';
import type { DaemonInfo } from '../core/model/types.js';
import { readVersion } from '../core/version.js';
import {
  DAEMON_START_TIMEOUT_MS,
  EXIT_PORT_IN_USE,
  findRunningDaemon,
  portInUseMessage,
  spawnDaemon as defaultSpawnDaemon,
  startDaemon,
} from '../daemon/client.js';
import { isPort, resolvePort, writeState } from '../daemon/files.js';
import { openBrowser } from './open.js';

/** How long `up` waits for a detached daemon to write daemon.json (DAEMON_START_TIMEOUT_MS). */
export const UP_START_TIMEOUT_MS = DAEMON_START_TIMEOUT_MS;

export interface UpCommandOptions {
  port?: string;
  /** False with --no-open. */
  open?: boolean;
  foreground?: boolean;
}

export interface UpDeps {
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  env?: NodeJS.ProcessEnv;
  /** Opens the URL; resolves false when no browser could be opened. Defaults to openBrowser. */
  openUrl?: (url: string) => Promise<boolean>;
  spawnDaemon?: typeof defaultSpawnDaemon;
  /** Whether 127.0.0.1:<port> can be bound right now. */
  isPortFree?: (port: number) => Promise<boolean>;
  startTimeoutMs?: number;
}

const urlOf = (info: Pick<DaemonInfo, 'port'>): string => `http://127.0.0.1:${String(info.port)}`;

function parsePort(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return isPort(port) ? port : null;
}

/** True unless something already listens on 127.0.0.1:<port>. Other bind errors are left to the daemon. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code !== 'EADDRINUSE');
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

export async function runUp(options: UpCommandOptions, deps: UpDeps): Promise<number> {
  const { io } = deps;
  const env = deps.env ?? process.env;
  const explicitPort = parsePort(options.port);
  if (explicitPort === null) {
    io.stderr(`diffcity up: invalid --port: ${String(options.port)}\n`);
    return 1;
  }
  const shouldOpen = options.open !== false;
  const openUrl = deps.openUrl ?? ((url: string) => openBrowser(url));
  const cliVersion = readVersion();

  let paths: HomePaths;
  try {
    paths = homePaths(resolveHome(env));
    await ensureHome(paths.home);
  } catch (error) {
    io.stderr(`diffcity up: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  /** Prints the URL (or the version mismatch) for a running daemon and opens it. */
  const report = async (info: DaemonInfo, version: string, startedByUs: boolean): Promise<number> => {
    if (version !== cliVersion) {
      io.stderr(`daemon v${version} is running, CLI is v${cliVersion}; stop it and run up again\n`);
      return 1;
    }
    if (!startedByUs && explicitPort !== undefined && explicitPort !== 0 && explicitPort !== info.port) {
      io.stderr(`daemon already running on port ${String(info.port)}\n`);
    }
    if (explicitPort !== undefined && explicitPort !== 0 && explicitPort === info.port) {
      await writeState(paths, { port: explicitPort });
    }
    const url = urlOf(info);
    io.stdout(`${url}\n`);
    if (shouldOpen && !(await openUrl(url))) io.stderr(`could not open a browser; open ${url} yourself\n`);
    return 0;
  };

  const running = await findRunningDaemon(paths);
  if (running !== null) return report(running.info, running.version, false);

  const port = await resolvePort(paths, explicitPort);
  if (port !== 0 && !(await (deps.isPortFree ?? isPortFree)(port))) {
    io.stderr(`${portInUseMessage(port)}\n`);
    return 1;
  }

  if (options.foreground === true) return runForeground(port, env, io, report);

  const timeoutMs = deps.startTimeoutMs ?? UP_START_TIMEOUT_MS;
  const started = await startDaemon({ paths, port, env, spawn: deps.spawnDaemon ?? defaultSpawnDaemon, timeoutMs });
  if (!started.ok) {
    switch (started.reason) {
      case 'port-in-use':
        io.stderr(`${portInUseMessage(port)}\n`);
        break;
      case 'exited':
        io.stderr(`diffcity up: the daemon exited with code ${String(started.exitCode)}; see ${paths.log}\n`);
        break;
      case 'timeout':
        io.stderr(`diffcity up: the daemon did not start within ${String(timeoutMs / 1000)} s; see ${paths.log}\n`);
        break;
    }
    return 1;
  }
  return report(started.info, started.version, true);
}

/** --foreground: the daemon runs in this process, logging to stderr, until SIGTERM, SIGINT or `shutdown`. */
async function runForeground(
  port: number,
  env: NodeJS.ProcessEnv,
  io: UpDeps['io'],
  report: (info: DaemonInfo, version: string, startedByUs: boolean) => Promise<number>,
): Promise<number> {
  const [{ runDaemon }, { createStreamLogger }] = await Promise.all([import('../daemon/run.js'), import('../daemon/log.js')]);
  let reported = 0;
  const exitCode = await runDaemon(
    { env, port, log: createStreamLogger(process.stderr) },
    {
      err: io.stderr,
      onReady: async (info, alreadyRunning) => {
        reported = await report(info, info.version, !alreadyRunning);
      },
    },
  );
  if (exitCode === EXIT_PORT_IN_USE) return 1;
  return exitCode === 0 ? reported : exitCode;
}
