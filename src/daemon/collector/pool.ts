// The collector's worker pool and its coalescing queue (ADR-021).
//
// - Size clamp(availableParallelism() - 1, 1, 4); workers start lazily, on the
//   first job that needs one, and stay alive, so the wasm grammars load once.
// - Three priorities, FIFO inside each. A job is identified by its key
//   (`<repoId>:<changeId>` for a snapshot): a request for a key already queued
//   replaces its input and keeps the higher priority; a request for a key that
//   is running is marked `rerun` and runs once more afterwards with the latest
//   input. N requests for the same key therefore cost at most 2 computations.
// - A job past the timeout (120 s) fails and its worker is terminated; a
//   worker that crashes fails its job. Either way the slot gets a fresh worker
//   on its next job. Failed jobs never retry on their own.
// - shutdown() refuses new jobs, rejects the queued ones, waits up to 5 s for
//   the running ones and then terminates every worker.
//
// The `inline` runner calls the computation in this thread: unit tests use it,
// since vitest cannot load a TypeScript worker. The `thread` runner loads a
// built worker script that answers the job protocol in worker-protocol.ts.

import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { CollectPriority } from '../../core/model/types.js';
import { isJobReply, type JobRequest } from './worker-protocol.js';

export const JOB_TIMEOUT_MS = 120_000;
export const SHUTDOWN_GRACE_MS = 5000;
/** resourceLimits.maxOldGenerationSizeMb of each worker. */
export const WORKER_MAX_OLD_GENERATION_MB = 1024;

const PRIORITIES: readonly CollectPriority[] = ['high', 'normal', 'low'];
const RANK: Record<CollectPriority, number> = { high: 0, normal: 1, low: 2 };

/** clamp(parallelism - 1, 1, 4). */
export function defaultPoolSize(parallelism: number = availableParallelism()): number {
  return Math.min(4, Math.max(1, parallelism - 1));
}

export type PoolRunner<I, O> =
  | { kind: 'inline'; compute: (input: I) => Promise<O> }
  | { kind: 'thread'; workerUrl: URL };

export interface PoolOptions<I, O> {
  runner: PoolRunner<I, O>;
  /** Defaults to defaultPoolSize(). */
  size?: number;
  /** Defaults to JOB_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Defaults to SHUTDOWN_GRACE_MS. */
  shutdownGraceMs?: number;
  /** Told when a worker is terminated or lost (a timeout or a crash), for the log. */
  onWorkerLost?: (reason: string) => void;
}

export interface Pool<I, O> {
  /**
   * Queues a job; resolves with the result of a computation that ran with this
   * input or a later one for the same key, rejects when that computation failed.
   */
  submit(key: string, priority: CollectPriority, input: I): Promise<O>;
  /** Keys queued or running (a pending rerun counts once more). */
  readonly pending: number;
  /** Live worker threads. */
  readonly workers: number;
  shutdown(): Promise<void>;
}

interface Waiter<O> {
  resolve: (value: O) => void;
  reject: (error: Error) => void;
}

interface Entry<I, O> {
  key: string;
  priority: CollectPriority;
  input: I;
  waiters: Waiter<O>[];
  running: boolean;
  /** Requests that arrived while the job ran. */
  rerun: { priority: CollectPriority; input: I; waiters: Waiter<O>[] } | null;
}

/** Runs one job at a time; for threads, owns at most one worker. */
interface Slot<I, O> {
  busy: boolean;
  run(input: I): Promise<O>;
  /** Terminates the worker, if any; a running job is rejected with `reason`. */
  stop(reason: string): Promise<void>;
  readonly alive: boolean;
}

const shutDownError = (): Error => new Error('the collector pool is shut down');

function inlineSlot<I, O>(compute: (input: I) => Promise<O>, timeoutMs: number): Slot<I, O> {
  let abort: ((error: Error) => void) | null = null;
  return {
    busy: false,
    alive: false,
    run(input) {
      return new Promise<O>((resolve, reject) => {
        // An inline computation cannot be stopped; on a timeout it is abandoned.
        const timer = setTimeout(() => {
          reject(new Error(`snapshot job timed out after ${String(timeoutMs)} ms`));
        }, timeoutMs);
        abort = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        compute(input).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }).finally(() => {
        abort = null;
      });
    },
    stop(reason) {
      abort?.(new Error(reason));
      return Promise.resolve();
    },
  };
}

