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
  targetKind TEXT NOT NULL CHECK (targetKind IN ('file','symbol')),
  targetId TEXT NOT NULL,
  filePath TEXT NOT NULL,
  mark TEXT NOT NULL CHECK (mark IN ('checked','good','rewrite')),
  note TEXT,
  lineSide TEXT CHECK (lineSide IN ('old','new')),
  lineStart INTEGER,
  lineEnd INTEGER,
  fingerprint TEXT NOT NULL,
  snapshotId INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'current' CHECK (state IN ('current','outdated')),
  outdatedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE (changeId, targetKind, targetId),
  CHECK (mark <> 'rewrite' OR (note IS NOT NULL AND length(note) BETWEEN 1 AND 2000)),
  CHECK ((lineStart IS NULL AND lineEnd IS NULL AND lineSide IS NULL)
      OR (lineSide IS NOT NULL AND lineStart >= 1 AND lineEnd >= lineStart))
);
CREATE INDEX review_marks_change ON review_marks(changeId, state);

CREATE TABLE review_notes (
  changeId INTEGER PRIMARY KEY REFERENCES changes(id) ON DELETE CASCADE,
  note TEXT NOT NULL CHECK (length(note) <= 4000),
  updatedAt TEXT NOT NULL
);
`;

/**
 * Schema v3 (ADR-036): the findings store and the approval of a change.
 * `key` is the finding key (`f:<16 hex>`) of an imported finding, or the id of
 * a rule finding for an `origin = 'rule-state'` row, which only holds the
 * state the user set on that rule finding. The anchor columns are what
 * re-anchoring and `fixed` need (StoredFinding.anchor); `finding` keeps the
 * serialized Finding (its `sources` included) and `state` is authoritative.
 * Rows written before v3 have no key and are never served.
 */
const V3 = `
ALTER TABLE findings ADD COLUMN key TEXT;
ALTER TABLE findings ADD COLUMN origin TEXT NOT NULL DEFAULT 'import' CHECK (origin IN ('import','rule-state'));
ALTER TABLE findings ADD COLUMN anchorFingerprint TEXT;
ALTER TABLE findings ADD COLUMN importedAt TEXT;
ALTER TABLE findings ADD COLUMN alias TEXT;
ALTER TABLE findings ADD COLUMN why TEXT;
ALTER TABLE findings ADD COLUMN symbolName TEXT;
ALTER TABLE findings ADD COLUMN symbolKind TEXT CHECK (symbolKind IN ('class','function','method','export','sql'));
ALTER TABLE findings ADD COLUMN symbolStart INTEGER;
ALTER TABLE findings ADD COLUMN updatedAt TEXT;
CREATE UNIQUE INDEX findings_change_key ON findings(changeId, key);
ALTER TABLE changes ADD COLUMN approvedHead TEXT;
ALTER TABLE changes ADD COLUMN approvedAt TEXT;
`;

/**
 * Schema v4 (ADR-038): the Claude Code sessions seen by `track --agent` and
 * their links to changes, and the `agent-run` event type (ADR-029). SQLite
 * cannot alter a CHECK, so `events` is rebuilt once with its rows, ids and
 * index. `parsedBytes` mirrors the digest's main cursor (`digest.state`, the
 * source of truth for every cursor) for queries that do not parse the digest.
 */
const V4 = `
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  repoId INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sessionId TEXT NOT NULL,
  transcriptPath TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT,
  firstAt TEXT,
  lastAt TEXT,
  digest TEXT,
  parsedBytes INTEGER NOT NULL DEFAULT 0,
  parseError TEXT,
  UNIQUE (repoId, sessionId)
);

CREATE TABLE change_sessions (
  changeId INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  sessionRowId INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  firstHead TEXT,
  lastHead TEXT,
  linkedAt TEXT NOT NULL,
  UNIQUE (changeId, sessionRowId)
);
CREATE INDEX change_sessions_session ON change_sessions(sessionRowId);

CREATE TABLE events_v4 (
  id INTEGER PRIMARY KEY,
  repoId INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  changeId INTEGER REFERENCES changes(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('collect','agent','commit','review','import','audit','agent-run')),
  at TEXT NOT NULL,
  payload TEXT
);
INSERT INTO events_v4 (id, repoId, changeId, type, at, payload) SELECT id, repoId, changeId, type, at, payload FROM events;
DROP TABLE events;
ALTER TABLE events_v4 RENAME TO events;
CREATE INDEX events_repo_at ON events(repoId, at);
`;

/**
 * Schema v5 (ADR-028 amendment, DC-135): a "Needs rewrite" mark no longer
 * needs a note; a note, when there is one, is still 1 to 2000 characters.
 * SQLite cannot alter a CHECK, so `review_marks` is rebuilt once with its
 * rows, ids, references and index.
 */
const V5 = `
CREATE TABLE review_marks_v5 (
  id INTEGER PRIMARY KEY,
  changeId INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  targetKind TEXT NOT NULL CHECK (targetKind IN ('file','symbol')),
  targetId TEXT NOT NULL,
  filePath TEXT NOT NULL,
  mark TEXT NOT NULL CHECK (mark IN ('checked','good','rewrite')),
  note TEXT,
  lineSide TEXT CHECK (lineSide IN ('old','new')),
  lineStart INTEGER,
  lineEnd INTEGER,
  fingerprint TEXT NOT NULL,
  snapshotId INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'current' CHECK (state IN ('current','outdated')),
  outdatedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE (changeId, targetKind, targetId),
  CHECK (mark <> 'rewrite' OR note IS NULL OR length(note) BETWEEN 1 AND 2000),
  CHECK ((lineStart IS NULL AND lineEnd IS NULL AND lineSide IS NULL)
      OR (lineSide IS NOT NULL AND lineStart >= 1 AND lineEnd >= lineStart))
);
INSERT INTO review_marks_v5 (id, changeId, targetKind, targetId, filePath, mark, note, lineSide, lineStart, lineEnd,
                             fingerprint, snapshotId, state, outdatedAt, createdAt, updatedAt)
  SELECT id, changeId, targetKind, targetId, filePath, mark, note, lineSide, lineStart, lineEnd,
         fingerprint, snapshotId, state, outdatedAt, createdAt, updatedAt FROM review_marks;
DROP TABLE review_marks;
ALTER TABLE review_marks_v5 RENAME TO review_marks;
CREATE INDEX review_marks_change ON review_marks(changeId, state);
`;

/** The migrations in order; index i holds the SQL that produces version i + 1. */
export const MIGRATIONS: readonly string[] = [V1, V2, V3, V4, V5];

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
