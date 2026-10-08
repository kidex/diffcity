// The pool that reads Claude Code sessions (ADR-038, ADR-021): the same pool
// as the snapshots and diffs use, with its own worker so a long snapshot never
// holds up a session read and the main thread never parses a transcript. The
// `thread` runner (the default) loads the built worker from
// dist/daemon/session/; the `inline` runner reads in this thread, for tests.

import type { SessionJob, SessionJobResult } from '../../core/session/job.js';
import { createPool, type Pool, type PoolOptions } from '../collector/pool.js';

/** The built worker: dist/daemon/session/worker.js, from both src/ and dist/. */
export const SESSION_WORKER_URL = new URL('../../../dist/daemon/session/worker.js', import.meta.url);

/** One worker: sessions are read one file at a time, from their cursors. */
export const SESSION_POOL_SIZE = 1;

/** A session read that takes longer than this fails. */
export const SESSION_JOB_TIMEOUT_MS = 60_000;

export type SessionPool = Pool<SessionJob, SessionJobResult>;

export interface SessionPoolOptions extends Omit<PoolOptions<SessionJob, SessionJobResult>, 'runner'> {
  /** Defaults to `thread`. */
  runner?: 'thread' | 'inline';
  workerUrl?: URL;
}

async function readInline(job: SessionJob): Promise<SessionJobResult> {
  const { runSessionJob } = await import('../../core/session/job.js');
  return runSessionJob(job);
}

export function createSessionPool(options: SessionPoolOptions = {}): SessionPool {
  const { runner = 'thread', workerUrl = SESSION_WORKER_URL, ...rest } = options;
  return createPool<SessionJob, SessionJobResult>({
    size: SESSION_POOL_SIZE,
    timeoutMs: SESSION_JOB_TIMEOUT_MS,
    ...rest,
    runner: runner === 'inline' ? { kind: 'inline', compute: readInline } : { kind: 'thread', workerUrl },
  });
}
