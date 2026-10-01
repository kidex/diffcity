// The snapshots table (ADR-018): one row per (changeId, head); the latest by
// computedAt is the one shown. A recompute on the same head replaces the row.
// An identical contentHash writes nothing while that row is the latest; when it
// is not (the change returned to an older head), only its computedAt is bumped.

import type { Connection } from './driver.js';
import type { SnapshotRecord, SnapshotSummary } from '../model/types.js';
import { isoTime } from './time.js';

interface SnapshotRow {
  id: number;
  changeId: number;
  head: string;
  dirty: number;
  report: string;
  summary: string;
  touched: string;
  contentHash: string;
  computedAt: string;
}

/** A computed snapshot to store; `report` is the serialized Report, stored verbatim. */
export type SnapshotInput = Omit<SnapshotRecord, 'id'>;

/**
 * What put did: `created` a row for a new head, `replaced` the row of the same
 * head (a different hash, or an identical hash on a row that was not the latest,
 * whose computedAt is bumped), or nothing (`unchanged`) for an identical hash on
 * the latest row.
 * Only `created` and `replaced` warrant a `collect` event and an SSE `snapshot`.
 */
export type SnapshotPutResult = 'created' | 'replaced' | 'unchanged';

export interface SnapshotStore {
  put(snapshot: SnapshotInput): SnapshotPutResult;
  /** The snapshot with the greatest `computedAt` for the change, or null while there is none. */
  latest(changeId: number): SnapshotRecord | null;
  /** The serialized Report of `latest`, verbatim, or null while there is none. */
  latestReport(changeId: number): string | null;
}

function toRecord(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    changeId: row.changeId,
    head: row.head,
    dirty: row.dirty === 1,
    report: row.report,
    summary: JSON.parse(row.summary) as SnapshotSummary,
    touched: JSON.parse(row.touched) as string[],
    contentHash: row.contentHash,
    computedAt: row.computedAt,
  };
}

const LATEST = 'WHERE changeId = ? ORDER BY computedAt DESC, id DESC LIMIT 1';

export function createSnapshotStore(db: Connection): SnapshotStore {
  const existingHash = db.prepare<[number, string], { id: number; contentHash: string }>(
    'SELECT id, contentHash FROM snapshots WHERE changeId = ? AND head = ?',
  );
  const latestId = db.prepare<[number], { id: number }>(`SELECT id FROM snapshots ${LATEST}`);
  const touch = db.prepare<[string, number]>('UPDATE snapshots SET computedAt = ? WHERE id = ?');
  // json_valid runs in SQLite, so a report of several MB is checked without a JS parse.
  const isJson = db.prepare<[string], { valid: number }>('SELECT json_valid(?) AS valid');
  const insert = db.prepare<[number, string, number, string, string, string, string, string]>(
    `INSERT INTO snapshots (changeId, head, dirty, report, summary, touched, contentHash, computedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const replace = db.prepare<[number, string, string, string, string, string, number, string]>(
    `UPDATE snapshots SET dirty = ?, report = ?, summary = ?, touched = ?, contentHash = ?, computedAt = ?
     WHERE changeId = ? AND head = ?`,
  );
  const latest = db.prepare<[number], SnapshotRow>(`SELECT * FROM snapshots ${LATEST}`);
  const latestReport = db.prepare<[number], { report: string }>(`SELECT report FROM snapshots ${LATEST}`);

  const put = (snapshot: SnapshotInput): SnapshotPutResult => {
    const existing = existingHash.get(snapshot.changeId, snapshot.head);
    if (existing?.contentHash === snapshot.contentHash) {
      if (latestId.get(snapshot.changeId)?.id === existing.id) return 'unchanged';
      // The change came back to an older head with identical content (A -> B -> A):
      // only computedAt moves, so that row becomes the latest again.
      touch.run(isoTime(snapshot.computedAt, 'computedAt'), existing.id);
      return 'replaced';
    }
    if (isJson.get(snapshot.report)?.valid !== 1) {
      throw new Error(`snapshot report for change ${String(snapshot.changeId)} is not valid JSON`);
    }
    const computedAt = isoTime(snapshot.computedAt, 'computedAt');
    const dirty = snapshot.dirty ? 1 : 0;
    const summary = JSON.stringify(snapshot.summary);
    const touched = JSON.stringify(snapshot.touched);
    if (existing === undefined) {
      insert.run(snapshot.changeId, snapshot.head, dirty, snapshot.report, summary, touched, snapshot.contentHash, computedAt);
      return 'created';
    }
    replace.run(dirty, snapshot.report, summary, touched, snapshot.contentHash, computedAt, snapshot.changeId, snapshot.head);
    return 'replaced';
  };

  return {
    put: (snapshot) => db.transaction(() => put(snapshot), { immediate: true }),
    latest: (changeId) => {
      const row = latest.get(changeId);
      return row === undefined ? null : toRecord(row);
    },
    latestReport: (changeId) => latestReport.get(changeId)?.report ?? null,
  };
}
