// Debounce per key, the key being `(repo, scope)` (SPEC.md section 3a C4,
// ADR-020, Q7): a key fires DEBOUNCE_MS after its last event, and at the
// latest DEBOUNCE_MAX_WAIT_MS after its first unprocessed event, so the UI
// updates at least every 10 s while an agent keeps writing.

import type { Clock, TimerHandle } from '../clock.js';

export const DEBOUNCE_MS = 2000;
export const DEBOUNCE_MAX_WAIT_MS = 10_000;

export interface DebouncerOptions {
  clock: Clock;
  fire: (key: string) => void;
  waitMs?: number;
  maxWaitMs?: number;
}

export interface Debouncer {
  /** Records an event for `key`. Ignored after close(). */
  push(key: string): void;
  /** Drops the pending keys for which `match` is true, without firing them. */
  cancel(match: (key: string) => boolean): void;
  /** Keys waiting to fire. */
  pending(): number;
  /** Drops every pending key and clears its timer. */
  close(): void;
}

interface Pending {
  first: number;
  timer: TimerHandle;
}

export function createDebouncer(options: DebouncerOptions): Debouncer {
  const { clock, fire } = options;
  const waitMs = options.waitMs ?? DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEBOUNCE_MAX_WAIT_MS;
  const pending = new Map<string, Pending>();
  let closed = false;

  const schedule = (key: string, first: number): TimerHandle => {
    const now = clock.now();
    const due = Math.min(now + waitMs, first + maxWaitMs);
    return clock.setTimeout(() => {
      pending.delete(key);
      fire(key);
    }, Math.max(0, due - now));
  };

  return {
    push(key) {
      if (closed) return;
      const current = pending.get(key);
      if (current !== undefined) clock.clearTimeout(current.timer);
      const first = current?.first ?? clock.now();
      pending.set(key, { first, timer: schedule(key, first) });
    },
    cancel(match) {
      for (const [key, entry] of pending) {
        if (!match(key)) continue;
        clock.clearTimeout(entry.timer);
        pending.delete(key);
      }
    },
    pending: () => pending.size,
    close() {
      closed = true;
      for (const entry of pending.values()) clock.clearTimeout(entry.timer);
      pending.clear();
    },
  };
}
