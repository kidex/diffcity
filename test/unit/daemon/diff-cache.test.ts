// The LRU of computed file diffs (ADR-027): 32 entries, dropped with a new
// snapshot and with a refresh of the same snapshot (ADR-028, DC-74).

import { describe, expect, it } from 'vitest';
import { DIFF_CACHE_SIZE, createDiffCache } from '../../../src/daemon/diff/cache.js';

const at = (snapshotId: number, fingerprints: string | null = 'fp-1', changeId = 1) => ({ changeId, snapshotId, fingerprints });

describe('diff cache', () => {
  it('keeps 32 results and drops the least recently used first', () => {
    expect(DIFF_CACHE_SIZE).toBe(32);
    const cache = createDiffCache();
    for (let i = 0; i < 32; i++) cache.set(at(1), `f${String(i)}.ts`, undefined, `json-${String(i)}`);
    // Reading f0 makes it the most recent, so f1 goes first.
    expect(cache.get(at(1), 'f0.ts', undefined)).toBe('json-0');
    cache.set(at(1), 'extra.ts', undefined, 'extra');
    expect(cache.size).toBe(32);
    expect(cache.get(at(1), 'f1.ts', undefined)).toBeUndefined();
    expect(cache.get(at(1), 'f0.ts', undefined)).toBe('json-0');
    expect(cache.get(at(1), 'extra.ts', undefined)).toBe('extra');
  });

  it('keys by the symbol too', () => {
    const cache = createDiffCache();
    cache.set(at(1), 'a.ts', undefined, 'whole');
    cache.set(at(1), 'a.ts', 'a.ts#f', 'focused');
    expect(cache.get(at(1), 'a.ts', undefined)).toBe('whole');
    expect(cache.get(at(1), 'a.ts', 'a.ts#f')).toBe('focused');
  });

  it('drops a change on a new snapshot and when the fingerprints of the same snapshot changed, and no other change', () => {
    const cache = createDiffCache();
    cache.set(at(1), 'a.ts', undefined, 'one');
    cache.set(at(7, 'fp-x', 2), 'a.ts', undefined, 'other change');
    expect(cache.get(at(2), 'a.ts', undefined)).toBeUndefined();
    expect(cache.size).toBe(1);

    cache.set(at(2), 'a.ts', undefined, 'two');
    expect(cache.get(at(2), 'a.ts', undefined)).toBe('two');
    // A refreshed put keeps the snapshot id and changes the stored fingerprints.
    expect(cache.get(at(2, 'fp-2'), 'a.ts', undefined)).toBeUndefined();
    expect(cache.get(at(7, 'fp-x', 2), 'a.ts', undefined)).toBe('other change');

    cache.dropChange(2);
    expect(cache.size).toBe(0);
  });
});
