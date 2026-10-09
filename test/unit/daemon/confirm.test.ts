// The confirmed-action tokens (ADR-029): single-use, two minutes, bound to
// what the preview computed, and nothing but a live token is accepted.

import { describe, expect, it } from 'vitest';
import { CONFIRM_TTL_MS, createConfirmedActions } from '../../../src/daemon/actions/confirm.js';

interface Binding {
  changeId: number;
}

describe('confirmed actions', () => {
  it('a token gives its binding once', () => {
    const actions = createConfirmedActions<Binding>();
    const token = actions.issue({ changeId: 7 });
    expect(actions.pending).toBe(1);
    expect(actions.take(token)).toEqual({ changeId: 7 });
    expect(actions.take(token)).toBeNull();
    expect(actions.pending).toBe(0);
  });

  it('a token is void after two minutes', () => {
    let at = 1_000_000;
    const actions = createConfirmedActions<Binding>({ now: () => at });
    const fresh = actions.issue({ changeId: 1 });
    const stale = actions.issue({ changeId: 2 });
    at += CONFIRM_TTL_MS - 1;
    expect(actions.take(fresh)).toEqual({ changeId: 1 });
    at += 1;
    expect(actions.take(stale)).toBeNull();
  });

  it('anything but a token issued here is refused', () => {
    const actions = createConfirmedActions<Binding>();
    const token = actions.issue({ changeId: 3 });
    for (const value of [undefined, null, 3, '', 'x'.repeat(43), `${token}x`, token.slice(1), { token }]) {
      expect(actions.take(value)).toBeNull();
    }
    expect(actions.take(token)).toEqual({ changeId: 3 });
  });

  it('keeps at most `max` tokens, dropping the oldest', () => {
    const actions = createConfirmedActions<Binding>({ max: 2 });
    const first = actions.issue({ changeId: 1 });
    const second = actions.issue({ changeId: 2 });
    const third = actions.issue({ changeId: 3 });
    expect(actions.take(first)).toBeNull();
    expect(actions.take(second)).toEqual({ changeId: 2 });
    expect(actions.take(third)).toEqual({ changeId: 3 });
  });
});
