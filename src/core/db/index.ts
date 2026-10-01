// The diffcity database (SPEC.md section 4.2, ADR-018): openDb and the stores.
// Opened only by the daemon's main thread, which is the single writer.
// SQLite is Node's built-in node:sqlite, through driver.ts (ADR-025). The filter
// for its ExperimentalWarning lives in warning.ts and is deliberately not
// re-exported here: importing this module loads node:sqlite, which is too late.
//
// Every write transaction is IMMEDIATE: a deferred transaction that reads and
// then writes upgrades its lock without the busy handler and fails with
// SQLITE_BUSY at once when another connection writes (DC-39).

import type { Connection } from './driver.js';
import { createChangeStore, type ChangeStore } from './changes.js';
import { createEventStore, type EventStore } from './events.js';
import { openConnection, readPragmas, type DbPragmas } from './open.js';
import { createRepoStore, type RepoStore } from './repos.js';
import { createSnapshotStore, type SnapshotStore } from './snapshots.js';
import { retentionCutoff } from './time.js';

export type { AppliedPlan, ChangeArchive, ChangeFields, ChangePlan, ChangeStore, ChangeUpdate } from './changes.js';
export type { EventInput, EventStore } from './events.js';
export type { RepoInput, RepoRuntime, RepoRuntimeLookup, RepoStore } from './repos.js';
export type { SnapshotInput, SnapshotPutResult, SnapshotStore } from './snapshots.js';
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
  /**
   * Runs `fn` in one IMMEDIATE transaction (a savepoint when nested, so
   * applyPlan and event writes can be grouped); rolls back when it throws.
   */
  transaction<T>(fn: () => T): T;
  /**
   * Deletes the changes archived more than RETENTION_DAYS before `now`; their
   * snapshots, findings and events go with them by cascade. Returns how many
   * changes were deleted.
   */
  purgeArchived(now: string): number;
  /** The connection settings as SQLite reports them. */
  pragmas(): DbPragmas;
  close(): void;
}

function purge(db: Connection, now: string): number {
  return db
    .prepare<[string]>('DELETE FROM changes WHERE archivedAt IS NOT NULL AND archivedAt < ?')
    .run(retentionCutoff(now)).changes;
}

/**
 * Opens the database at `path` (homePaths(home).db in the daemon), creating and
 * migrating it to schema v1 when needed. Throws for a database written by a
 * newer diffcity.
 */
export function openDb(path: string): Db {
  const db = openConnection(path);
  return {
    path,
    repos: createRepoStore(db),
    changes: createChangeStore(db),
    snapshots: createSnapshotStore(db),
    events: createEventStore(db),
    transaction: (fn) => db.transaction(fn, { immediate: true }),
    purgeArchived: (now) => purge(db, now),
    pragmas: () => readPragmas(db),
    close: () => {
      db.close();
    },
  };
}
