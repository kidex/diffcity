// How a daemon tells the client that started it whether it came up (DC-45).
// A daemon launched through LaunchServices is not a child of that client, so
// the client cannot see its exit code. The client passes a file in
// START_REPORT_ENV; the daemon writes `ready` there once it answers on its
// socket, or its exit code when it exits before that. The client polls the
// file and removes it. Node builtins only: the socket client loads this.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/** Environment variable carrying the report file to a daemon. */
export const START_REPORT_ENV = 'DIFFCITY_START_REPORT';

/** `ready`, or the exit code of a daemon that exited before it was ready. */
export type StartReport = 'ready' | number;

/**
 * Takes the report file out of `env` (so the daemon's own children never see
 * it) and returns the function that writes the first outcome to it; later
 * calls do nothing. Without the variable, the function does nothing.
 */
export function takeStartReporter(env: NodeJS.ProcessEnv = process.env): (outcome: StartReport) => void {
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

/**
 * Polls `file` until the daemon reports, for at most `timeoutMs`. Resolves with
 * the exit code when the daemon exited before it was ready; never resolves when
 * it reports `ready` or never reports. Removes the file once read. The timers
 * do not keep the process alive.
 */
export function watchStartReport(file: string, { timeoutMs, intervalMs = 50 }: { timeoutMs: number; intervalMs?: number }): Promise<number | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const report = readReport(file);
      if (report !== null) {
        rmSync(file, { force: true });
        if (report !== 'ready') resolve(report);
        return;
      }
      if (Date.now() >= deadline) return;
      setTimeout(tick, intervalMs).unref();
    };
    tick();
  });
}
