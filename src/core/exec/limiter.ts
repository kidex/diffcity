// How many external tool processes run at once (ADR-032): at most two in the
// daemon and one per repo. A slot is taken before the process starts and given
// back when it is gone, so a queued call waits without a process.

export interface Limiter {
  /** Waits for a free slot for `key` (a repo), runs `task`, then frees the slot. */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Processes running now. */
  readonly active: number;
}

/** Daemon-wide tool processes at once. */
export const TOOL_MAX_TOTAL = 2;

/** Tool processes at once in one repo. */
export const TOOL_MAX_PER_REPO = 1;

interface Waiter {
  key: string;
  start: () => void;
}

export function createLimiter(total: number = TOOL_MAX_TOTAL, perKey: number = TOOL_MAX_PER_REPO): Limiter {
  let active = 0;
  const byKey = new Map<string, number>();
  const queue: Waiter[] = [];

  const fits = (key: string): boolean => active < total && (byKey.get(key) ?? 0) < perKey;

  const take = (key: string): void => {
    active++;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  };

  const release = (key: string): void => {
    active--;
    const left = (byKey.get(key) ?? 1) - 1;
    if (left === 0) byKey.delete(key);
    else byKey.set(key, left);
    // First come, first served among the waiters that fit: a busy repo does not hold up the others.
    for (let i = 0; i < queue.length && active < total; ) {
      const waiter = queue[i] as Waiter;
      if (fits(waiter.key)) {
        queue.splice(i, 1);
        take(waiter.key);
        waiter.start();
      } else {
        i++;
      }
    }
  };

  return {
    get active() {
      return active;
    },
    async run<T>(key: string, task: () => Promise<T>): Promise<T> {
      if (fits(key)) take(key);
      else await new Promise<void>((resolve) => queue.push({ key, start: resolve }));
      try {
        return await task();
      } finally {
        release(key);
      }
    },
  };
}
