// Schema v4 (ADR-018 migrations, ADR-038): a v3 database with events, marks
// and findings migrates in place; `events` is rebuilt once with its rows, ids
// and index and takes `agent-run`; the sessions tables appear. A newer
// database is refused untouched.

import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION, openDb } from '../../../src/core/db/index.js';
import { T0, rawConnection, tempDbPath } from './db-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const EVENTS = [
  { id: 1, repoId: 1, changeId: 1, type: 'commit', at: '2026-09-01T10:00:00.000Z', payload: '{"head":"abc"}' },
  { id: 2, repoId: 1, changeId: 1, type: 'collect', at: '2026-09-01T10:01:00.000Z', payload: '{"head":"abc"}' },
  { id: 3, repoId: 1, changeId: null, type: 'agent', at: '2026-09-01T10:02:00.000Z', payload: '{"worktree":"/work/sample-shop"}' },
  { id: 5, repoId: 1, changeId: 1, type: 'review', at: '2026-09-01T10:03:00.000Z', payload: null },
  { id: 9, repoId: 1, changeId: 1, type: 'import', at: '2026-09-01T10:04:00.000Z', payload: '{"imported":1}' },
];

/** A database exactly as diffcity v3 left it: a repo, a change, a snapshot, events, a mark, a note and an imported finding. */
function v3Database(): string {
  const { path, remove } = tempDbPath();
  cleanups.push(remove);
  const raw = rawConnection(path);
  for (const sql of MIGRATIONS.slice(0, 3)) raw.execScript(sql);
  raw.pragma('user_version = 3');
  raw.prepare(
    "INSERT INTO repos (id, path, gitCommonDir, name, lastSeenAt, createdAt) VALUES (1, '/work/sample-shop', '/work/sample-shop/.git', 'sample-shop', ?, ?)",
  ).run(T0, T0);
  raw.prepare(
    `INSERT INTO changes (id, repoId, kind, ref, head, base, title, reviewState, lastEventType, lastEventAt, updatedAt, approvedHead, approvedAt)
     VALUES (1, 1, 'branch', 'branch:a', 'abc', 'main', 'Add a', 'approved', 'commit', ?, ?, 'abc', ?)`,
  ).run(T0, T0, T0);
  raw.prepare(
    `INSERT INTO snapshots (id, changeId, head, dirty, report, summary, touched, contentHash, computedAt, mergeBase, fingerprints)
     VALUES (1, 1, 'abc', 0, '{}', '{}', '[]', 'hash', ?, 'mb', '{"files":{},"symbols":{}}')`,
  ).run(T0);
  raw.prepare(
    `INSERT INTO review_marks (changeId, targetKind, targetId, filePath, mark, fingerprint, snapshotId, createdAt, updatedAt)
     VALUES (1, 'file', 'f-a', 'src/a.ts', 'checked', 'fp', 1, ?, ?)`,
  ).run(T0, T0);
  raw.prepare("INSERT INTO review_notes (changeId, note, updatedAt) VALUES (1, 'Looks fine', ?)").run(T0);
  raw.prepare(
    `INSERT INTO findings (changeId, head, finding, state, key, origin, importedAt, updatedAt)
     VALUES (1, 'abc', '{"title":"Invented"}', 'open', 'f:00000000000000aa', 'import', ?, ?)`,
  ).run(T0, T0);
  const event = raw.prepare<[number, number, number | null, string, string, string | null]>(
    'INSERT INTO events (id, repoId, changeId, type, at, payload) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const row of EVENTS) event.run(row.id, row.repoId, row.changeId, row.type, row.at, row.payload);
  raw.close();
  return path;
}

describe('schema v4', () => {
  it('db/migrate-v3-to-v4-with-data: events, marks and findings survive; events take agent-run; sessions tables appear', () => {
    const path = v3Database();
    const db = openDb(path);
    expect(db.events.listForRepo(1).map((event) => [event.id, event.type, event.changeId, event.payload])).toEqual([
      [9, 'import', 1, { imported: 1 }],
      [5, 'review', 1, null],
      [3, 'agent', null, { worktree: '/work/sample-shop' }],
      [2, 'collect', 1, { head: 'abc' }],
      [1, 'commit', 1, { head: 'abc' }],
    ]);
    expect(db.review.list(1).map((mark) => [mark.targetId, mark.mark, mark.state])).toEqual([['f-a', 'checked', 'current']]);
    expect(db.review.note(1)).toBe('Looks fine');
    expect(db.findings.hasAny(1)).toBe(true);
    expect(db.changes.approval(1)).toEqual({ approvedHead: 'abc', approvedAt: T0 });

    // The new type is accepted, and ids continue after the copied rows.
    const added = db.events.add({ repoId: 1, changeId: 1, type: 'agent-run', at: '2026-09-01T11:00:00.000Z', payload: { sessionId: 'abcdef01' } });
    expect(added.id).toBe(10);
    const session = db.sessions.see({ repoId: 1, sessionId: 'abcdef01', transcriptPath: '/claude/projects/p/abcdef01.jsonl', cwd: '/work/sample-shop', at: T0 });
    db.sessions.link(1, session.id, 'abc', T0);
    expect(db.sessions.forChange(1, 20).map((row) => row.session.sessionId)).toEqual(['abcdef01']);
    db.close();

    const raw = rawConnection(path);
    raw.pragma('foreign_keys = ON');
    expect(raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(raw.prepare('SELECT key, state, finding FROM findings').all()).toEqual([{ key: 'f:00000000000000aa', state: 'open', finding: '{"title":"Invented"}' }]);
    const index = raw.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'events_repo_at'").get();
    expect(index?.sql).toBe('CREATE INDEX events_repo_at ON events(repoId, at)');
    expect(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'events_v4'").get()).toEqual({ n: 0 });
    expect(() => raw.prepare("INSERT INTO events (repoId, type, at) VALUES (1, 'other', 'x')").run()).toThrow(/CHECK/);
    // The rebuilt table keeps its cascades: deleting the change takes its events and session links.
    raw.prepare('DELETE FROM changes WHERE id = 1').run();
    expect(raw.prepare('SELECT id FROM events ORDER BY id').all()).toEqual([{ id: 3 }]);
    expect(raw.prepare('SELECT count(*) AS n FROM change_sessions').get()).toEqual({ n: 0 });
    raw.close();
  });

  it('db/migrate-v4-idempotent: reopening a v4 database changes nothing', () => {
    const path = v3Database();
    openDb(path).close();
    const read = (): unknown => {
      const raw = rawConnection(path, { readOnly: true });
      try {
        return {
          master: raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
          events: raw.prepare('SELECT * FROM events ORDER BY id').all(),
        };
      } finally {
        raw.close();
      }
    };
    const before = read();
    openDb(path).close();
    expect(read()).toEqual(before);
  });
});
