// The guard behind the tests that run the built CLI under import-recorder.mjs
// (DC-130). Such a child that outlived its test used to survive the run as an
// orphan for hours. After each of those files, no process whose command line
// names this checkout's import-recorder.mjs may still run with a DIFFCITY_HOME
// under a temporary root the file created: not even one spawned outside
// DaemonTracker, whose home nobody registered. Scoping by the file's roots
// keeps the check independent of the other files running in parallel.

import { fileURLToPath } from 'node:url';
import { tempRootsCreated } from './config.js';
import { findHomeProcesses, type HomeProcess } from './daemons.js';

/** Absolute path of the recorder; `node --import <this>` is what the guard looks for. */
export const IMPORT_RECORDER = fileURLToPath(new URL('./import-recorder.mjs', import.meta.url));

/** Recorder processes still running with a home under one of `roots` (default: the roots this file created). */
export function recorderProcessesLeft(roots: readonly string[] = tempRootsCreated()): HomeProcess[] {
  return findHomeProcesses(roots).filter((target) => target.command.includes(IMPORT_RECORDER));
}

/**
 * Throws when a recorder process of this file is still alive, after
 * SIGKILLing it (its group when it leads one) so a failure leaves nothing
 * behind either. Register with `afterAll(expectNoRecorderLeft)`.
 */
export function expectNoRecorderLeft(): void {
  const left = recorderProcessesLeft();
  if (left.length === 0) return;
  for (const target of left) {
    try {
      if (target.pgid === target.pid) process.kill(-target.pid, 'SIGKILL');
      else process.kill(target.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  const lines = left.map((target) => `  ${String(target.pid)} ${target.command}`);
  throw new Error(`import-recorder processes outlived their tests:\n${lines.join('\n')}`);
}
