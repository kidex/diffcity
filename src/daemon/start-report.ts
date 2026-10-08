// How a daemon tells the client that started it whether it came up (DC-45).
// A daemon launched through LaunchServices is not a child of that client, so
// the client cannot see its exit code. The client passes a file in
// START_REPORT_ENV; the daemon writes `ready` there once it answers on its
// socket, or its exit code when it exits before that (a failed import of its
// own modules included: main.ts loads them after installing the reporter).
// A daemon killed by a signal writes nothing: the client then waits until its
// start timeout, as it would for a daemon that never answers.
//
// Nobody leaves a report behind: the client removes the file once it is done
// waiting, whatever the outcome; a daemon that reported `ready` removes it
// after START_REPORT_TTL_MS (the client may have stopped watching before the
// report was written); and a starting daemon removes reports older than that
// (a killed client, a killed daemon). Node builtins only: the socket client
// and the daemon entry load this before anything else.

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Environment variable carrying the report file to a daemon. */
export const START_REPORT_ENV = 'DIFFCITY_START_REPORT';

/**
 * How long a report may live: at least the client's whole wait for a daemon
 * it spawned (DAEMON_START_TIMEOUT_MS, 20 s; a unit test keeps them in line).
 */
export const START_REPORT_TTL_MS = 30_000;

/** Report file names, `start-<hex>.report`, in the home. */
const REPORT_NAME = /^start-[0-9a-f]+\.report$/;

/** `ready`, or the exit code of a daemon that exited before it was ready. */
export type StartReport = 'ready' | number;

/** A new report path in `home`. */
export function startReportPath(home: string, id: string): string {
  return join(home, `start-${id}.report`);
}

/**
 * Takes the report file out of `env` (so the daemon's own children never see
 * it) and returns the function that writes the first outcome to it; later
 * calls do nothing. Without the variable, the function does nothing. After
 * `ready`, the file is removed `cleanupAfterMs` later by an unref'd timer.
 */
export function takeStartReporter(
  env: NodeJS.ProcessEnv = process.env,
  { cleanupAfterMs = START_REPORT_TTL_MS }: { cleanupAfterMs?: number } = {},
): (outcome: StartReport) => void {
  const file = env[START_REPORT_ENV];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removes one known variable from the environment.
  delete env[START_REPORT_ENV];
  let reported = file === undefined || file === '';
  return (outcome) => {
    if (reported || file === undefined) return;
    reported = true;
    try {
      writeFileSync(file, `${String(outcome)}\n`, { mode: 0o600 });
    } catch {
      // The client then waits for daemon.json until its timeout, as before.
      return;
    }
    if (outcome === 'ready') {
      setTimeout(() => {
        rmSync(file, { force: true });
      }, cleanupAfterMs).unref();
    }
  };
}

/** The report in `text`; null while it is missing or incomplete. */
export function parseStartReport(text: string): StartReport | null {
  if (!text.endsWith('\n')) return null;
  const value = text.slice(0, -1);
  if (value === 'ready') return 'ready';
  return /^\d+$/.test(value) ? Number(value) : null;
}

function readReport(file: string): StartReport | null {
  try {
    return parseStartReport(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export interface StartReportWatch {
  /**
   * Resolves with the exit code when the daemon exited before it was ready;
   * never resolves when it reports `ready`, never reports, or the watch stops.
   */
  exited: Promise<number | null>;
  /** Stops polling and removes the file. */
  stop: () => void;
}

/**
 * Polls `file` until the daemon reports, for at most `timeoutMs`, and removes
 * it once read. The timers do not keep the process alive.
 */
export function watchStartReport(file: string, { timeoutMs, intervalMs = 50 }: { timeoutMs: number; intervalMs?: number }): StartReportWatch {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const exited = new Promise<number | null>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (stopped) return;
      const report = readReport(file);
      if (report !== null) {
        rmSync(file, { force: true });
        if (report !== 'ready') resolve(report);
        return;
      }
      if (Date.now() >= deadline) return;
      timer = setTimeout(tick, intervalMs).unref();
    };
    tick();
  });
  return {
    exited,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      rmSync(file, { force: true });
    },
  };
}

/** Removes the reports in `home` last written more than `maxAgeMs` ago; errors are ignored. */
export function sweepStartReports(home: string, { maxAgeMs = START_REPORT_TTL_MS, now = Date.now() }: { maxAgeMs?: number; now?: number } = {}): void {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return;
  }
  for (const name of names) {
    if (!REPORT_NAME.test(name)) continue;
    const file = join(home, name);
    try {
      if (now - statSync(file).mtimeMs > maxAgeMs) rmSync(file, { force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}
