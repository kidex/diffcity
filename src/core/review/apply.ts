// Applies the outdated rule when a snapshot is stored (ADR-028). The caller
// runs it in the same transaction as `snapshots.put`.

import type { Db, SnapshotPutResult } from '../db/index.js';
import type { Fingerprints } from '../model/types.js';
import { reconcileMarks } from './reconcile.js';

const NO_FINGERPRINTS: Fingerprints = { files: {}, symbols: {} };

/**
 * After `put` returned `result` for the change: flags the current marks whose
 * target is gone or whose fingerprint changed, against the new snapshot's
 * `fingerprintsJson`. An `unchanged` put does nothing. Returns how many marks
 * became outdated.
 */
export function reconcileOnSnapshot(
  db: Db,
  changeId: number,
  result: SnapshotPutResult,
  fingerprintsJson: string | null,
  at: string,
): number {
  if (result === 'unchanged') return 0;
  const marks = db.review.list(changeId);
  if (!marks.some((mark) => mark.state === 'current')) return 0;
  const fingerprints = fingerprintsJson === null ? NO_FINGERPRINTS : (JSON.parse(fingerprintsJson) as Fingerprints);
  return db.review.markOutdated(changeId, reconcileMarks(marks, fingerprints), at);
}
