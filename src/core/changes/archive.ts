// Archive retention (SPEC.md section 3a L7, ADR-019): archived changes stay
// viewable for 90 days from `archivedAt`; after that `purgeArchived` deletes
// them with their snapshots, findings and events (ADR-018).

import type { ChangeRecord } from '../model/types.js';

export const ARCHIVE_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

/** ISO time before which archived changes are purged: `archivedAt < archiveCutoff(now)`. */
export function archiveCutoff(now: Date): string {
  return new Date(now.getTime() - ARCHIVE_RETENTION_DAYS * DAY_MS).toISOString();
}

/** True for an archived change that is still within its 90 days. */
export function isArchiveViewable(change: Pick<ChangeRecord, 'archivedAt'>, now: Date): boolean {
  return change.archivedAt !== null && change.archivedAt >= archiveCutoff(now);
}
