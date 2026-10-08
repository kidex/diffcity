// The changes table (ADR-018, ADR-019) and the ChangeSummary DTO (ADR-017).
// A change is live while archivedAt is null; (repoId, ref) is unique among live
// changes, so an archived ref can be reused. Summaries read the counters from
// the latest snapshot's `summary` column, never from the report.

import type { Connection } from './driver.js';
import type {
  ArchiveReason,
  ChangeKind,
  ChangeRecord,
  ChangeStats,
  ChangeSummary,
  EventType,
  ReviewState,
  SnapshotSummary,
} from '../model/types.js';
import type { ChangeArchive, ChangeFields, ChangePlan, ChangeUpdate } from '../changes/types.js';
import { isoTime } from './time.js';

interface ChangeRow {
  id: number;
  repoId: number;
  kind: ChangeKind;
  ref: string;
  prNumber: number | null;
  head: string;
  headAvailable: number;
  dirty: number;
  worktreePath: string | null;
  base: string;
  title: string;
  ahead: number | null;
  behind: number | null;
  reviewState: ReviewState;
  lastEventType: EventType;
  lastEventAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archiveReason: ArchiveReason | null;
}

interface ChangeSummaryRow extends ChangeRow {
  snapshotSummary: string | null;
  approvedHead: string | null;
  approvedAt: string | null;
}

// The plan types are canonical in src/core/changes (DC-26); re-exported for the db API.
export type { ChangeArchive, ChangeFields, ChangePlan, ChangeUpdate };

/** The rows applyPlan wrote, in plan order. */
export interface AppliedPlan {
  created: ChangeRecord[];
  updated: ChangeRecord[];
  archived: ChangeRecord[];
}

export interface ChangeStore {
  get(id: number): ChangeRecord | null;
  /** Live changes of a repo, by `lastEventAt` desc. */
  listLive(repoId: number): ChangeRecord[];
  /** Archived changes of a repo, by `archivedAt` desc. */
  listArchived(repoId: number): ChangeRecord[];
  /**
   * Applies a plan for `repoId` in one transaction, stamping `updatedAt` (and
   * `archivedAt`) with `now`: archives first, then updates, then creates, so a
   * ref freed by an archive or an update can be taken in the same plan. Any
   * failure (an unknown, archived or foreign id, a live ref taken twice) rolls
   * the whole plan back.
   */
  applyPlan(repoId: number, plan: ChangePlan, now: string): AppliedPlan;
  getSummary(id: number): ChangeSummary | null;
  /** ChangeSummary of each live change, by `lastEvent.at` desc. */
  listLiveSummaries(repoId: number): ChangeSummary[];
  /** ChangeSummary of each archived change, by `archivedAt` desc. */
  listArchivedSummaries(repoId: number): ChangeSummary[];
  /**
   * The head and time of the last approval (ADR-036); meaningful only while
   * `reviewState` is `approved` (a reconcile that resets the state leaves them).
   * Null when there is no such change.
   */
  approval(id: number): Approval | null;
  /** Writes the approval columns; nulls clear them. The caller sets `reviewState` through applyPlan in the same transaction. */
  setApproval(id: number, approval: Approval): void;
}

/** The approval columns of a change (schema v3). */
export interface Approval {
  approvedHead: string | null;
  approvedAt: string | null;
}

function toRecord(row: ChangeRow): ChangeRecord {
  return {
    id: row.id,
    repoId: row.repoId,
    kind: row.kind,
    ref: row.ref,
    prNumber: row.prNumber,
    head: row.head,
    headAvailable: row.headAvailable === 1,
    dirty: row.dirty === 1,
    worktreePath: row.worktreePath,
    base: row.base,
    title: row.title,
    ahead: row.ahead,
    behind: row.behind,
    reviewState: row.reviewState,
    lastEventType: row.lastEventType,
    lastEventAt: row.lastEventAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    archiveReason: row.archiveReason,
  };
}

