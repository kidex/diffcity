// Runs a daemon in the current process until it shuts down: the daemon script
// (main.ts) and `diffcity up --foreground` both go through here. SIGTERM,
// SIGINT and the `shutdown` socket request stop it gracefully (ADR-015).

import type { DaemonInfo } from '../core/model/types.js';
import { EXIT_PORT_IN_USE, portInUseMessage } from './client.js';
import { startDaemon, type RunningDaemon, type StartDaemonOptions, type StartupStage } from './daemon.js';
import { errorMessage } from './log.js';

export interface RunDaemonHooks {
  /** Errors (the port message, a failed start); stderr. */
  err: (text: string) => void;
  /**
   * Called once the daemon is ready (`alreadyRunning` false), or when another
   * daemon already holds the home. A throw is logged; the daemon keeps running.
   */
  onReady: (info: DaemonInfo, alreadyRunning: boolean) => void | Promise<void>;
  /**
   * Called once runDaemon handles SIGTERM and SIGINT, before anything of the
   * daemon exists: the daemon entry (main.ts) handles them until then.
   */
  onSignalsHandled?: () => void;
  /** Test seam: awaited after each startup stage; the signal aborts the startup (see StartDaemonOptions.onStage). */
  onStage?: (stage: StartupStage, signal: AbortSignal) => void | Promise<void>;
}

export function daemonUrl(info: Pick<DaemonInfo, 'port'>): string {
  return `http://127.0.0.1:${String(info.port)}`;
}

/**
 * Resolves with the process exit code once the daemon has stopped (or did not
 * start): 1 when the shutdown was forced. The caller exits the process with it,
 * since a forced shutdown may leave a plugin's handles open.
 */
export async function runDaemon(options: StartDaemonOptions, hooks: RunDaemonHooks): Promise<number> {
  // The handlers go in before anything observable (daemon.json, the socket, the
  // ready output) exists, so a signal at any point of the startup is handled:
  // during the startup it aborts it cleanly, afterwards it shuts the daemon down.
  // The first SIGTERM/SIGINT is graceful (up to the deadline); a second
  // one stops waiting for the plugins.
  const abort = new AbortController();
  let daemon: RunningDaemon | null = null;
  let signals = 0;
  let forceStart = (): void => undefined;
  const startForced = new Promise<'forced'>((resolve) => {
    forceStart = () => {
      resolve('forced');
    };
  });
  const onSignal = (signal: NodeJS.Signals): void => {
    signals++;
    if (daemon === null) {
      if (signals === 1) abort.abort();
      else forceStart();
    } else if (signals === 1) void daemon.shutdown(signal);
    else void daemon.forceShutdown(`second signal (${signal})`);
  };
  const signalNames = ['SIGTERM', 'SIGINT'] as const;
  for (const name of signalNames) process.on(name, onSignal);
  hooks.onSignalsHandled?.();
  try {
    const stage = hooks.onStage;
    const starting = startDaemon({
      ...options,
      signal: abort.signal,
      ...(stage === undefined ? {} : { onStage: (name: StartupStage) => stage(name, abort.signal) }),
    });
    const raced = await Promise.race([starting.then((value) => ({ value })), startForced]).catch((error: unknown) => {
      hooks.err(`diffcity daemon: ${errorMessage(error)}\n`);
      return 'failed' as const;
    });
    if (raced === 'failed') return 1;
    if (raced === 'forced') return 1;
    const result = raced.value;

    if (result.status === 'aborted') return 0;
    if (result.status === 'port-in-use') {
      hooks.err(`${portInUseMessage(result.port)}\n`);
      return EXIT_PORT_IN_USE;
    }
    if (result.status === 'already-running') {
      await hooks.onReady(result.info, true);
      return 0;
    }

    const started = result.daemon;
    daemon = started;
    // A signal that arrived after the last startup checkpoint.
    if (abort.signal.aborted) void started.shutdown('signal during startup');
    return await untilStopped(started, async () => {
      await hooks.onReady(started.info, false);
    });
  } finally {
    for (const name of signalNames) process.off(name, onSignal);
  }
}

async function untilStopped(daemon: RunningDaemon, ready: () => Promise<void>): Promise<number> {
  let exitCode = 0;
  const onCrash = (error: unknown): void => {
    exitCode = 1;
    daemon.context.log.error(`uncaught error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    void daemon.shutdown('uncaught error');
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  try {
    try {
      await ready();
    } catch (error) {
      // Opening the browser or printing failed; the daemon itself is fine.
      daemon.context.log.warn(`after start: ${errorMessage(error)}`);
    }
    await daemon.closed;
  } finally {
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  }
  // A forced shutdown left a plugin running: the caller must exit the process.
  return daemon.forced ? 1 : exitCode;
}
