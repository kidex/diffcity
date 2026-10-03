// Shapes shared by the review modules (ADR-028).

import type { ReviewMark } from '../model/types.js';

/** A `review_marks` row: the public ReviewMark plus what reconcile compares. */
export interface StoredMark extends ReviewMark {
  /** The target's fingerprint when it was marked (see targetFingerprint). */
  fingerprint: string;
  snapshotId: number | null;
}

/** The identity of a mark: one per target in a change. */
export interface TargetRef {
  kind: 'file' | 'symbol';
  id: string;
}
