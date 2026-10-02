// The clock the watchers and the scheduler run on (ADR-020): every timer goes
// through it, so tests drive them with vi.useFakeTimers() or a manual clock.

export type TimerHandle = unknown;

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** A number in [0, 1), for the PR polling offset. */
  random(): number;
}

/**
 * The real clock. Each call resolves the global at call time, so fake timers
 * installed after this module loaded still apply. Timers are unref'd: the
 * daemon's servers keep the process alive, not its schedules.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
  random: () => Math.random(),
};
