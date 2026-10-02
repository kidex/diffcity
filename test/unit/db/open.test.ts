// openDb: pragmas, migrations through user_version and schema v1 (ADR-018).

import { afterEach, describe, expect, it } from 'vitest';
import { BUSY_TIMEOUT_MS, SCHEMA_VERSION, newerVersionMessage, openDb } from '../../../src/core/db/index.js';
import { addRepo, tempDb, tempDbPath, rawConnection } from './db-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fresh(): ReturnType<typeof tempDb> {
  const temp = tempDb();
  cleanups.push(temp.cleanup);
  return temp;
}

interface MasterRow {
  type: string;
  name: string;
  sql: string | null;
}

/** The schema as SQLite stores it, read through a separate plain connection. */
function readSchema(path: string): { version: number; master: MasterRow[]; columns: Record<string, string[]> } {
  const raw = rawConnection(path, { readOnly: true });
  try {
    const master = raw
      .prepare<[], MasterRow>(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    const columns: Record<string, string[]> = {};
    for (const table of master.filter((row) => row.type === 'table')) {
      columns[table.name] = raw
        .prepare<[], { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(
          `PRAGMA table_info(${table.name})`,
        )
        .all()
        .map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}${c.dflt_value === null ? '' : ` = ${c.dflt_value}`}`);
    }
    return { version: Number(raw.pragma('user_version', { simple: true })), master, columns };
  } finally {
    raw.close();
  }
}

describe('openDb pragmas', () => {
  it('sets WAL, foreign_keys, busy_timeout 5000 and synchronous NORMAL', () => {
    const { db } = fresh();
    expect(db.pragmas()).toEqual({ journalMode: 'wal', foreignKeys: true, busyTimeout: 5000, synchronous: 1 });
    expect(BUSY_TIMEOUT_MS).toBe(5000);
  });
});

describe('migrations', () => {
  it('db/migrate-fresh: an empty file becomes the current schema', () => {
    const { db, path } = fresh();
    db.close();
    const schema = readSchema(path);

    expect(SCHEMA_VERSION).toBe(2);
    expect(schema.version).toBe(2);
    expect(schema.master.filter((row) => row.type === 'table').map((row) => row.name)).toEqual([
      'changes',
      'events',
      'findings',
      'repos',
      'review_marks',
      'review_notes',
      'snapshots',
    ]);
    expect(schema.columns).toEqual({
      repos: [
        'id INTEGER PK',
        'path TEXT NOT NULL',
        'gitCommonDir TEXT NOT NULL',
        'name TEXT NOT NULL',
        'base TEXT',
        'active INTEGER NOT NULL = 1',
        'tier1Paths TEXT',
        'lastAudit TEXT',
        'lastSeenAt TEXT NOT NULL',
        'createdAt TEXT NOT NULL',
        'collectError TEXT',
      ],
      changes: [
        'id INTEGER PK',
        'repoId INTEGER NOT NULL',
        'kind TEXT NOT NULL',
        'ref TEXT NOT NULL',
        'prNumber INTEGER',
        'head TEXT NOT NULL',
        'headAvailable INTEGER NOT NULL = 1',
        'dirty INTEGER NOT NULL = 0',
        'worktreePath TEXT',
        'base TEXT NOT NULL',
        'title TEXT NOT NULL',
        'ahead INTEGER',
        'behind INTEGER',
        "reviewState TEXT NOT NULL = 'unreviewed'",
        'lastEventType TEXT NOT NULL',
        'lastEventAt TEXT NOT NULL',
        'updatedAt TEXT NOT NULL',
        'archivedAt TEXT',
        'archiveReason TEXT',
      ],
      snapshots: [
        'id INTEGER PK',
        'changeId INTEGER NOT NULL',
        'head TEXT NOT NULL',
        'dirty INTEGER NOT NULL',
        'report TEXT NOT NULL',
        'summary TEXT NOT NULL',
        'touched TEXT NOT NULL',
        'contentHash TEXT NOT NULL',
        'computedAt TEXT NOT NULL',
        'mergeBase TEXT',
        'fingerprints TEXT',
      ],
      review_marks: [
        'id INTEGER PK',
        'changeId INTEGER NOT NULL',
        'kind TEXT NOT NULL',
        'target TEXT NOT NULL',
        'fingerprint TEXT NOT NULL',
        'markedAt TEXT NOT NULL',
      ],
      review_notes: [
        'id INTEGER PK',
        'changeId INTEGER NOT NULL',
        'path TEXT NOT NULL',
        'line INTEGER',
        'body TEXT NOT NULL',
        'createdAt TEXT NOT NULL',
        'updatedAt TEXT NOT NULL',
      ],
      findings: [
        'id INTEGER PK',
        'changeId INTEGER NOT NULL',
        'head TEXT NOT NULL',
        'finding TEXT NOT NULL',
        'state TEXT NOT NULL',
      ],
      events: [
        'id INTEGER PK',
        'repoId INTEGER NOT NULL',
        'changeId INTEGER',
        'type TEXT NOT NULL',
        'at TEXT NOT NULL',
        'payload TEXT',
      ],
    });

    const indexes = Object.fromEntries(
      schema.master.filter((row) => row.type === 'index').map((row) => [row.name, row.sql]),
    );
    expect(indexes).toEqual({
      changes_live_ref: 'CREATE UNIQUE INDEX changes_live_ref ON changes(repoId, ref) WHERE archivedAt IS NULL',
      changes_repo_event: 'CREATE INDEX changes_repo_event ON changes(repoId, archivedAt, lastEventAt)',
      events_repo_at: 'CREATE INDEX events_repo_at ON events(repoId, at)',
      review_notes_change: 'CREATE INDEX review_notes_change ON review_notes(changeId)',
    });
  });

  it('db/migrate-fresh: CHECK constraints and cascades are in place', () => {
    const { path, db } = fresh();
    db.close();
    const { master } = readSchema(path);
    const sql = (name: string): string => master.find((row) => row.name === name)?.sql ?? '';

    expect(sql('changes')).toContain("CHECK (kind IN ('draft','branch','pr'))");
    expect(sql('changes')).toContain("CHECK (reviewState IN ('unreviewed','in-review','approved'))");
    expect(sql('changes')).toContain(
      "CHECK (lastEventType IN ('collect','agent','commit','review','import','audit'))",
    );
    expect(sql('changes')).toContain("CHECK (archiveReason IN ('merged','deleted','closed','clean'))");
    expect(sql('changes')).toContain('REFERENCES repos(id) ON DELETE CASCADE');
    expect(sql('snapshots')).toContain('REFERENCES changes(id) ON DELETE CASCADE');
    expect(sql('snapshots')).toContain('UNIQUE (changeId, head)');
    expect(sql('findings')).toContain("CHECK (state IN ('open','intended','fixed'))");
    expect(sql('findings')).toContain('REFERENCES changes(id) ON DELETE CASCADE');
    expect(sql('events')).toContain('REFERENCES repos(id) ON DELETE CASCADE');
    expect(sql('events')).toContain('REFERENCES changes(id) ON DELETE CASCADE');
    expect(sql('events')).toContain("CHECK (type IN ('collect','agent','commit','review','import','audit'))");
  });

  it('db/migrate-idempotent: a second open changes neither the schema nor the data', () => {
    const { db, path } = fresh();
    const repo = addRepo(db);
    db.close();
    const before = readSchema(path);

    const again = openDb(path);
    expect(again.repos.list()).toEqual([repo]);
    expect(again.pragmas().journalMode).toBe('wal');
    again.close();

    expect(readSchema(path)).toEqual(before);
  });

  it('db/newer-version-refused: a newer user_version is a clear error and the file is left as it was', () => {
    const { path, remove } = tempDbPath();
    cleanups.push(remove);
    const raw = rawConnection(path);
    raw.pragma('user_version = 7');
    raw.close();

    expect(() => openDb(path)).toThrow(new Error(newerVersionMessage(7)));
    expect(newerVersionMessage(7)).toBe('database was created by a newer diffcity (v7); upgrade diffcity');

    const check = rawConnection(path, { readOnly: true });
    expect(check.pragma('user_version', { simple: true })).toBe(7);
    expect(check.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 0 });
    check.close();
  });

  it('refuses a missing parent directory instead of creating it', () => {
    const { path, remove } = tempDbPath();
    cleanups.push(remove);
    expect(() => openDb(`${path}-missing/diffcity.db`)).toThrow(/directory does not exist/);
  });
});
