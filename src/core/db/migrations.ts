// Schema migrations (ADR-018): an ordered list, the version kept in
// PRAGMA user_version. Migration N (1-based) brings a database from version
// N - 1 to N. Never edit a released migration; append a new one.

import type { Connection } from './driver.js';

/** Schema v1, exactly as in ADR-018. */
const V1 = `
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  gitCommonDir TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  base TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  tier1Paths TEXT,
  lastAudit TEXT,
  lastSeenAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  collectError TEXT
);

CREATE TABLE changes (
  id INTEGER PRIMARY KEY,
  repoId INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('draft','branch','pr')),
  ref TEXT NOT NULL,
  prNumber INTEGER,
  head TEXT NOT NULL,
  headAvailable INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 0,
  worktreePath TEXT,
  base TEXT NOT NULL,
  title TEXT NOT NULL,
  ahead INTEGER,
  behind INTEGER,
  reviewState TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (reviewState IN ('unreviewed','in-review','approved')),
  lastEventType TEXT NOT NULL CHECK (lastEventType IN ('collect','agent','commit','review','import','audit')),
  lastEventAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archivedAt TEXT,
  archiveReason TEXT CHECK (archiveReason IN ('merged','deleted','closed','clean'))
);
CREATE UNIQUE INDEX changes_live_ref ON changes(repoId, ref) WHERE archivedAt IS NULL;
CREATE INDEX changes_repo_event ON changes(repoId, archivedAt, lastEventAt);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  changeId INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  head TEXT NOT NULL,
  dirty INTEGER NOT NULL,
  report TEXT NOT NULL,
  summary TEXT NOT NULL,
  touched TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  computedAt TEXT NOT NULL,
  UNIQUE (changeId, head)
);

CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  changeId INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  head TEXT NOT NULL,
  finding TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','intended','fixed'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  repoId INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  changeId INTEGER REFERENCES changes(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('collect','agent','commit','review','import','audit')),
  at TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX events_repo_at ON events(repoId, at);
`;

/**
 * Schema v2: the merge-base and the fingerprints of a snapshot (ADR-027) and
 * the reviewer's marks and notes (ADR-028). The new snapshot columns are
 * nullable, so the rows of a v1 database migrate in place.
 */
const V2 = `
ALTER TABLE snapshots ADD COLUMN mergeBase TEXT;
ALTER TABLE snapshots ADD COLUMN fingerprints TEXT;

CREATE TABLE review_marks (
  id INTEGER PRIMARY KEY,
  changeId INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file','symbol')),
  target TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  markedAt TEXT NOT NULL,
  UNIQUE (changeId, kind, target)
);

CREATE TABLE review_notes (
  id INTEGER PRIMARY KEY,
  changeId INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  line INTEGER,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX review_notes_change ON review_notes(changeId);
`;

/** The migrations in order; index i holds the SQL that produces version i + 1. */
export const MIGRATIONS: readonly string[] = [V1, V2];

/** The schema version this code writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** The error for a database written by a newer diffcity (ADR-018). */
export function newerVersionMessage(version: number): string {
  return `database was created by a newer diffcity (v${String(version)}); upgrade diffcity`;
}

export function userVersion(db: Connection): number {
  return Number(db.pragma('user_version', { simple: true }));
}

/**
 * Brings `db` to SCHEMA_VERSION in a single immediate transaction. The version
 * is read first without a transaction, so a current database takes no write
 * lock at all; it is read again under the lock in case another connection
 * migrated in between. Throws newerVersionMessage for a newer database.
 */
export function migrate(db: Connection): void {
  const before = userVersion(db);
  if (before > SCHEMA_VERSION) throw new Error(newerVersionMessage(before));
  if (before === SCHEMA_VERSION) return;
  db.transaction(
    () => {
      const current = userVersion(db);
      if (current > SCHEMA_VERSION) throw new Error(newerVersionMessage(current));
      for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
        db.execScript(MIGRATIONS[version - 1] ?? '');
      }
      if (current < SCHEMA_VERSION) db.pragma(`user_version = ${String(SCHEMA_VERSION)}`);
    },
    { immediate: true },
  );
}
