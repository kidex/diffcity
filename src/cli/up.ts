// `diffcity up [--port <n>] [--no-open] [--foreground]` (SPEC.md section 3, ADR-015).
// Prints the URL of the running daemon, starting it detached when needed, and
// opens it in the browser. The module stays light: the daemon itself (Fastify)
// is loaded only for --foreground.

import { ensureHome, homePaths, resolveHome, type HomePaths } from '../core/home.js';
import type { DaemonInfo } from '../core/model/types.js';
import { DAEMON_START_TIMEOUT_MS, EXIT_PORT_IN_USE, type spawnDaemon as defaultSpawnDaemon } from '../daemon/client.js';
import { acceptDaemon, ensureDaemon, parsePort, urlOf, type EnsureDaemonOptions } from './ensure-daemon.js';
import { openBrowser } from './open.js';

export { isPortFree } from './ensure-daemon.js';

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

  let paths: HomePaths;
  try {
    paths = homePaths(resolveHome(env));
    await ensureHome(paths.home);
  } catch (error) {
    io.stderr(`diffcity up: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  /** Prints the URL of a running daemon and opens it. */
  const show = async (info: DaemonInfo): Promise<number> => {
    const url = urlOf(info);
    io.stdout(`${url}\n`);
    if (shouldOpen && !(await openUrl(url))) io.stderr(`could not open a browser; open ${url} yourself\n`);
    return 0;
  };

  const ensureOptions: EnsureDaemonOptions = { command: 'up', paths, explicitPort };
  if (options.foreground === true) {
    ensureOptions.runInstead = (port) =>
      runForeground(port, env, io, async (info, startedByUs) =>
        (await acceptDaemon(ensureOptions, io, info, info.version, startedByUs)) ? show(info) : 1,
      );
  }
  const result = await ensureDaemon(ensureOptions, {
    io,
    env,
    ...(deps.spawnDaemon === undefined ? {} : { spawnDaemon: deps.spawnDaemon }),
    ...(deps.isPortFree === undefined ? {} : { isPortFree: deps.isPortFree }),
    startTimeoutMs: deps.startTimeoutMs ?? UP_START_TIMEOUT_MS,
  });
  return result.status === 'ready' ? show(result.info) : result.code;
}

/** --foreground: the daemon runs in this process, logging to stderr, until SIGTERM, SIGINT or `shutdown`. */
async function runForeground(
  port: number,
  env: NodeJS.ProcessEnv,
  io: UpDeps['io'],
  report: (info: DaemonInfo, startedByUs: boolean) => Promise<number>,
): Promise<number> {
  const [{ runDaemon }, { createStreamLogger }] = await Promise.all([import('../daemon/run.js'), import('../daemon/log.js')]);
  let reported = 0;
  const exitCode = await runDaemon(
    { env, port, log: createStreamLogger(process.stderr) },
    {
      err: io.stderr,
      onReady: async (info, alreadyRunning) => {
        reported = await report(info, !alreadyRunning);
      },
    },
  );
  if (exitCode === EXIT_PORT_IN_USE) return 1;
  return exitCode === 0 ? reported : exitCode;
}
