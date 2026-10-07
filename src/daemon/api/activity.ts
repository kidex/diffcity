// What a reviewer's write does to its change (ADR-028, ADR-036): the change's
// last event becomes `review`, a `review` row is added to `events` at most once
// per REVIEW_EVENT_GAP_MS (coalesced), and the review state moves when the write
// says so. Marks, notes, finding states and approvals all go through it; the
// caller runs it in the transaction of its write. An archived change keeps its
// last event.

import type { Db } from '../../core/db/index.js';
import type { ChangeRecord, ReviewState } from '../../core/model/types.js';

/** A `review` event is added to `events` only when the previous one is older than this. */
export const REVIEW_EVENT_GAP_MS = 10 * 60 * 1000;

export function recordReviewActivity(
  db: Db,
  change: Pick<ChangeRecord, 'id' | 'repoId' | 'lastEventAt' | 'archivedAt'>,
  at: Date,
  reviewState?: ReviewState,
): void {
  if (change.archivedAt !== null) return;
  const iso = at.toISOString();
  const previous = db.events.latestAt(change.id, 'review');
  db.changes.applyPlan(
    change.repoId,
    {
      create: [],
      archive: [],
      update: [
        {
          id: change.id,
          lastEventType: 'review',
          lastEventAt: iso > change.lastEventAt ? iso : change.lastEventAt,
          ...(reviewState === undefined ? {} : { reviewState }),
        },
      ],
    },
    iso,
  );
  if (previous === null || at.getTime() - Date.parse(previous) > REVIEW_EVENT_GAP_MS) {
    db.events.add({ repoId: change.repoId, changeId: change.id, type: 'review', at: iso, payload: null });
  }
}
