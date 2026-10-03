// The in-memory LRU of computed file diffs (ADR-027): 32 serialized FileDiffs
// keyed by (snapshot, path, symbol). A change's entries go when its latest
// snapshot is another one, and when the stored fingerprints of the same
// snapshot changed (a `refreshed` put keeps the snapshot id, ADR-028, DC-74):
// both are read from the snapshot on every request, so a stale entry is never
// served, whether or not anyone told the cache.

export const DIFF_CACHE_SIZE = 32;

export interface DiffCache {
  /** The serialized FileDiff, or undefined; a hit becomes the most recent. */
  get(snapshot: DiffCacheSnapshot, path: string, symbol: string | undefined): string | undefined;
  set(snapshot: DiffCacheSnapshot, path: string, symbol: string | undefined, json: string): void;
  /** Drops every entry of a change. */
  dropChange(changeId: number): void;
  readonly size: number;
}

/** What identifies the state of a change's latest snapshot. */
export interface DiffCacheSnapshot {
  changeId: number;
  snapshotId: number;
  /** The stored serialized fingerprints: they change on a refresh. */
  fingerprints: string | null;
}

export function createDiffCache(capacity = DIFF_CACHE_SIZE): DiffCache {
  const entries = new Map<string, { changeId: number; json: string }>();
  const current = new Map<number, { snapshotId: number; fingerprints: string | null }>();

  const keyOf = (snapshot: DiffCacheSnapshot, path: string, symbol: string | undefined): string =>
    `${String(snapshot.changeId)}\0${String(snapshot.snapshotId)}\0${path}\0${symbol ?? ''}`;

  const dropChange = (changeId: number): void => {
    for (const [key, entry] of entries) if (entry.changeId === changeId) entries.delete(key);
    current.delete(changeId);
  };

  /** Moves to the snapshot state, dropping the change's entries when it is not the one they were computed for. */
  const sync = (snapshot: DiffCacheSnapshot): void => {
    const known = current.get(snapshot.changeId);
    if (known !== undefined && (known.snapshotId !== snapshot.snapshotId || known.fingerprints !== snapshot.fingerprints)) {
      dropChange(snapshot.changeId);
    }
    current.set(snapshot.changeId, { snapshotId: snapshot.snapshotId, fingerprints: snapshot.fingerprints });
  };

  return {
    get(snapshot, path, symbol) {
      sync(snapshot);
      const key = keyOf(snapshot, path, symbol);
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.json;
    },
    set(snapshot, path, symbol, json) {
      sync(snapshot);
      const key = keyOf(snapshot, path, symbol);
      entries.delete(key);
      entries.set(key, { changeId: snapshot.changeId, json });
      while (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    dropChange,
    get size() {
      return entries.size;
    },
  };
}
