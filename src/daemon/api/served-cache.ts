// The caches of the served Report (ADR-036): one entry per change, keyed by its
// latest snapshot (id, computedAt, contentHash) and its findings version, so a
// new snapshot or any findings write misses. Least recently used changes go
// first once there are more than `max`. Two of them: the served Report text
// (several MB each, so few) and its counts for the change and repo summaries
// (a few hundred bytes each, so one per change of any repo in practice; DC-106).

import type { ServedCounts } from '../../core/served/index.js';

export interface ServedCache<T = string> {
  /** The cached value for the change when its key is still `key`. */
  get(changeId: number, key: string): T | undefined;
  set(changeId: number, key: string, value: T): void;
  readonly size: number;
  /** Lookups answered from the cache, and lookups that missed (the Report was overlaid again). */
  readonly stats: { hits: number; misses: number };
}

export const SERVED_CACHE_MAX = 8;
/**
 * The served counts kept: far more changes than a daemon tracks. An entry (its
 * key string, the counts object and the Map slot) takes a few hundred bytes,
 * so a full cache holds about 1 to 1.4 MB.
 */
export const SERVED_SUMMARIES_MAX = 4096;

export function createServedCache<T = string>(max = SERVED_CACHE_MAX): ServedCache<T> {
  const entries = new Map<number, { key: string; value: T }>();
  const stats = { hits: 0, misses: 0 };
  return {
    get(changeId, key) {
      const entry = entries.get(changeId);
      if (entry?.key !== key) {
        stats.misses += 1;
        return undefined;
      }
      stats.hits += 1;
      // Most recently used last.
      entries.delete(changeId);
      entries.set(changeId, entry);
      return entry.value;
    },
    set(changeId, key, value) {
      entries.delete(changeId);
      entries.set(changeId, { key, value });
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    get size() {
      return entries.size;
    },
    get stats() {
      return { ...stats };
    },
  };
}

/** The cache of served counts (byVerdict, openHigh) for the change and repo summaries. */
export function servedCountsCache(max = SERVED_SUMMARIES_MAX): ServedCache<ServedCounts> {
  return createServedCache<ServedCounts>(max);
}
