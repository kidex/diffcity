// The SSE client (ADR-017): the daemon indicator states, typed events, the
// reconnect after an HTTP error, and refetches coalesced to one per 250 ms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectLive, createCoalescer, type DaemonState } from '../../../src/ui/data/live.js';

/** Enough of EventSource for connectLive: named listeners, readyState, close(). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = this.CLOSED;
  }

  dispatch(type: string, data?: string): void {
    if (type !== 'error') this.readyState = this.OPEN;
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  /** The stream dropped: the browser keeps it CONNECTING and retries by itself. */
  drop(): void {
    this.readyState = this.CONNECTING;
    this.dispatch('error');
  }

  /** An HTTP error: the browser closes the EventSource for good. */
  fail(): void {
    this.readyState = this.CLOSED;
    this.dispatch('error');
  }
}

const latest = (): FakeEventSource => {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error('no EventSource');
  return source;
};

const HELLO = JSON.stringify({ version: '0.1.0', startedAt: '2026-05-04T12:00:00.000Z' });

function connect() {
  const states: DaemonState[] = [];
  const live = connectLive({ createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource });
  live.onState((state) => states.push(state));
  return { live, states };
}

describe('data/live', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects to /api/events and is connected after hello', () => {
    const { live, states } = connect();
    expect(latest().url).toBe('/api/events');
    expect(live.state).toBe('reconnecting');
    latest().dispatch('hello', HELLO);
    expect(states).toEqual(['reconnecting', 'connected']);
    live.close();
  });

  it('is offline when the first hello does not arrive within 5 s', () => {
    const { live } = connect();
    vi.advanceTimersByTime(4_999);
    expect(live.state).toBe('reconnecting');
    vi.advanceTimersByTime(1);
    expect(live.state).toBe('offline');
    live.close();
  });

  it('goes connected → reconnecting → offline → connected across a daemon restart', () => {
    const { live, states } = connect();
    const first = latest();
    first.dispatch('hello', HELLO);
    first.drop();
    expect(live.state).toBe('reconnecting');
    vi.advanceTimersByTime(5_000);
    expect(live.state).toBe('offline');
    // The browser's own retry reaches the restarted daemon.
    first.dispatch('hello', HELLO);
    expect(states).toEqual(['reconnecting', 'connected', 'reconnecting', 'offline', 'connected']);
    expect(FakeEventSource.instances).toHaveLength(1);
    live.close();
  });

  it('recovers before 5 s without going offline', () => {
    const { live, states } = connect();
    latest().dispatch('hello', HELLO);
    latest().drop();
    vi.advanceTimersByTime(2_000);
    latest().dispatch('hello', HELLO);
    vi.advanceTimersByTime(10_000);
    expect(states).toEqual(['reconnecting', 'connected', 'reconnecting', 'connected']);
    live.close();
  });

  it('opens a new EventSource 2 s after an HTTP error closed the old one', () => {
    const { live } = connect();
    const first = latest();
    first.dispatch('hello', HELLO);
    first.fail();
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    latest().fail();
    vi.advanceTimersByTime(2_000);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(live.state).toBe('reconnecting');
    vi.advanceTimersByTime(1_000);
    expect(live.state).toBe('offline');
    latest().dispatch('hello', HELLO);
    expect(live.state).toBe('connected');
    live.close();
  });

  it('delivers typed events and ignores a payload that is not JSON', () => {
    const { live } = connect();
    const repos: number[] = [];
    const snapshots: unknown[] = [];
    const stop = live.on('repo', ({ repoId }) => repos.push(repoId));
    live.on('snapshot', (data) => snapshots.push(data));
    latest().dispatch('repo', '{"repoId":3}');
    latest().dispatch('repo', 'not json');
    latest().dispatch('snapshot', '{"repoId":3,"changeId":12,"head":"abc1234"}');
    stop();
    latest().dispatch('repo', '{"repoId":4}');
    expect(repos).toEqual([3]);
    expect(snapshots).toEqual([{ repoId: 3, changeId: 12, head: 'abc1234' }]);
    live.close();
  });

  it('stops reconnecting once closed', () => {
    const { live } = connect();
    latest().fail();
    live.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().readyState).toBe(2);
  });
});

describe('data/live coalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the first refetch at once and folds a burst into one more after 250 ms', () => {
    const coalescer = createCoalescer();
    const runs: string[] = [];
    coalescer.request('repos', () => runs.push('a'));
    coalescer.request('repos', () => runs.push('b'));
    coalescer.request('repos', () => runs.push('c'));
    expect(runs).toEqual(['a']);
    vi.advanceTimersByTime(249);
    expect(runs).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(runs).toEqual(['a', 'c']);
    vi.advanceTimersByTime(1_000);
    expect(runs).toEqual(['a', 'c']);
  });

  it('never runs a key more than once per 250 ms under a steady stream', () => {
    const coalescer = createCoalescer();
    const at: number[] = [];
    for (let t = 0; t < 1_000; t += 50) {
      coalescer.request('repo:1', () => at.push(Date.now()));
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(1_000);
    const gaps = at.slice(1).map((time, i) => time - (at[i] ?? 0));
    expect(gaps.every((gap) => gap >= 250)).toBe(true);
    expect(at.length).toBeGreaterThanOrEqual(4);
    coalescer.dispose();
  });

  it('keeps keys independent', () => {
    const coalescer = createCoalescer();
    const runs: string[] = [];
    coalescer.request('repos', () => runs.push('repos'));
    coalescer.request('repo:1', () => runs.push('repo:1'));
    expect(runs).toEqual(['repos', 'repo:1']);
    coalescer.dispose();
  });

  it('drops pending refetches on dispose', () => {
    const coalescer = createCoalescer();
    const runs: string[] = [];
    coalescer.request('repos', () => runs.push('first'));
    coalescer.request('repos', () => runs.push('second'));
    coalescer.dispose();
    vi.advanceTimersByTime(1_000);
    expect(runs).toEqual(['first']);
  });
});