function toStats(summaryJson: string | null): ChangeStats | null {
  if (summaryJson === null) return null;
  const summary = JSON.parse(summaryJson) as SnapshotSummary;
  return {
    touchedFiles: summary.touchedFiles,
    symbolsByStatus: summary.byStatus,
    filesByVerdict: summary.byVerdict,
    tier1Files: summary.tier1Files,
  };
}

function toSummary(row: ChangeSummaryRow): ChangeSummary {
  const change = toRecord(row);
  return {
    id: change.id,
    repoId: change.repoId,
    kind: change.kind,
    ref: change.ref,
    prNumber: change.prNumber,
    head: change.head,
    headAvailable: change.headAvailable,
    dirty: change.dirty,
    base: change.base,
    title: change.title,
    ahead: change.ahead,
    behind: change.behind,
    reviewState: change.reviewState,
    agentUnreviewed: change.reviewState === 'unreviewed' && change.lastEventType === 'agent',
    lastEvent: { type: change.lastEventType, at: change.lastEventAt },
    updatedAt: change.updatedAt,
    archivedAt: change.archivedAt,
    archiveReason: change.archiveReason,
    stats: toStats(row.snapshotSummary),
    approvedHead: row.approvedHead,
    approvedAt: row.approvedAt,
  };
}

type ColumnValue = string | number | null;

/** ChangeFields in storage form: booleans as 0/1, times normalized. */
function columnValue(key: keyof ChangeFields, value: ChangeFields[keyof ChangeFields]): ColumnValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (key === 'lastEventAt') return isoTime(String(value), 'lastEventAt');
  return value;
}

/** Every settable column; a Record, so the compiler requires each column of ChangeFields. */
const SETTABLE: Record<keyof ChangeFields, true> = {
  kind: true,
  ref: true,
  prNumber: true,
  head: true,
  headAvailable: true,
  dirty: true,
  worktreePath: true,
  base: true,
  title: true,
  ahead: true,
  behind: true,
  reviewState: true,
  lastEventType: true,
  lastEventAt: true,
};

/** The settable columns in insert order; also the whitelist for dynamic UPDATEs. */
const FIELD_COLUMNS = Object.keys(SETTABLE) as (keyof ChangeFields)[];

// The latest snapshot of a change is the one with the greatest computedAt (ADR-018).
const SUMMARY_SELECT = `
SELECT c.*,
  (SELECT s.summary FROM snapshots s WHERE s.changeId = c.id
   ORDER BY s.computedAt DESC, s.id DESC LIMIT 1) AS snapshotSummary
FROM changes c`;

