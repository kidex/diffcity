// The review tables (ADR-028, schema v2): one mark per target of a change and
// the optional general note. Written only by the daemon's main thread.

import type { ReviewMarkValue } from '../model/types.js';
import type { StoredMark, TargetRef } from '../review/types.js';
import type { Connection } from './driver.js';
import { isoTime } from './time.js';

interface MarkRow {
  targetKind: 'file' | 'symbol';
  targetId: string;
  filePath: string;
  mark: ReviewMarkValue;
  note: string | null;
  lineSide: 'old' | 'new' | null;
  lineStart: number | null;
  lineEnd: number | null;
  fingerprint: string;
  snapshotId: number | null;
  state: 'current' | 'outdated';
  outdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A mark to write: the first write of a target creates it, a later one replaces it and makes it current. */
export interface MarkWrite {
  changeId: number;
  target: TargetRef;
  filePath: string;
  mark: ReviewMarkValue;
  note: string | null;
  lines: { side: 'old' | 'new'; start: number; end: number } | null;
  /** The target's fingerprint in the snapshot the mark is made against. */
  fingerprint: string;
  snapshotId: number | null;
  at: string;
}

export interface ReviewStore {
  /** The marks of a change in the order they were first made. */
  list(changeId: number): StoredMark[];
  count(changeId: number): number;
  /** Creates or replaces the mark of the target; the result is `current`. */
  upsert(write: MarkWrite): StoredMark;
  /** Deletes a mark, outdated or not; false when there was none. */
  remove(changeId: number, target: TargetRef): boolean;
  /** Flags the current marks of `targets` as outdated at `at`; returns how many changed. */
  markOutdated(changeId: number, targets: readonly TargetRef[], at: string): number;
  /** The general note, or null. */
  note(changeId: number): string | null;
  /** Sets the general note; an empty string clears it. Returns the stored note (null when cleared). */
  setNote(changeId: number, note: string, at: string): string | null;
}

function toMark(row: MarkRow): StoredMark {
  return {
    targetKind: row.targetKind,
    targetId: row.targetId,
    filePath: row.filePath,
    mark: row.mark,
    note: row.note,
    lines:
      row.lineSide === null || row.lineStart === null || row.lineEnd === null
        ? null
        : { side: row.lineSide, start: row.lineStart, end: row.lineEnd },
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    outdatedAt: row.outdatedAt,
    fingerprint: row.fingerprint,
    snapshotId: row.snapshotId,
  };
}

export function createReviewStore(db: Connection): ReviewStore {
  const list = db.prepare<[number], MarkRow>('SELECT * FROM review_marks WHERE changeId = ? ORDER BY id');
  const count = db.prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM review_marks WHERE changeId = ?');
  const upsert = db.prepare<
    [number, string, string, string, string, string | null, string | null, number | null, number | null, string, number | null, string, string],
    MarkRow
  >(
    `INSERT INTO review_marks
       (changeId, targetKind, targetId, filePath, mark, note, lineSide, lineStart, lineEnd, fingerprint, snapshotId, state, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?)
     ON CONFLICT (changeId, targetKind, targetId) DO UPDATE SET
       filePath = excluded.filePath, mark = excluded.mark, note = excluded.note,
       lineSide = excluded.lineSide, lineStart = excluded.lineStart, lineEnd = excluded.lineEnd,
       fingerprint = excluded.fingerprint, snapshotId = excluded.snapshotId,
       state = 'current', outdatedAt = NULL, updatedAt = excluded.updatedAt
     RETURNING *`,
  );
  const remove = db.prepare<[number, string, string]>(
    'DELETE FROM review_marks WHERE changeId = ? AND targetKind = ? AND targetId = ?',
  );
  const outdate = db.prepare<[string, string, number, string, string]>(
    `UPDATE review_marks SET state = 'outdated', outdatedAt = ?, updatedAt = ?
     WHERE changeId = ? AND targetKind = ? AND targetId = ? AND state = 'current'`,
  );
  const note = db.prepare<[number], { note: string }>('SELECT note FROM review_notes WHERE changeId = ?');
  const putNote = db.prepare<[number, string, string]>(
    `INSERT INTO review_notes (changeId, note, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT (changeId) DO UPDATE SET note = excluded.note, updatedAt = excluded.updatedAt`,
  );
  const clearNote = db.prepare<[number]>('DELETE FROM review_notes WHERE changeId = ?');

  return {
    list: (changeId) => list.all(changeId).map(toMark),
    count: (changeId) => count.get(changeId)?.n ?? 0,
    upsert: (write) => {
      const at = isoTime(write.at, 'at');
      const row = upsert.get(
        write.changeId,
        write.target.kind,
        write.target.id,
        write.filePath,
        write.mark,
        write.note,
        write.lines?.side ?? null,
        write.lines?.start ?? null,
        write.lines?.end ?? null,
        write.fingerprint,
        write.snapshotId,
        at,
        at,
      );
      if (row === undefined) throw new Error('review mark was not written');
      return toMark(row);
    },
    remove: (changeId, target) => remove.run(changeId, target.kind, target.id).changes > 0,
    markOutdated: (changeId, targets, at) => {
      const when = isoTime(at, 'at');
      let changed = 0;
      for (const target of targets) changed += outdate.run(when, when, changeId, target.kind, target.id).changes;
      return changed;
    },
    note: (changeId) => note.get(changeId)?.note ?? null,
    setNote: (changeId, text, at) => {
      if (text.trim() === '') {
        clearNote.run(changeId);
        return null;
      }
      putNote.run(changeId, text, isoTime(at, 'at'));
      return text;
    },
  };
}
