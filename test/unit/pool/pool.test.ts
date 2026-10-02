// The collector pool (ADR-021): coalescing by key, priorities, timeout,
// respawn and shutdown, with the inline runner and with small thread workers.

import { afterEach, describe, expect, it } from 'vitest';
import { createPool, defaultPoolSize, type Pool } from '../../../src/daemon/collector/pool.js';

const SAMPLE_WORKER = new URL('../../fixtures/pool/sample-worker.mjs', import.meta.url);

interface SampleInput {
  value: string;
  ms?: number;
  busy?: boolean;
  hang?: boolean;
  crash?: boolean;
  fail?: boolean;
}
interface SampleResult {
  value: string;
  threadId: number;
}

const pools: Pool<unknown, unknown>[] = [];
afterEach(async () => {
  while (pools.length > 0) await pools.pop()?.shutdown();
});

function track<I, O>(pool: Pool<I, O>): Pool<I, O> {
  pools.push(pool);
  return pool;
}

/** A gate a test opens by hand. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** An inline pool whose computations record their input and wait on the gate of their value, if any. */
function inlinePool(size: number, gates: Map<string, Promise<void>> = new Map()) {
  const runs: string[] = [];
  const pool = track(
    createPool<SampleInput, string>({
      size,
      runner: {
        kind: 'inline',
        compute: async (input) => {
          runs.push(input.value);
          await gates.get(input.value);
          return `done:${input.value}`;
        },
      },
    }),
  );
  return { pool, runs };
}

describe('pool size', () => {
  it('clamps availableParallelism - 1 to 1..4', () => {
    expect(defaultPoolSize(1)).toBe(1);
    expect(defaultPoolSize(2)).toBe(1);
    expect(defaultPoolSize(4)).toBe(3);
    expect(defaultPoolSize(16)).toBe(4);
  });
});

describe('pool/coalesce-queued', () => {
  it('N queued requests for the same key run once, and every caller gets that result', async () => {
    const blocker = gate();
    const { pool, runs } = inlinePool(1, new Map([['busy', blocker.wait]]));
    const busy = pool.submit('1:9', 'normal', { value: 'busy' });
    const queued = Array.from({ length: 5 }, (_, i) => pool.submit('1:7', 'normal', { value: `edit-${String(i)}` }));
    expect(pool.pending).toBe(2);
    blocker.open();
    await busy;
    // The latest input wins.
    expect(await Promise.all(queued)).toEqual(Array(5).fill('done:edit-4'));
    expect(runs).toEqual(['busy', 'edit-4']);
  });

  it('N requests while the same key runs give at most 2 computations', async () => {
    const blocker = gate();
    const { pool, runs } = inlinePool(2, new Map([['first', blocker.wait]]));
    const first = pool.submit('1:7', 'normal', { value: 'first' });
    const more = Array.from({ length: 6 }, (_, i) => pool.submit('1:7', 'normal', { value: `again-${String(i)}` }));
    blocker.open();
    expect(await first).toBe('done:first');
    expect(await Promise.all(more)).toEqual(Array(6).fill('done:again-5'));
    expect(runs).toEqual(['first', 'again-5']);
  });
});

describe('pool/rerun-after-running', () => {
  it('a request during a computation runs once more after it, with the latest input', async () => {
    const blocker = gate();
    const { pool, runs } = inlinePool(4, new Map([['v1', blocker.wait]]));
    const first = pool.submit('1:sources', 'high', { value: 'v1' });
    await Promise.resolve();
    const second = pool.submit('1:sources', 'low', { value: 'v2' });
    expect(runs).toEqual(['v1']);
    blocker.open();
    expect(await first).toBe('done:v1');
    expect(await second).toBe('done:v2');
    expect(runs).toEqual(['v1', 'v2']);
    expect(pool.pending).toBe(0);
  });
});

describe('pool/priority-order', () => {
  it('high before normal before low, FIFO inside a priority', async () => {
    const blocker = gate();
    const { pool, runs } = inlinePool(1, new Map([['blocker', blocker.wait]]));
    const all = [
      pool.submit('0:0', 'normal', { value: 'blocker' }),
      pool.submit('1:1', 'low', { value: 'poll-1' }),
      pool.submit('2:2', 'normal', { value: 'watch-2' }),
      pool.submit('3:3', 'high', { value: 'track-3' }),
      pool.submit('4:4', 'low', { value: 'poll-4' }),
      pool.submit('5:5', 'high', { value: 'track-5' }),
    ];
    blocker.open();
    await Promise.all(all);
    expect(runs).toEqual(['blocker', 'track-3', 'track-5', 'watch-2', 'poll-1', 'poll-4']);
  });

  it('a queued job requested again at a higher priority keeps the higher one', async () => {
    const blocker = gate();
    const { pool, runs } = inlinePool(1, new Map([['blocker', blocker.wait]]));
    const all = [
      pool.submit('0:0', 'normal', { value: 'blocker' }),
      pool.submit('1:1', 'normal', { value: 'watch-1' }),
      pool.submit('2:2', 'low', { value: 'poll-2' }),
      pool.submit('2:2', 'high', { value: 'track-2' }),
      pool.submit('1:1', 'low', { value: 'poll-1' }),
    ];
    blocker.open();
    await Promise.all(all);
    // 2:2 moved up to high; 1:1 stays normal (the highest it was asked at) with the latest input.
    expect(runs).toEqual(['blocker', 'track-2', 'poll-1']);
  });
});