export function createChangeStore(db: Connection): ChangeStore {
  const byId = db.prepare<[number], ChangeRow>('SELECT * FROM changes WHERE id = ?');
  const live = db.prepare<[number], ChangeRow>(
    'SELECT * FROM changes WHERE repoId = ? AND archivedAt IS NULL ORDER BY lastEventAt DESC, id DESC',
  );
  const archived = db.prepare<[number], ChangeRow>(
    'SELECT * FROM changes WHERE repoId = ? AND archivedAt IS NOT NULL ORDER BY archivedAt DESC, id DESC',
  );
  const insert = db.prepare<ColumnValue[], ChangeRow>(
    `INSERT INTO changes (repoId, ${FIELD_COLUMNS.join(', ')}, updatedAt)
     VALUES (${['?', ...FIELD_COLUMNS.map(() => '?'), '?'].join(', ')}) RETURNING *`,
  );
  const archive = db.prepare<[string, ArchiveReason, string, number], ChangeRow>(
    'UPDATE changes SET archivedAt = ?, archiveReason = ?, updatedAt = ? WHERE id = ? RETURNING *',
  );
  const approval = db.prepare<[number], Approval>('SELECT approvedHead, approvedAt FROM changes WHERE id = ?');
  const setApproval = db.prepare<[string | null, string | null, number]>('UPDATE changes SET approvedHead = ?, approvedAt = ? WHERE id = ?');
  const summaryById = db.prepare<[number], ChangeSummaryRow>(`${SUMMARY_SELECT} WHERE c.id = ?`);
  const liveSummaries = db.prepare<[number], ChangeSummaryRow>(
    `${SUMMARY_SELECT} WHERE c.repoId = ? AND c.archivedAt IS NULL ORDER BY c.lastEventAt DESC, c.id DESC`,
  );
  const archivedSummaries = db.prepare<[number], ChangeSummaryRow>(
    `${SUMMARY_SELECT} WHERE c.repoId = ? AND c.archivedAt IS NOT NULL ORDER BY c.archivedAt DESC, c.id DESC`,
  );

  /** The live change `id` of `repoId`, or an error naming what is wrong with it. */
  function liveChange(repoId: number, id: number): ChangeRow {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`change ${String(id)} not found`);
    if (row.repoId !== repoId) throw new Error(`change ${String(id)} belongs to repo ${String(row.repoId)}, not ${String(repoId)}`);
    if (row.archivedAt !== null) throw new Error(`change ${String(id)} is archived`);
    return row;
  }

  function updateOne(repoId: number, update: ChangeUpdate, now: string): ChangeRow {
    liveChange(repoId, update.id);
    const columns = FIELD_COLUMNS.filter((column) => update[column] !== undefined);
    const values = columns.map((column) => columnValue(column, update[column] as ChangeFields[typeof column]));
    // Column names come from FIELD_COLUMNS only; values are bound.
    const sql = `UPDATE changes SET ${[...columns, 'updatedAt'].map((column) => `${column} = ?`).join(', ')}
                 WHERE id = ? RETURNING *`;
    const row = db.prepare<ColumnValue[], ChangeRow>(sql).get(...values, now, update.id);
    if (row === undefined) throw new Error(`change ${String(update.id)} not found`);
    return row;
  }

  const apply = (repoId: number, plan: ChangePlan, now: string): AppliedPlan => {
    const archivedRows = plan.archive.map(({ id, reason }) => {
      liveChange(repoId, id);
      const row = archive.get(now, reason, now, id);
      if (row === undefined) throw new Error(`change ${String(id)} not found`);
      return row;
    });
    const updatedRows = plan.update.map((update) => updateOne(repoId, update, now));
    const createdRows = plan.create.map((fields) => {
      const row = insert.get(repoId, ...FIELD_COLUMNS.map((column) => columnValue(column, fields[column])), now);
      if (row === undefined) throw new Error(`change ${fields.ref} was not inserted`);
      return row;
    });
    return {
      created: createdRows.map(toRecord),
      updated: updatedRows.map(toRecord),
      archived: archivedRows.map(toRecord),
    };
  };

  return {
    get: (id) => {
      const row = byId.get(id);
      return row === undefined ? null : toRecord(row);
    },
    listLive: (repoId) => live.all(repoId).map(toRecord),
    listArchived: (repoId) => archived.all(repoId).map(toRecord),
    applyPlan: (repoId, plan, now) => {
      const at = isoTime(now, 'now');
      return db.transaction(() => apply(repoId, plan, at), { immediate: true });
    },
    getSummary: (id) => {
      const row = summaryById.get(id);
      return row === undefined ? null : toSummary(row);
    },
    listLiveSummaries: (repoId) => liveSummaries.all(repoId).map(toSummary),
    listArchivedSummaries: (repoId) => archivedSummaries.all(repoId).map(toSummary),
    approval: (id) => {
      const row = approval.get(id);
      return row === undefined ? null : { approvedHead: row.approvedHead, approvedAt: row.approvedAt };
    },
    setApproval: (id, value) => {
      const at = value.approvedAt === null ? null : isoTime(value.approvedAt, 'approvedAt');
      if (setApproval.run(value.approvedHead, at, id).changes === 0) throw new Error(`change ${String(id)} not found`);
    },
  };
}
