// A single daemon instance (ADR-015): the lock, the HTTP server (ADR-017), the
// socket server (ADR-016) and daemon.json, written only once both listen.
// Shutdown stops the servers and the plugins, then removes daemon.json, the
// socket and the lock, in that order.

import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { ensureHome, homePaths, resolveHome } from '../core/home.js';
import type { DaemonInfo } from '../core/model/types.js';
import { readVersion } from '../core/version.js';
import { findRunningDaemon, OWNER_WAIT_MS, waitForDaemon } from './client.js';
import { acquireLock, isProcessAlive, releaseLock, removeDaemonFiles, resolvePort, writeDaemonInfo } from './files.js';
import { buildHttpServer, HTTP_HOST } from './http/server.js';
import { createFileLogger, errorMessage, type Logger } from './log.js';
import type { DaemonContext, DaemonPlugin } from './plugin.js';
import { daemonPlugins } from './plugins.js';
import { isPortFree } from './port.js';
import { createSocketServer } from './socket/server.js';
import { createSseHub } from './sse.js';

/** The built UI: dist/ui at the package root, from both src/daemon/ and dist/daemon/. */
export const DEFAULT_UI_DIR = fileURLToPath(new URL('../../dist/ui/', import.meta.url));

/** How long a shutdown waits for the servers and the plugins to stop before it is forced. */
// 15 s: an agent run that ignores SIGTERM gets SIGKILL after 10 s (ADR-029),
// and its agent-run event must still be recorded before the shutdown is forced.
export const SHUTDOWN_TIMEOUT_MS = 15_000;

export { OWNER_WAIT_MS } from './client.js';

export interface StartDaemonOptions {
  env?: NodeJS.ProcessEnv;
  /** The port; omitted, state.json or 4321. 0 picks a free port. */
  port?: number;
  /** Defaults to daemon.log in the home, rotated at 5 MB. */
  log?: Logger;
  plugins?: readonly DaemonPlugin[];
  uiDir?: string;
  ownerWaitMs?: number;
  /** Defaults to SHUTDOWN_TIMEOUT_MS. */
  stopTimeoutMs?: number;
  /**
   * Aborted by the caller on SIGINT/SIGTERM during startup: startDaemon stops at
   * the next step, closes what is open, removes the files it created, releases
   * the lock and resolves `{ status: 'aborted' }`.
   */
  signal?: AbortSignal;
  /**
   * Test seam: awaited after each startup stage (see StartupStage), before the
   * abort check. The daemon script uses it to pause a startup at a chosen stage.
   */
  onStage?: (stage: StartupStage) => void | Promise<void>;
}

/** The startup steps, in order; each name is reached once the step has completed. */
export const STARTUP_STAGES = ['begin', 'lock-acquired', 'plugins-set-up', 'http-listening', 'socket-listening', 'daemon-json-written', 'plugins-started'] as const;
export type StartupStage = (typeof STARTUP_STAGES)[number];

export interface RunningDaemon {
  readonly info: DaemonInfo;
  readonly context: DaemonContext;
  /**
   * Graceful shutdown; idempotent. The servers and the plugins get
   * `stopTimeoutMs` to stop; past that the shutdown is forced. daemon.json, the
   * socket and the lock are removed either way.
   */
  shutdown(reason: string): Promise<void>;
  /** Stops waiting for the servers and the plugins (a second signal): removes the files and resolves `closed`. */
  forceShutdown(reason: string): Promise<void>;
  /** True once a shutdown was forced, by the deadline or by forceShutdown(). */
  readonly forced: boolean;
  /** Resolves once a shutdown has finished. */
  readonly closed: Promise<void>;
}

export type StartResult =
  | { status: 'started'; daemon: RunningDaemon }
  | { status: 'already-running'; info: DaemonInfo; version: string }
  | { status: 'port-in-use'; port: number }
  | { status: 'aborted' };