describe('pool failures', () => {
  it('a failing job rejects its callers and does not retry', async () => {
    let calls = 0;
    const pool = track(
      createPool<SampleInput, string>({
        size: 1,
        runner: {
          kind: 'inline',
          compute: () => {
            calls++;
            return Promise.reject(new Error('parse exploded'));
          },
        },
      }),
    );
    await expect(pool.submit('1:1', 'high', { value: 'x' })).rejects.toThrow('parse exploded');
    expect(calls).toBe(1);
    expect(pool.pending).toBe(0);
  });

  it('pool/timeout-terminates: a job past the timeout fails and its worker is replaced', async () => {
    const pool = track(
      createPool<SampleInput, SampleResult>({ size: 1, timeoutMs: 300, runner: { kind: 'thread', workerUrl: SAMPLE_WORKER } }),
    );
    const before = await pool.submit('1:1', 'high', { value: 'warm' });
    await expect(pool.submit('1:2', 'high', { value: 'stuck', hang: true })).rejects.toThrow(/timed out after 300 ms/);
    const after = await pool.submit('1:3', 'high', { value: 'next' });
    expect(after.value).toBe('next');
    expect(after.threadId).not.toBe(before.threadId);
  });

  it('pool/crash-respawns: a crashed worker fails its job and is replaced', async () => {
    const pool = track(createPool<SampleInput, SampleResult>({ size: 1, runner: { kind: 'thread', workerUrl: SAMPLE_WORKER } }));
    const before = await pool.submit('1:1', 'high', { value: 'warm' });
    await expect(pool.submit('1:2', 'high', { value: 'boom', crash: true })).rejects.toThrow(/worker exited with code 3/);
    const after = await pool.submit('1:3', 'high', { value: 'next' });
    expect(after.value).toBe('next');
    expect(after.threadId).not.toBe(before.threadId);
  });

  it('an error answered by a worker rejects the job and keeps the worker', async () => {
    const pool = track(createPool<SampleInput, SampleResult>({ size: 1, runner: { kind: 'thread', workerUrl: SAMPLE_WORKER } }));
    const before = await pool.submit('1:1', 'high', { value: 'warm' });
    await expect(pool.submit('1:2', 'high', { value: 'bad', fail: true })).rejects.toThrow('sample failure: bad');
    expect((await pool.submit('1:3', 'high', { value: 'next' })).threadId).toBe(before.threadId);
  });
});

describe('pool threads', () => {
  it('workers start lazily, up to the size, and run jobs in parallel', async () => {
    const pool = track(createPool<SampleInput, SampleResult>({ size: 3, runner: { kind: 'thread', workerUrl: SAMPLE_WORKER } }));
    expect(pool.workers).toBe(0);
    const started = Date.now();
    const results = await Promise.all(
      ['a', 'b', 'c'].map((value, i) => pool.submit(`1:${String(i)}`, 'normal', { value, ms: 400 })),
    );
    expect(Date.now() - started).toBeLessThan(1100);
    expect(new Set(results.map((result) => result.threadId)).size).toBe(3);
    expect(pool.workers).toBe(3);
  });
});

describe('pool/shutdown-drains', () => {
  it('waits for running jobs, rejects queued ones, then stops the workers and refuses new jobs', async () => {
    const pool = createPool<SampleInput, SampleResult>({ size: 1, runner: { kind: 'thread', workerUrl: SAMPLE_WORKER } });
    const running = pool.submit('1:1', 'high', { value: 'slow', ms: 300 });
    const queued = pool.submit('1:2', 'high', { value: 'queued' });
    queued.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await pool.shutdown();
    expect((await running).value).toBe('slow');
    await expect(queued).rejects.toThrow(/shut down/);
    expect(pool.workers).toBe(0);
    await expect(pool.submit('1:3', 'high', { value: 'late' })).rejects.toThrow(/shut down/);
  });

  it('terminates a job still running after the grace period', async () => {
    const pool = createPool<SampleInput, SampleResult>({
      size: 1,
      shutdownGraceMs: 200,
      runner: { kind: 'thread', workerUrl: SAMPLE_WORKER },
    });
    const stuck = pool.submit('1:1', 'high', { value: 'stuck', hang: true });
    stuck.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await pool.shutdown();
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(stuck).rejects.toThrow(/shut down/);
    expect(pool.workers).toBe(0);
  });

  it('a shutdown with no job ever submitted resolves at once', async () => {
    const pool = createPool<SampleInput, SampleResult>({ runner: { kind: 'thread', workerUrl: SAMPLE_WORKER } });
    await pool.shutdown();
    await pool.shutdown();
  });
});
