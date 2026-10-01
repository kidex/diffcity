import { describe, expect, it } from 'vitest';
import { refreshSession } from './refresh';

describe('refreshSession', () => {
  it('rotates a live session', () => {
    const session = { userId: 'u1', issuedAt: 1_000, rotation: 0 };
    expect(refreshSession(session, 2_000)).toEqual({ userId: 'u1', issuedAt: 2_000, rotation: 1 });
  });

  it('drops an expired session', () => {
    const session = { userId: 'u1', issuedAt: 0, rotation: 0 };
    expect(refreshSession(session, 16 * 60 * 1000)).toBeNull();
  });
});
