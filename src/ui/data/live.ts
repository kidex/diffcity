// The SSE client for `GET /api/events` (ADR-017). Events are small signals;
// the screens refetch over REST, at most once per resource every 250 ms.
//
// Daemon indicator states:
// - connected: after `hello`;
// - reconnecting: after an error (and before the first `hello`), for up to 5 s;
// - offline: after that, while reconnection attempts continue.

import type { SseEventName, SseEventOf } from '../../core/model/types.js';

export type DaemonState = 'connected' | 'reconnecting' | 'offline';

export type Unsubscribe = () => void;

export interface Live {
  readonly state: DaemonState;
  /** Calls `listener` now with the current state, then on every change. */
  onState(listener: (state: DaemonState) => void): Unsubscribe;
  /** A typed SSE event. `hello` also fires after every reconnect: refetch everything visible. */
  on<E extends SseEventName>(event: E, listener: (data: SseEventOf<E>['data']) => void): Unsubscribe;
  close(): void;
}

export interface LiveOptions {
  url?: string;
  /** How long `reconnecting` lasts before `offline`. */
  offlineAfterMs?: number;
  /** Delay before a new EventSource when the browser gave up (an HTTP error closes it for good). */
  retryMs?: number;
  createEventSource?: (url: string) => EventSource;
}

const EVENT_NAMES: readonly SseEventName[] = ['hello', 'repo', 'changes', 'snapshot', 'review', 'collect'];

export const OFFLINE_AFTER_MS = 5_000;
export const RETRY_MS = 2_000;
export const REFETCH_INTERVAL_MS = 250;

export function connectLive(options: LiveOptions = {}): Live {
  const url = options.url ?? '/api/events';
  const offlineAfterMs = options.offlineAfterMs ?? OFFLINE_AFTER_MS;
  const retryMs = options.retryMs ?? RETRY_MS;
  const createEventSource = options.createEventSource ?? ((target: string) => new EventSource(target));

  const stateListeners = new Set<(state: DaemonState) => void>();
  const eventListeners = new Map<SseEventName, Set<(data: never) => void>>();
  let state: DaemonState = 'reconnecting';
  let source: EventSource | null = null;
  let offlineTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function setState(next: DaemonState): void {
    if (next === state) return;
    state = next;
    for (const listener of stateListeners) listener(state);
  }

  function startOfflineTimer(): void {
    offlineTimer ??= setTimeout(() => {
      offlineTimer = null;
      setState('offline');
    }, offlineAfterMs);
  }

  function clearOfflineTimer(): void {
    if (offlineTimer !== null) clearTimeout(offlineTimer);
    offlineTimer = null;
  }

  function emit(event: SseEventName, raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    for (const listener of eventListeners.get(event) ?? []) (listener as (payload: unknown) => void)(data);
  }

  function connect(): void {
    retryTimer = null;
    if (closed) return;
    const current = createEventSource(url);
    source = current;
    for (const name of EVENT_NAMES) {
      current.addEventListener(name, (message) => {
        if (name === 'hello') {
          clearOfflineTimer();
          setState('connected');
        }
        emit(name, (message as MessageEvent<string>).data);
      });
    }
    current.addEventListener('error', () => {
      if (closed || source !== current) return;
      if (state === 'connected') setState('reconnecting');
      startOfflineTimer();
      // The browser retries a dropped stream by itself (with the server's
      // `retry`), but an HTTP error or a wrong content type closes it for good.
      if (current.readyState === current.CLOSED) {
        current.close();
        source = null;
        retryTimer ??= setTimeout(connect, retryMs);
      }
    });
  }

  startOfflineTimer();
  connect();

  return {
    get state() {
      return state;
    },
    onState(listener) {
      stateListeners.add(listener);
      listener(state);
      return () => stateListeners.delete(listener);
    },
    on(event, listener) {
      let listeners = eventListeners.get(event);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(event, listeners);
      }
      const stored = listener as (data: never) => void;
      listeners.add(stored);
      return () => listeners.delete(stored);
    },
    close() {
      closed = true;
      clearOfflineTimer();
      if (retryTimer !== null) clearTimeout(retryTimer);
      source?.close();
      source = null;
    },
  };
}

export interface Coalescer {
  /**
   * Runs `refetch` for `key` now, unless one ran less than the interval ago:
   * then the latest request runs once when the interval ends.
   */
  request(key: string, refetch: () => void): void;
  dispose(): void;
}

/** At most one refetch per resource key every `intervalMs` (ADR-017: 250 ms). */
export function createCoalescer(intervalMs: number = REFETCH_INTERVAL_MS): Coalescer {
  interface Slot {
    timer: ReturnType<typeof setTimeout>;
    pending: (() => void) | null;
  }
  const slots = new Map<string, Slot>();

  function arm(key: string): Slot {
    const slot: Slot = {
      pending: null,
      timer: setTimeout(() => {
        const next = slot.pending;
        slots.delete(key);
        if (next) {
          slots.set(key, arm(key));
          next();
        }
      }, intervalMs),
    };
    return slot;
  }

  return {
    request(key, refetch) {
      const slot = slots.get(key);
      if (slot) {
        slot.pending = refetch;
        return;
      }
      slots.set(key, arm(key));
      refetch();
    },
    dispose() {
      for (const slot of slots.values()) clearTimeout(slot.timer);
      slots.clear();
    },
  };
}
