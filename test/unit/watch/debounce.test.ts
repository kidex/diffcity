// The watchers' debounce per (repo, scope) (SPEC.md section 3a C4, ADR-020,
// Q7): trailing at 2 s, with a maximum wait of 10 s since the first unprocessed
// event. Fake timers through the system clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../../src/daemon/clock.js';
import { createDebouncer, DEBOUNCE_MAX_WAIT_MS, DEBOUNCE_MS } from '../../../src/daemon/watcher/debounce.js';

describe('debounce (C4, Q7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses 2 s and 10 s', () => {
    expect(DEBOUNCE_MS).toBe(2000);
    expect(DEBOUNCE_MAX_WAIT_MS).toBe(10_000);
  });

  it('watch/debounce-2s: 5 events in 1 s give one collection 2 s after the last', () => {
    const fired: string[] = [];
    const debouncer = createDebouncer({ clock: systemClock, fire: (key) => fired.push(key) });
    for (let i = 0; i < 5; i++) {
      debouncer.push('1:refs');
      vi.advanceTimersByTime(250);
    }
    // The last event came at 1000 ms; nothing before 3000 ms.
    vi.advanceTimersByTime(1999 - 250);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual(['1:refs']);
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual(['1:refs']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('watch/max-wait-10s: an event every second gives a collection at 10 s', () => {
    const fired: number[] = [];
    const debouncer = createDebouncer({ clock: systemClock, fire: () => fired.push(Date.now()) });
    const start = Date.now();
    for (let i = 0; i < 25; i++) {
      debouncer.push('1:worktree:/work/sample-shop');
      vi.advanceTimersByTime(1000);
    }
    // At 10 s since the first event, then 10 s after the first event that followed it.
    expect(fired.map((at) => at - start)).toEqual([10_000, 20_000]);
    debouncer.close();
  });

  it('keys debounce separately', () => {
    const fired: string[] = [];
    const debouncer = createDebouncer({ clock: systemClock, fire: (key) => fired.push(key) });
    debouncer.push('1:refs');
    vi.advanceTimersByTime(1500);
    debouncer.push('2:refs');
    vi.advanceTimersByTime(500);
    expect(fired).toEqual(['1:refs']);
    vi.advanceTimersByTime(1500);
    expect(fired).toEqual(['1:refs', '2:refs']);
  });

  it('cancel drops the pending keys that match; close clears every timer and refuses new events', () => {
    const fired: string[] = [];
    const debouncer = createDebouncer({ clock: systemClock, fire: (key) => fired.push(key) });
    debouncer.push('1:refs');
    debouncer.push('1:worktree:/work/sample-shop');
    debouncer.push('2:refs');
    debouncer.cancel((key) => key.startsWith('1:'));
    expect(debouncer.pending()).toBe(1);
    debouncer.close();
    expect(vi.getTimerCount()).toBe(0);
    debouncer.push('3:refs');
    vi.advanceTimersByTime(20_000);
    expect(fired).toEqual([]);
  });
});
