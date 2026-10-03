// The snapshots table (ADR-018): one row per (changeId, head); the latest by
// computedAt is the one shown. A recompute on the same head replaces the row.
// An identical contentHash and identical fingerprints write nothing while that
// row is the latest; when it is not (the change returned to an older head), only
// its computedAt is bumped. The hash covers the Report only, so bytes can change
// under an identical Report: the row keeps its Report but takes the new
// fingerprints and merge-base in place (`refreshed`, ADR-028).

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
  mergeBase: string | null;
  fingerprints: string | null;
}

/** A computed snapshot to store; `report` is the serialized Report, stored verbatim. */
export type SnapshotInput = Omit<SnapshotRecord, 'id'>;

/**
 * What put did: `created` a row for a new head, `replaced` the row of the same
 * head (a different hash, or an identical hash on a row that was not the latest,
 * whose computedAt is bumped), or nothing (`unchanged`) for an identical hash on
 * the latest row.
 * Only `created` and `replaced` warrant a `collect` event and an SSE `snapshot`.
 * `refreshed`: the latest row has the same contentHash but the fingerprints
 * differ (bytes changed, the Report did not); they are replaced in place, with
 * no new row, no new Report and no `collect` event, but the review marks must
 * be reconciled against them.
 */
export type SnapshotPutResult = 'created' | 'replaced' | 'refreshed' | 'unchanged';

/**
 * Whether the incoming serialized Fingerprints say nothing new about the stored
 * ones: they are null (no fingerprint information, keep what is stored), equal,
 * or the same data in another key order. An unparsable stored value counts as
 * different, so a put with valid fingerprints repairs it; the warning never
 * carries the content.
 */
function sameFingerprints(stored: string | null, incoming: string | null, warn: (message: string) => void): boolean {
  if (incoming === null || stored === incoming) return true;
  if (stored === null) return false;
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, v: unknown) =>
      typeof v === 'object' && v !== null && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
        : v,
    );
  try {
    return canonical(JSON.parse(stored)) === canonical(JSON.parse(incoming));
  } catch {
    warn('a stored snapshot has fingerprints that are not valid JSON; they are replaced by the incoming ones');
    return false;
  }
}

export interface SnapshotStore {
  put(snapshot: SnapshotInput): SnapshotPutResult;
  /** The snapshot with the greatest `computedAt` for the change, or null while there is none. */
  latest(changeId: number): SnapshotRecord | null;
  /** The serialized Report of `latest`, verbatim, or null while there is none. */
  latestReport(changeId: number): string | null;
  /** The serialized Fingerprints of `latest`, verbatim; null while there is none or it predates schema v2. Reads only that column. */
  latestFingerprints(changeId: number): string | null;
  /** The serialized Fingerprints of snapshot `id` of the change, verbatim; null when there is no such snapshot or it predates schema v2. */
  fingerprintsOf(changeId: number, id: number): string | null;
  /**
   * The latest snapshot without its Report, for the diff route (ADR-027): the
   * id, head, dirty flag, merge-base and serialized Fingerprints. Null while
   * there is none. Reads no Report, so a cache hit costs no multi-MB read.
   */
  latestMeta(changeId: number): SnapshotMeta | null;
  /**
   * The touched paths of the latest snapshot of every live change that has one,
   * by the change's `lastEventAt` desc; for search (ADR-017). Reads only the
   * `touched` column, never a report.
   */
  liveTouched(): LiveTouched[];
}

/** The columns of a snapshot that say what it compares, without the Report. */
export interface SnapshotMeta {
  id: number;
  head: string;
  dirty: boolean;
  mergeBase: string | null;
  fingerprints: string | null;
}

/** The touched paths of a live change's latest snapshot. */
export interface LiveTouched {
  repoId: number;
  changeId: number;
  touched: string[];
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
    mergeBase: row.mergeBase,
    fingerprints: row.fingerprints,
  };
}

const LATEST = 'WHERE changeId = ? ORDER BY computedAt DESC, id DESC LIMIT 1';

