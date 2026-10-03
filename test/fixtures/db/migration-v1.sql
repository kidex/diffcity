
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
