// The diffcity database (SPEC.md section 4.2, ADR-018): openDb and the stores.
// Opened only by the daemon's main thread, which is the single writer.
// SQLite is Node's built-in node:sqlite, through driver.ts (ADR-025). Schema v4 (ADR-038). The filter
// for its ExperimentalWarning lives in warning.ts and is deliberately not
// re-exported here: importing this module loads node:sqlite, which is too late.
//
// Every write transaction is IMMEDIATE: a deferred transaction that reads and
// then writes upgrades its lock without the busy handler and fails with
// SQLITE_BUSY at once when another connection writes (DC-39).

import type { Connection } from './driver.js';
import { createChangeStore, type ChangeStore } from './changes.js';
import { createEventStore, type EventStore } from './events.js';
import { createFindingsStore, type FindingsStore } from './findings.js';
import { openConnection, readPragmas, type DbPragmas } from './open.js';
import { createRepoStore, type RepoStore } from './repos.js';
import { createReviewStore, type ReviewStore } from './review.js';
import { createSessionStore, type SessionStore } from './sessions.js';
import { createSnapshotStore, type SnapshotStore } from './snapshots.js';
import { retentionCutoff } from './time.js';

export type { FindingsImport, FindingsImportResult, FindingsStore } from './findings.js';
export type { AppliedPlan, Approval, ChangeArchive, ChangeFields, ChangePlan, ChangeStore, ChangeUpdate } from './changes.js';
export type { EventInput, EventStore } from './events.js';
export type { MarkWrite, ReviewStore } from './review.js';
export type { SessionDigestWrite, SessionLink, SessionRecord, SessionSighting, SessionStore } from './sessions.js';
export type { RepoInput, RepoRuntime, RepoRuntimeLookup, RepoStore } from './repos.js';
export type { LiveTouched, SnapshotInput, SnapshotKey, SnapshotMeta, SnapshotPutResult, SnapshotStore } from './snapshots.js';
export type { DbPragmas } from './open.js';
export { BUSY_TIMEOUT_MS } from './open.js';
export { MIGRATIONS, SCHEMA_VERSION, newerVersionMessage } from './migrations.js';
export { RETENTION_DAYS } from './time.js';

export interface Db {
  /** The file the database lives in. */
  readonly path: string;
  readonly repos: RepoStore;
  readonly changes: ChangeStore;
  readonly snapshots: SnapshotStore;
  readonly events: EventStore;
  readonly review: ReviewStore;
  /** Imported findings and rule-finding states (ADR-036). */
  readonly findings: FindingsStore;
  /** Claude Code sessions and their links to changes (ADR-038). */
  readonly sessions: SessionStore;
  /**
   * Runs `fn` in one IMMEDIATE transaction (a savepoint when nested, so
   * applyPlan and event writes can be grouped); rolls back when it throws.
   */
  transaction<T>(fn: () => T): T;
  /**
   * Deletes the changes archived more than RETENTION_DAYS before `now`; their
   * snapshots, findings, events and session links go with them by cascade, and
   * the sessions left linked to no change whose last activity is older than
   * the retention go in the same transaction (ADR-038). Returns how many
   * changes were deleted.
   */
  purgeArchived(now: string): number;
  /** Like purgeArchived, and says which repos lost changes (their `archivedCount` moved). */
  purgeArchivedByRepo(now: string): Map<number, number>;
  /** The connection settings as SQLite reports them. */
  pragmas(): DbPragmas;
  close(): void;
}

function purge(db: Connection, now: string): Map<number, number> {
  const cutoff = retentionCutoff(now);
  return db.transaction(
    () => {
      const perRepo = new Map<number, number>();
      const rows = db
        .prepare<[string], { repoId: number; n: number }>(
          'SELECT repoId, count(*) AS n FROM changes WHERE archivedAt IS NOT NULL AND archivedAt < ? GROUP BY repoId',
        )
        .all(cutoff);
      for (const row of rows) perRepo.set(row.repoId, row.n);
      db.prepare<[string]>('DELETE FROM changes WHERE archivedAt IS NOT NULL AND archivedAt < ?').run(cutoff);
      // Orphans: linked to no change (any more), and quiet for the retention period.
      db.prepare<[string]>(
        'DELETE FROM sessions WHERE NOT EXISTS (SELECT 1 FROM change_sessions WHERE sessionRowId = sessions.id) AND (lastAt IS NULL OR lastAt < ?)',
      ).run(cutoff);
      return perRepo;
    },
    { immediate: true },
  );
}

/**
 * Opens the database at `path` (homePaths(home).db in the daemon), creating and
 * migrating it to the current schema when needed. Throws for a database written by a
 * newer diffcity.
 */
export function openDb(path: string, options: { warn?: (message: string) => void } = {}): Db {
  const db = openConnection(path);
  return {
    path,
    repos: createRepoStore(db),
    changes: createChangeStore(db),
    snapshots: createSnapshotStore(db, options.warn),
    events: createEventStore(db),
    review: createReviewStore(db),
    findings: createFindingsStore(db),
    sessions: createSessionStore(db),
    transaction: (fn) => db.transaction(fn, { immediate: true }),
    purgeArchived: (now) => [...purge(db, now).values()].reduce((a, b) => a + b, 0),
    purgeArchivedByRepo: (now) => purge(db, now),
    pragmas: () => readPragmas(db),
    close: () => {
      db.close();
    },
  };
}
