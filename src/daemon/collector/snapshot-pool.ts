// The pool that computes snapshots (ADR-021). The `thread` runner (the
// daemon's default) loads the built worker from dist/daemon/collector/; the
// `inline` runner computes in this thread, for unit tests. Neither loads the
// parser into the main thread until a job needs it.

import type { ComputedSnapshot, SnapshotJobInput } from '../../core/report/snapshot.js';
import { createPool, type Pool, type PoolOptions } from './pool.js';

/** The built worker: dist/daemon/collector/worker.js, from both src/ and dist/. */
export const SNAPSHOT_WORKER_URL = new URL('../../../dist/daemon/collector/worker.js', import.meta.url);

export type SnapshotPool = Pool<SnapshotJobInput, ComputedSnapshot>;

export type SnapshotRunnerKind = 'thread' | 'inline';

export interface SnapshotPoolOptions extends Omit<PoolOptions<SnapshotJobInput, ComputedSnapshot>, 'runner'> {
  /** Defaults to `thread`. */
  runner?: SnapshotRunnerKind;
  /** The thread runner's worker script; defaults to SNAPSHOT_WORKER_URL. */
  workerUrl?: URL;
}

async function computeInline(input: SnapshotJobInput): Promise<ComputedSnapshot> {
  const { computeSnapshot } = await import('../../core/report/snapshot.js');
  return computeSnapshot(input);
}

export function createSnapshotPool(options: SnapshotPoolOptions = {}): SnapshotPool {
  const { runner = 'thread', workerUrl = SNAPSHOT_WORKER_URL, ...rest } = options;
  return createPool<SnapshotJobInput, ComputedSnapshot>({
    ...rest,
    runner: runner === 'inline' ? { kind: 'inline', compute: computeInline } : { kind: 'thread', workerUrl },
  });
}
