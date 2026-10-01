// The snapshots table (ADR-018): one row per (changeId, head); the latest by
// computedAt is the one shown. A recompute on the same head replaces the row,
// unless its contentHash is identical, in which case nothing is written.

import type { Database } from 'better-sqlite3';
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
 * head with a different hash, or nothing (`unchanged`) for an identical hash.
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

export function createSnapshotStore(db: Database): SnapshotStore {
  const existingHash = db.prepare<[number, string], { contentHash: string }>(
    'SELECT contentHash FROM snapshots WHERE changeId = ? AND head = ?',
  );
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

  const put = db.transaction((snapshot: SnapshotInput): SnapshotPutResult => {
    const existing = existingHash.get(snapshot.changeId, snapshot.head);
    if (existing?.contentHash === snapshot.contentHash) return 'unchanged';
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
  });

  return {
    put: (snapshot) => put(snapshot),
    latest: (changeId) => {
      const row = latest.get(changeId);
      return row === undefined ? null : toRecord(row);
    },
    latestReport: (changeId) => latestReport.get(changeId)?.report ?? null,
  };
}