export function createSnapshotStore(db: Connection, warn: (message: string) => void = () => undefined): SnapshotStore {
  const existingHash = db.prepare<[number, string], { id: number; contentHash: string; fingerprints: string | null; mergeBase: string | null }>(
    'SELECT id, contentHash, fingerprints, mergeBase FROM snapshots WHERE changeId = ? AND head = ?',
  );
  const latestId = db.prepare<[number], { id: number }>(`SELECT id FROM snapshots ${LATEST}`);
  const touch = db.prepare<[string, string | null, string | null, number]>(
    'UPDATE snapshots SET computedAt = ?, mergeBase = COALESCE(?, mergeBase), fingerprints = COALESCE(?, fingerprints) WHERE id = ?',
  );
  const refresh = db.prepare<[string | null, string | null, number]>(
    'UPDATE snapshots SET mergeBase = COALESCE(?, mergeBase), fingerprints = COALESCE(?, fingerprints) WHERE id = ?',
  );
  // json_valid runs in SQLite, so a report of several MB is checked without a JS parse.
  const isJson = db.prepare<[string], { valid: number }>('SELECT json_valid(?) AS valid');
  const insert = db.prepare<[number, string, number, string, string, string, string, string, string | null, string | null]>(
    `INSERT INTO snapshots (changeId, head, dirty, report, summary, touched, contentHash, computedAt, mergeBase, fingerprints)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const replace = db.prepare<[number, string, string, string, string, string, string | null, string | null, number, string]>(
    `UPDATE snapshots SET dirty = ?, report = ?, summary = ?, touched = ?, contentHash = ?, computedAt = ?,
       mergeBase = ?, fingerprints = ?
     WHERE changeId = ? AND head = ?`,
  );
  const latestFingerprints = db.prepare<[number], { fingerprints: string | null }>(
    `SELECT fingerprints FROM snapshots ${LATEST}`,
  );
  const fingerprintsOf = db.prepare<[number, number], { fingerprints: string | null }>(
    'SELECT fingerprints FROM snapshots WHERE changeId = ? AND id = ?',
  );
  const latestMeta = db.prepare<[number], { id: number; head: string; dirty: number; mergeBase: string | null; fingerprints: string | null }>(
    `SELECT id, head, dirty, mergeBase, fingerprints FROM snapshots ${LATEST}`,
  );
  const latest = db.prepare<[number], SnapshotRow>(`SELECT * FROM snapshots ${LATEST}`);
  const latestReport = db.prepare<[number], { report: string }>(`SELECT report FROM snapshots ${LATEST}`);
  const liveTouched = db.prepare<[], { repoId: number; changeId: number; touched: string | null }>(
    `SELECT c.repoId, c.id AS changeId,
       (SELECT s.touched FROM snapshots s WHERE s.changeId = c.id
        ORDER BY s.computedAt DESC, s.id DESC LIMIT 1) AS touched
     FROM changes c WHERE c.archivedAt IS NULL
     ORDER BY c.lastEventAt DESC, c.id DESC`,
  );

  const put = (snapshot: SnapshotInput): SnapshotPutResult => {
    const existing = existingHash.get(snapshot.changeId, snapshot.head);
    if (existing?.contentHash === snapshot.contentHash) {
      if (latestId.get(snapshot.changeId)?.id === existing.id) {
        if (sameFingerprints(existing.fingerprints, snapshot.fingerprints, warn)) {
          if (snapshot.mergeBase !== null && existing.mergeBase !== snapshot.mergeBase) refresh.run(snapshot.mergeBase, null, existing.id);
          return 'unchanged';
        }
        refresh.run(snapshot.mergeBase, snapshot.fingerprints, existing.id);
        return 'refreshed';
      }
      // The change came back to an older head with identical content (A -> B -> A):
      // computedAt moves, so that row becomes the latest again, and it takes the
      // fingerprints just computed (the bytes may differ under the same Report).
      touch.run(isoTime(snapshot.computedAt, 'computedAt'), snapshot.mergeBase, snapshot.fingerprints, existing.id);
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
      insert.run(snapshot.changeId, snapshot.head, dirty, snapshot.report, summary, touched, snapshot.contentHash, computedAt, snapshot.mergeBase, snapshot.fingerprints);
      return 'created';
    }
    replace.run(dirty, snapshot.report, summary, touched, snapshot.contentHash, computedAt, snapshot.mergeBase, snapshot.fingerprints, snapshot.changeId, snapshot.head);
    return 'replaced';
  };

  return {
    put: (snapshot) => db.transaction(() => put(snapshot), { immediate: true }),
    latest: (changeId) => {
      const row = latest.get(changeId);
      return row === undefined ? null : toRecord(row);
    },
    latestFingerprints: (changeId) => latestFingerprints.get(changeId)?.fingerprints ?? null,
    latestMeta: (changeId) => {
      const row = latestMeta.get(changeId);
      return row === undefined ? null : { id: row.id, head: row.head, dirty: row.dirty === 1, mergeBase: row.mergeBase, fingerprints: row.fingerprints };
    },
    fingerprintsOf: (changeId, id) => fingerprintsOf.get(changeId, id)?.fingerprints ?? null,
    latestReport: (changeId) => latestReport.get(changeId)?.report ?? null,
    liveTouched: () =>
      liveTouched.all().flatMap(({ repoId, changeId, touched }) =>
        touched === null ? [] : [{ repoId, changeId, touched: JSON.parse(touched) as string[] }],
      ),
  };
}
