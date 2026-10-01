// Runs a daemon in the current process until it shuts down: the daemon script
// (main.ts) and `diffcity up --foreground` both go through here. SIGTERM,
// SIGINT and the `shutdown` socket request stop it gracefully (ADR-015).

import type { DaemonInfo } from '../core/model/types.js';
import { EXIT_PORT_IN_USE, portInUseMessage } from './client.js';
import { startDaemon, type RunningDaemon, type StartDaemonOptions } from './daemon.js';
import { errorMessage } from './log.js';

export interface RunDaemonHooks {
  /** Printed output (the URL, "already running"); stdout for the script. */
  out: (text: string) => void;
  /** Errors; stderr. */
  err: (text: string) => void;
  /** Called once the daemon is ready, or when another one already runs. */
  onReady?: (info: DaemonInfo, alreadyRunning: boolean) => void | Promise<void>;
}

export function daemonUrl(info: Pick<DaemonInfo, 'port'>): string {
  return `http://127.0.0.1:${String(info.port)}`;
}

/** Resolves with the process exit code once the daemon has stopped (or did not start). */
export async function runDaemon(options: StartDaemonOptions, hooks: RunDaemonHooks): Promise<number> {
  let result;
  try {
    result = await startDaemon(options);
  } catch (error) {
    hooks.err(`diffcity daemon: ${errorMessage(error)}\n`);
    return 1;
  }

  if (result.status === 'port-in-use') {
    hooks.err(`${portInUseMessage(result.port)}\n`);
    return EXIT_PORT_IN_USE;
  }
  if (result.status === 'already-running') {
    hooks.out(`daemon already running at ${daemonUrl(result.info)} (pid ${String(result.info.pid)})\n`);
    await hooks.onReady?.(result.info, true);
    return 0;
  }

  const { daemon } = result;
  return untilStopped(daemon, async () => {
    hooks.out(`diffcity daemon listening on ${daemonUrl(daemon.info)} (pid ${String(daemon.info.pid)})\n`);
    await hooks.onReady?.(daemon.info, false);
  });
}

async function untilStopped(daemon: RunningDaemon, ready: () => Promise<void>): Promise<number> {
  let exitCode = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    void daemon.shutdown(signal);
  };
  const onCrash = (error: unknown): void => {
    exitCode = 1;
    daemon.context.log.error(`uncaught error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    void daemon.shutdown('uncaught error');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
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
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  }
  return exitCode;
}