export async function startDaemon(options: StartDaemonOptions = {}): Promise<StartResult> {
  const env = options.env ?? process.env;
  const paths = homePaths(resolveHome(env));
  await ensureHome(paths.home);
  const ownsLog = options.log === undefined;
  const log = options.log ?? createFileLogger(paths.log);
  const pid = process.pid;
  const version = readVersion();

  const fail = <T>(result: T): T => {
    if (ownsLog) log.close();
    return result;
  };
  // Runs the test seam, then tells whether the caller asked to abort.
  const reached = async (stage: StartupStage): Promise<boolean> => {
    await options.onStage?.(stage);
    return options.signal?.aborted === true;
  };
  const aborted = new Promise<void>((resolve) => {
    if (options.signal?.aborted === true) resolve();
    else options.signal?.addEventListener('abort', () => { resolve(); }, { once: true });
  });

  if (await reached('begin')) return fail({ status: 'aborted' });

  // The single instance: the lock, or the daemon that owns it.
  let lock = await acquireLock(paths, { pid });
  if (!lock.acquired) {
    const owner = lock.owner;
    log.info(`lock held by pid ${String(owner)}; waiting for it to answer ping (pid ${String(pid)})`);
    const running = await waitForDaemon(paths, { timeoutMs: options.ownerWaitMs ?? OWNER_WAIT_MS, stop: aborted });
    if (running !== null) return fail({ status: 'already-running', info: running.info, version: running.version });
    if (options.signal?.aborted === true) return fail({ status: 'aborted' });
    log.warn(`lock owner pid ${String(owner)} does not answer ping; taking the lock as stale`);
    lock = await acquireLock(paths, { pid, isAlive: (candidate) => candidate !== owner && isProcessAlive(candidate) });
    if (!lock.acquired) {
      const again = await findRunningDaemon(paths);
      if (again !== null) return fail({ status: 'already-running', info: again.info, version: again.version });
      fail(null);
      throw new Error(`another daemon (pid ${String(lock.owner)}) holds ${paths.lock} but does not answer`);
    }
  }

  if (await reached('lock-acquired')) {
    await releaseLock(paths, pid);
    return fail({ status: 'aborted' });
  }

  const startedAt = new Date().toISOString();
  const plugins = options.plugins ?? daemonPlugins;
  let port = 0;
  let collecting = (): number => 0;
  let shutdownPromise: Promise<void> | null = null;
  let forced = false;
  let forceNow = (): void => undefined;
  const forceRequested = new Promise<string>((resolve) => {
    forceNow = () => {
      resolve('forced');
    };
  });
  let resolveClosed = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const sse = createSseHub({ hello: () => ({ version, startedAt }) });
  const socketServer = createSocketServer({
    path: paths.socket,
    log,
    ping: () => ({ ok: true, version, pid, port }),
    shutdown: () => {
      context.requestShutdown('shutdown request');
    },
  });

  const context: DaemonContext = {
    version,
    pid,
    startedAt,
    paths,
    env,
    log,
    broadcast: (event) => {
      sse.broadcast(event);
    },
    socket: socketServer.handlers,
    setCollectingCounter: (count) => {
      collecting = count;
    },
    port: () => port,
    requestShutdown: (reason) => {
      void shutdown(reason);
    },
  };

  const http = await buildHttpServer({
    version,
    pid,
    startedAt,
    uiDir: options.uiDir ?? DEFAULT_UI_DIR,
    sse,
    collecting: () => collecting(),
    log,
    port: () => port,
  });

  // stop runs at most once per plugin, for every plugin whose setup was called.
  const stopped = new Set<DaemonPlugin>();
  const stopPlugins = async (started: readonly DaemonPlugin[]): Promise<void> => {
    for (const plugin of [...started].reverse()) {
      if (stopped.has(plugin)) continue;
      stopped.add(plugin);
      try {
        await plugin.stop?.(context);
      } catch (error) {
        log.error(`plugin ${plugin.name} failed to stop: ${errorMessage(error)}`);
      }
    }
  };

  const setUp: DaemonPlugin[] = [];
  async function shutdown(reason: string): Promise<void> {
    const step = async (name: string, run: () => unknown): Promise<void> => {
      try {
        await run();
      } catch (error) {
        log.error(`shutdown: ${name} failed: ${errorMessage(error)}`);
      }
    };
    shutdownPromise ??= (async () => {
      log.info(`shutting down: ${reason}`);
      const stopTimeoutMs = options.stopTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
      let deadline: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        (async () => {
          await step('closing SSE', () => {
            sse.close();
          });
          await step('closing the socket server', () => socketServer.close());
          await step('closing the HTTP server', () => http.close());
          await stopPlugins(setUp);
          return 'stopped';
        })(),
        new Promise<string>((resolve) => {
          deadline = setTimeout(() => {
            resolve('timeout');
          }, stopTimeoutMs);
        }),
        forceRequested,
      ]);
      clearTimeout(deadline);
      if (outcome === 'timeout') log.error(`the daemon did not stop within ${String(stopTimeoutMs)} ms; forcing the exit`);
      if (outcome === 'forced') log.warn('shutdown forced; not waiting for the plugins to stop');
      forced = outcome !== 'stopped';
      await step('removing the daemon files', () => removeDaemonFiles(paths, socketServer.bound(), pid));
      log.info('daemon stopped');
      if (ownsLog) log.close();
      resolveClosed();
    })();
    return shutdownPromise;
  }

  // The signal arrived during startup: the regular shutdown closes what is open
  // and removes the files created so far, and releases the lock.
  const abortStart = async (): Promise<StartResult> => {
    await shutdown('signal during startup');
    return { status: 'aborted' };
  };

  try {
    for (const plugin of plugins) {
      setUp.push(plugin);
      await plugin.setup?.(context, http);
    }
    if (await reached('plugins-set-up')) return await abortStart();
    const wanted = await resolvePort(paths, options.port);
    // The CLI's check before the start, again (DC-117): a port taken on a
    // wildcard after that check does not stop the 127.0.0.1 bind on macOS.
    let inUse = wanted !== 0 && !(await isPortFree(wanted));
    if (!inUse) {
      try {
        await http.listen({ host: HTTP_HOST, port: wanted });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        inUse = true;
      }
    }
    if (inUse) {
      log.error(`port ${String(wanted)} is in use`);
      await http.close();
      await stopPlugins(setUp);
      await releaseLock(paths, pid);
      return fail({ status: 'port-in-use', port: wanted });
    }
    port = (http.server.address() as AddressInfo).port;
    if (await reached('http-listening')) return await abortStart();
    await socketServer.listen();
    if (await reached('socket-listening')) return await abortStart();

    const info: DaemonInfo = { pid, port, socket: paths.socket, version, startedAt };
    await writeDaemonInfo(paths, info);
    if (await reached('daemon-json-written')) return await abortStart();
    log.info(`daemon v${version} ready on http://${HTTP_HOST}:${String(port)} (pid ${String(pid)}, socket ${paths.socket})`);

    for (const plugin of plugins) await plugin.start?.(context);
    if (await reached('plugins-started')) return await abortStart();
    const daemon: RunningDaemon = {
      info,
      context,
      shutdown,
      forceShutdown: async (reason) => {
        log.warn(`forcing the shutdown: ${reason}`);
        forceNow();
        await shutdown(reason);
      },
      get forced() {
        return forced;
      },
      closed,
    };
    return { status: 'started', daemon };
  } catch (error) {
    log.error(`daemon failed to start: ${errorMessage(error)}`);
    await shutdown('start failed');
    throw error;
  }
}
