// A snapshot of one change (ADR-018, ADR-021): the Report serialized once, the
// denormalized columns the change list reads (`summary`, `touched`) and the
// content hash that tells a recompute with the same content from a new one.
// computeSnapshot runs in a collector worker thread, so the main thread never
// stringifies a report of several MB.

import { createHash } from 'node:crypto';
import type { Fingerprints, SnapshotSummary } from '../model/types.js';
import type { UserRuleSettings } from '../settings/settings.js';
import { buildReportWithHead } from './build.js';
import type { Report } from './types.js';

/** What a worker needs to compute a snapshot; plain data, so it crosses postMessage. */
export interface SnapshotJobInput {
  /** Directory of the working tree to read: the repo for a commit, the change's working tree when dirty. */
  repoDir: string;
  /** The change's base (a ref name). */
  base: string;
  /** The head commit; omitted for a dirty change, whose working tree is compared. */
  head?: string | undefined;
  /** ISO time for meta.generatedAt; defaults to the current time. */
  now?: string | undefined;
  /** Whether the repo root is trusted, so its diffcity.config.js may be imported (ADR-030). */
  trustConfig: boolean;
  /** The user's rule lists for the repo from settings.json (ADR-030); plain JSON, so it crosses postMessage. */
  userRules?: UserRuleSettings | undefined;
}

export interface ComputedSnapshot {
  /** The serialized Report (SPEC.md section 4.1), stored verbatim. */
  reportJson: string;
  summary: SnapshotSummary;
  /** Paths of the touched files (status other than `same`), in report order. */
  touched: string[];
  /** sha256 of the report with meta.generatedAt and every checks[].checkedAt emptied. */
  contentHash: string;
  /** The sha the after state was built on. */
  headCommit: string;
  /** The merge-base the before state was read from. */
  mergeBase: string;
  /** The serialized Fingerprints (ADR-027), stored verbatim in `snapshots.fingerprints`. */
  fingerprintsJson: string;
  /** One-line notes for daemon.log, written by the main thread (a worker has no log of its own). */
  notes?: string[];
}

/**
 * sha256 hex of the report serialized with `meta.generatedAt` emptied
 * (ADR-018), and the `checkedAt` of each rule check, which is the same time
 * (ADR-030). A Report without checks hashes as it always has.
 */
export function contentHashOf(report: Report): string {
  const timeless: Report = { ...report, meta: { ...report.meta, generatedAt: '' } };
  if (report.checks !== undefined) timeless.checks = report.checks.map((check) => ({ ...check, checkedAt: '' }));
  return createHash('sha256').update(JSON.stringify(timeless)).digest('hex');
}

/** The snapshot columns of a report. Pure. */
export function snapshotFromReport(
  report: Report,
  headCommit: string,
  mergeBase: string,
  fingerprints: Fingerprints,
): ComputedSnapshot {
  const touched = report.packages.flatMap((pkg) => pkg.files.filter((file) => file.status !== 'same').map((file) => file.path));
  const openHigh = report.findings.filter((finding) => finding.state === 'open' && finding.severity === 'high').length;
  return {
    reportJson: JSON.stringify(report),
    summary: { ...report.summary, touchedFiles: touched.length, openHigh },
    touched,
    contentHash: contentHashOf(report),
    headCommit,
    mergeBase,
    fingerprintsJson: JSON.stringify(fingerprints),
  };
}

/** Builds the Report of a change and its snapshot columns. */
export async function computeSnapshot(input: SnapshotJobInput): Promise<ComputedSnapshot> {
  const notes: string[] = [];
  const { report, headCommit, mergeBase, fingerprints } = await buildReportWithHead({
    repoDir: input.repoDir,
    base: input.base,
    head: input.head,
    now: input.now === undefined ? undefined : new Date(input.now),
    trustConfig: input.trustConfig,
    userRules: input.userRules,
    log: (message) => notes.push(message),
  });
  const snapshot = snapshotFromReport(report, headCommit, mergeBase, fingerprints);
  if (notes.length > 0) snapshot.notes = notes;
  return snapshot;
}
