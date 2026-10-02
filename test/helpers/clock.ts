// A manual clock for the watchers and the scheduler (src/daemon/clock.ts):
// timers fire only when the test advances it. Unlike vi.useFakeTimers(), it
// leaves the global timers alone, so chokidar, git and the daemon's servers
// keep running on real time while the debounce and the schedules wait.

import type { Clock } from '../../src/daemon/clock.js';

export interface ManualClock extends Clock {
  /** Moves the time forward, firing every timer that falls due, in order. */
  advance(ms: number): void;
  /** Timers waiting to fire. */
  pending(): number;
}

interface Timer {
  id: number;
  due: number;
  fn: () => void;
}

export function manualClock(start: number = Date.now(), random = 0.5): ManualClock {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, Timer>();
  return {
    now: () => now,
    random: () => random,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { id, due: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next: Timer | undefined;
        for (const timer of timers.values()) {
          if (timer.due <= target && (next === undefined || timer.due < next.due || (timer.due === next.due && timer.id < next.id))) next = timer;
        }
        if (next === undefined) break;
        timers.delete(next.id);
        now = next.due;
        next.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}
