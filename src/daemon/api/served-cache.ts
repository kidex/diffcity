// The cache of served Reports (ADR-036): one entry per change, keyed by its
// latest snapshot (id, computedAt, contentHash) and its findings version, so a
// new snapshot or any findings write misses. Least recently used changes go
// first once there are more than `max`; a served Report can be several MB.

export interface ServedCache {
  /** The cached text for the change when its key is still `key`. */
  get(changeId: number, key: string): string | undefined;
  set(changeId: number, key: string, body: string): void;
  readonly size: number;
}

export const SERVED_CACHE_MAX = 8;

export function createServedCache(max = SERVED_CACHE_MAX): ServedCache {
  const entries = new Map<number, { key: string; body: string }>();
  return {
    get(changeId, key) {
      const entry = entries.get(changeId);
      if (entry?.key !== key) return undefined;
      // Most recently used last.
      entries.delete(changeId);
      entries.set(changeId, entry);
      return entry.body;
    },
    set(changeId, key, body) {
      entries.delete(changeId);
      entries.set(changeId, { key, body });
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
