import { describe, expect, it } from 'vitest';
import { mapLimit } from '../../src/core/report/limit.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapLimit', () => {
  it('keeps the input order in the results', async () => {
    const delays = [30, 5, 20, 1, 10];
    const out = await mapLimit(delays, 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${String(i)}:${String(ms)}`;
    });
    expect(out).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10']);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 20 }, () => deferred());
    const done = mapLimit(gates, 8, async (gate) => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(running).toBe(8);
    for (const gate of gates) gate.resolve();
    await done;
    expect(peak).toBe(8);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 8, () => Promise.resolve(1))).toEqual([]);
  });

  it('rejects with the first error', async () => {
    await expect(
      mapLimit([1, 2, 3], 2, (n) => (n === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(n))),
    ).rejects.toThrow('boom');
  });

  it('refuses a limit below 1', async () => {
    await expect(mapLimit([1], 0, (n) => Promise.resolve(n))).rejects.toThrow(RangeError);
  });
});
