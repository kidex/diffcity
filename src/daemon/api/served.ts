// The served Report (ADR-036) and the change summaries that agree with it
// (DC-106), behind their caches. The overlay is src/core's (serveOverlay,
// servedByVerdict); this module only reads the store and keys the caches per
// (snapshot, findings version), the same key for both.

import type { Db } from '../../core/db/index.js';
import type { ChangeSummary } from '../../core/model/types.js';
import type { Verdict } from '../../core/report/types.js';
import { servedByVerdict, servedStats, serveOverlay, type ServedFindings } from '../../core/served/index.js';
import { createServedCache, SERVED_SUMMARIES_MAX, type ServedCache } from './served-cache.js';

export interface ServedCaches {
  /** Served Report texts; a fresh one of SERVED_CACHE_MAX when absent. */
  reports?: ServedCache;
  /** Served `summary.byVerdict` counts; a fresh one of SERVED_SUMMARIES_MAX when absent. */
  summaries?: ServedCache<Record<Verdict, number>>;
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
}

export function createServedReports(db: Db, caches: ServedCaches = {}): ServedReports {
  const reports = caches.reports ?? createServedCache();
  const summaries = caches.summaries ?? createServedCache<Record<Verdict, number>>(SERVED_SUMMARIES_MAX);

  /** The cache key of the change's served Report; null when it has no snapshot. */
  const keyOf = (changeId: number): string | null => {
    const snapshot = db.snapshots.latestKey(changeId);
    if (snapshot === null) return null;
    return `${String(snapshot.id)}:${snapshot.computedAt}:${snapshot.contentHash}:${String(db.findings.version(changeId))}`;
  };
  const findingsOf = (changeId: number): ServedFindings => ({ stored: db.findings.list(changeId), ruleStates: db.findings.ruleStates(changeId) });

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
      // The list reads the same counts without overlaying again.
      if (served.byVerdict !== null) summaries.set(changeId, key, served.byVerdict);
      return served.body;
    },
    summary(change) {
      if (change.stats === null || !db.findings.hasAny(change.id)) return change;
      const key = keyOf(change.id);
      if (key === null) return change;
      let byVerdict = summaries.get(change.id, key);
      if (byVerdict === undefined) {
        const stored = db.snapshots.latestReport(change.id);
        if (stored === null) return change;
        const counted = servedByVerdict(stored, findingsOf(change.id));
        if (counted === null) return change;
        byVerdict = counted;
        summaries.set(change.id, key, byVerdict);
      }
      return { ...change, stats: servedStats(change.stats, byVerdict) };
    },
  };
}