function threadSlot<I, O>(workerUrl: URL, timeoutMs: number, onLost: (reason: string) => void): Slot<I, O> {
  let worker: Worker | null = null;
  let nextId = 0;
  let current: { id: number; fail: (error: Error) => void } | null = null;

  const discard = (target: Worker): void => {
    if (worker === target) worker = null;
  };

  const spawn = (): Worker => {
    const created = new Worker(workerUrl, { resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB } });
    created.on('error', (error) => {
      discard(created);
      onLost(`worker error: ${error.message}`);
      current?.fail(new Error(`worker failed: ${error.message}`));
    });
    created.on('exit', (code) => {
      const wasCurrent = worker === created;
      discard(created);
      if (wasCurrent && current !== null) {
        onLost(`worker exited with code ${String(code)}`);
        current.fail(new Error(`worker exited with code ${String(code)}`));
      }
    });
    return created;
  };

  return {
    busy: false,
    get alive() {
      return worker !== null;
    },
    run(input) {
      const target = worker ?? spawn();
      worker = target;
      const id = ++nextId;
      return new Promise<O>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          target.off('message', onMessage);
          current = null;
          fn();
        };
        const fail = (error: Error): void => {
          finish(() => {
            reject(error);
          });
        };
        const onMessage = (message: unknown): void => {
          if (!isJobReply(message) || message.id !== id) return;
          finish(() => {
            if (message.ok) resolve(message.result as O);
            else reject(new Error(message.error));
          });
        };
        const timer = setTimeout(() => {
          discard(target);
          onLost(`job timed out after ${String(timeoutMs)} ms; worker terminated`);
          fail(new Error(`snapshot job timed out after ${String(timeoutMs)} ms`));
          void target.terminate();
        }, timeoutMs);
        current = { id, fail };
        target.on('message', onMessage);
        const request: JobRequest<I> = { id, input };
        target.postMessage(request);
      });
    },
    async stop(reason) {
      const target = worker;
      worker = null;
      current?.fail(new Error(reason));
      if (target !== null) await target.terminate();
    },
  };
}

export function createPool<I, O>(options: PoolOptions<I, O>): Pool<I, O> {
  const size = options.size ?? defaultPoolSize();
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`pool size must be a positive integer, got ${String(size)}`);
  const timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS;
  const graceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  const onLost = options.onWorkerLost ?? ((): void => undefined);
  const { runner } = options;

  const slots: Slot<I, O>[] = Array.from({ length: size }, () =>
    runner.kind === 'inline' ? inlineSlot(runner.compute, timeoutMs) : threadSlot<I, O>(runner.workerUrl, timeoutMs, onLost),
  );
  const queues: Record<CollectPriority, Entry<I, O>[]> = { high: [], normal: [], low: [] };
  const byKey = new Map<string, Entry<I, O>>();
  const running = new Set<Promise<unknown>>();
  let closed = false;

  const enqueue = (entry: Entry<I, O>): void => {
    queues[entry.priority].push(entry);
  };

  const dequeue = (): Entry<I, O> | undefined => {
    for (const priority of PRIORITIES) {
      const entry = queues[priority].shift();
      if (entry !== undefined) return entry;
    }
    return undefined;
  };

  const higher = (a: CollectPriority, b: CollectPriority): CollectPriority => (RANK[a] <= RANK[b] ? a : b);

  function pump(): void {
    if (closed) return;
    for (const slot of slots) {
      if (slot.busy) continue;
      const entry = dequeue();
      if (entry === undefined) return;
      start(slot, entry);
    }
  }

  function start(slot: Slot<I, O>, entry: Entry<I, O>): void {
    slot.busy = true;
    entry.running = true;
    const tracked: Promise<void> = slot
      .run(entry.input)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error : new Error(String(error)) }),
      )
      .then((outcome) => {
        // The queue is settled before any caller hears back, so `pending` is exact when they do.
        running.delete(tracked);
        slot.busy = false;
        const { rerun } = entry;
        if (rerun === null || closed) {
          byKey.delete(entry.key);
          if (rerun !== null) for (const waiter of rerun.waiters) waiter.reject(shutDownError());
        } else {
          const next: Entry<I, O> = { key: entry.key, ...rerun, running: false, rerun: null };
          byKey.set(entry.key, next);
          enqueue(next);
        }
        for (const waiter of entry.waiters) {
          if (outcome.ok) waiter.resolve(outcome.value);
          else waiter.reject(outcome.error);
        }
        pump();
      });
    running.add(tracked);
  }

  return {
    submit(key, priority, input) {
      if (closed) return Promise.reject(shutDownError());
      return new Promise<O>((resolve, reject) => {
        const waiter: Waiter<O> = { resolve, reject };
        const entry = byKey.get(key);
        if (entry === undefined) {
          const created: Entry<I, O> = { key, priority, input, waiters: [waiter], running: false, rerun: null };
          byKey.set(key, created);
          enqueue(created);
          pump();
          return;
        }
        if (entry.running) {
          entry.rerun =
            entry.rerun === null
              ? { priority, input, waiters: [waiter] }
              : { priority: higher(entry.rerun.priority, priority), input, waiters: [...entry.rerun.waiters, waiter] };
          return;
        }
        entry.input = input;
        entry.waiters.push(waiter);
        const promoted = higher(entry.priority, priority);
        if (promoted !== entry.priority) {
          const queue = queues[entry.priority];
          queue.splice(queue.indexOf(entry), 1);
          entry.priority = promoted;
          enqueue(entry);
        }
      });
    },
    get pending() {
      let count = 0;
      for (const entry of byKey.values()) count += entry.rerun === null ? 1 : 2;
      return count;
    },
    get workers() {
      return slots.filter((slot) => slot.alive).length;
    },
    async shutdown() {
      if (!closed) {
        closed = true;
        for (const priority of PRIORITIES) {
          for (const entry of queues[priority].splice(0)) {
            byKey.delete(entry.key);
            for (const waiter of entry.waiters) waiter.reject(shutDownError());
          }
        }
      }
      if (running.size > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled([...running]),
          new Promise((resolve) => {
            timer = setTimeout(resolve, graceMs);
          }),
        ]);
        clearTimeout(timer);
      }
      await Promise.all(slots.map((slot) => slot.stop('the collector pool is shut down')));
    },
  };
}
