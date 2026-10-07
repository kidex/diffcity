// The served Report (ADR-036) and the change and repo summaries that agree
// with it (DC-106), behind their caches. The overlay and the counts are
// src/core's (serveOverlay, servedCounts, servedStats, servedRepoSummary);
// this module only reads the store and keys the caches per (snapshot,
// findings version), the same key for both.

import type { Db } from '../../core/db/index.js';
import type { ChangeSummary, RepoSummary } from '../../core/model/types.js';
import { servedCounts, servedRepoSummary, servedStats, serveOverlay, type ServedCounts, type ServedFindings } from '../../core/served/index.js';
import { createServedCache, servedCountsCache, type ServedCache } from './served-cache.js';

export interface ServedCaches {
  /** Served Report texts; a fresh one of SERVED_CACHE_MAX when absent. */
  reports?: ServedCache;
  /** Served counts (byVerdict, openHigh); a fresh one of SERVED_SUMMARIES_MAX when absent. */
  summaries?: ServedCache<ServedCounts>;
}

export interface ServedReports {
  /** The served Report text of the change's latest snapshot; null when it has none. */
  report(changeId: number): string | null;
  /**
   * `change` with `stats.filesByVerdict` as its served Report counts them. A
   * change with no snapshot, or with no imported finding and no rule state,
   * is returned as it is: its Report is not read.
   */
  summary(change: ChangeSummary): ChangeSummary;
  /**
   * `repo` with `highFindings` as the served Reports of its live changes
   * count them. Only the live changes with an imported finding or a rule
   * state are read (from the counts cache); the others keep the store's part.
   */
  repo(repo: RepoSummary): RepoSummary;
}

export function createServedReports(db: Db, caches: ServedCaches = {}): ServedReports {
  const reports = caches.reports ?? createServedCache();
  const summaries = caches.summaries ?? servedCountsCache();

  /** The cache key of the change's served Report; null when it has no snapshot. */
  const keyOf = (changeId: number): string | null => {
    const snapshot = db.snapshots.latestKey(changeId);
    if (snapshot === null) return null;
    return `${String(snapshot.id)}:${snapshot.computedAt}:${snapshot.contentHash}:${String(db.findings.version(changeId))}`;
  };
  const findingsOf = (changeId: number): ServedFindings => ({ stored: db.findings.list(changeId), ruleStates: db.findings.ruleStates(changeId) });

  /** The served counts of a change known to have findings; null when it has no snapshot. */
  const countsOf = (changeId: number): ServedCounts | null => {
    const key = keyOf(changeId);
    if (key === null) return null;
    const cached = summaries.get(changeId, key);
    if (cached !== undefined) return cached;
    const stored = db.snapshots.latestReport(changeId);
    if (stored === null) return null;
    const counts = servedCounts(stored, findingsOf(changeId));
    if (counts !== null) summaries.set(changeId, key, counts);
    return counts;
  };

  return {
    report(changeId) {
      if (!db.findings.hasAny(changeId)) return db.snapshots.latestReport(changeId);
      const key = keyOf(changeId);
      if (key === null) return null;
      const cached = reports.get(changeId, key);
      if (cached !== undefined) return cached;
      const stored = db.snapshots.latestReport(changeId);
      if (stored === null) return null;
      const served = serveOverlay(stored, findingsOf(changeId));
      reports.set(changeId, key, served.body);
      // The summaries read the same counts without overlaying again.
      if (served.counts !== null) summaries.set(changeId, key, served.counts);
      return served.body;
    },
    summary(change) {
      if (change.stats === null || !db.findings.hasAny(change.id)) return change;
      const counts = countsOf(change.id);
      return counts === null ? change : { ...change, stats: servedStats(change.stats, counts.byVerdict) };
    },
    repo(repo) {
      const overlaid: ServedCounts[] = [];
      for (const changeId of db.findings.liveChangesWithAny(repo.id)) {
        const counts = countsOf(changeId);
        if (counts !== null) overlaid.push(counts);
      }
      return servedRepoSummary(repo, overlaid);
    },
  };
}
