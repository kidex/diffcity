// The served Reports' cache (ADR-036): one entry per change, a hit only on the
// same key, least recently used changes dropped past the limit.

import { describe, expect, it } from 'vitest';
import { createServedCache, SERVED_CACHE_MAX } from '../../../src/daemon/api/served-cache.js';

describe('served cache', () => {
  it('hits on the same key only; a new key replaces the entry of the change', () => {
    const cache = createServedCache();
    cache.set(1, '10:t:h:1', 'a');
    expect(cache.get(1, '10:t:h:1')).toBe('a');
    expect(cache.get(1, '10:t:h:2')).toBeUndefined();
    cache.set(1, '10:t:h:2', 'b');
    expect(cache.get(1, '10:t:h:1')).toBeUndefined();
    expect(cache.get(1, '10:t:h:2')).toBe('b');
    expect(cache.size).toBe(1);
  });

  it('drops the least recently used change past the limit', () => {
    expect(SERVED_CACHE_MAX).toBe(8);
    const cache = createServedCache(2);
    cache.set(1, 'k', 'one');
    cache.set(2, 'k', 'two');
    expect(cache.get(1, 'k')).toBe('one');
    cache.set(3, 'k', 'three');
    expect(cache.get(2, 'k')).toBeUndefined();
    expect(cache.get(1, 'k')).toBe('one');
    expect(cache.get(3, 'k')).toBe('three');
    expect(cache.size).toBe(2);
  });
});
