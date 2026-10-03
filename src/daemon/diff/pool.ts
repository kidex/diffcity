// The pool that computes file diffs (ADR-027, ADR-021): the same pool as the
// snapshots use, with its own workers so a long snapshot never holds up a click
// on a building. Jobs run at high priority. The `thread` runner (the default)
// loads the built worker from dist/daemon/diff/; the `inline` runner computes
// in this thread, for unit tests.

import type { DiffJob } from '../../core/diff/index.js';
import { createPool, type Pool, type PoolOptions } from '../collector/pool.js';

/** The built worker: dist/daemon/diff/worker.js, from both src/ and dist/. */
export const DIFF_WORKER_URL = new URL('../../../dist/daemon/diff/worker.js', import.meta.url);

/** Workers of the diff pool unless set; they start on the first job. */
export const DIFF_POOL_SIZE = 2;

/** A diff job that takes longer than this fails. */
export const DIFF_JOB_TIMEOUT_MS = 30_000;

/** Jobs answer with the serialized FileDiff. */
export type DiffPool = Pool<DiffJob, string>;

export interface DiffPoolOptions extends Omit<PoolOptions<DiffJob, string>, 'runner'> {
  /** Defaults to `thread`. */
  runner?: 'thread' | 'inline';
  workerUrl?: URL;
}

async function computeInline(job: DiffJob): Promise<string> {
  const { runDiffJob } = await import('../../core/diff/index.js');
  return runDiffJob(job);
}

export function createDiffPool(options: DiffPoolOptions = {}): DiffPool {
  const { runner = 'thread', workerUrl = DIFF_WORKER_URL, ...rest } = options;
  return createPool<DiffJob, string>({
    size: DIFF_POOL_SIZE,
    timeoutMs: DIFF_JOB_TIMEOUT_MS,
    ...rest,
    runner: runner === 'inline' ? { kind: 'inline', compute: computeInline } : { kind: 'thread', workerUrl },
  });
}
