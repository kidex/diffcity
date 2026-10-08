// At most two tool processes at once, one per repo (ADR-032).

import { describe, expect, it } from 'vitest';
import { TOOL_MAX_PER_REPO, TOOL_MAX_TOTAL, createLimiter } from '../../../src/core/exec/index.js';

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('tool limiter', () => {
  it('defaults to two at once, one per repo', () => {
    expect([TOOL_MAX_TOTAL, TOOL_MAX_PER_REPO]).toEqual([2, 1]);
  });

  it('runs one task per repo and two in total; a busy repo does not hold up another', async () => {
    const limiter = createLimiter();
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    const task = (key: string, id: string) =>
      limiter.run(key, async () => {
        started.push(id);
        const g = gate();
        gates.set(id, g);
        await g.promise;
      });

    const all = [task('repo-a', 'a1'), task('repo-a', 'a2'), task('repo-b', 'b1'), task('repo-c', 'c1')];
    await tick();
    expect(started).toEqual(['a1', 'b1']);
    expect(limiter.active).toBe(2);

    gates.get('a1')?.open();
    await tick();
    await tick();
    // a2 was first in the queue and repo-a is free again.
    expect(started).toEqual(['a1', 'b1', 'a2']);

    gates.get('b1')?.open();
    await tick();
    await tick();
    expect(started).toEqual(['a1', 'b1', 'a2', 'c1']);

    gates.get('a2')?.open();
    gates.get('c1')?.open();
    await Promise.all(all);
    expect(limiter.active).toBe(0);
  });

  it('frees the slot when a task throws', async () => {
    const limiter = createLimiter(1, 1);
    await expect(limiter.run('repo-a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limiter.run('repo-a', () => Promise.resolve('next'))).toBe('next');
  });
});
