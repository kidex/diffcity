// Schema v2 (ADR-018 migrations, ADR-027, ADR-028): a v1 database migrates in
// place and a second open changes nothing. The newer-version refusal is in
// migrate-v4.test.ts (db/v5-refused).

import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION, openDb } from '../../../src/core/db/index.js';
import { T0, rawConnection, tempDbPath } from './db-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A database exactly as diffcity v1 left it, with one repo, one change and one snapshot. */
function v1Database(): string {
  const { path, remove } = tempDbPath();
  cleanups.push(remove);
  const raw = rawConnection(path);
  raw.execScript(MIGRATIONS[0] ?? '');
  raw.pragma('user_version = 1');
  raw.prepare(
    "INSERT INTO repos (id, path, gitCommonDir, name, lastSeenAt, createdAt) VALUES (1, '/work/sample-shop', '/work/sample-shop/.git', 'sample-shop', ?, ?)",
  ).run(T0, T0);
  raw.prepare(
    `INSERT INTO changes (id, repoId, kind, ref, head, base, title, lastEventType, lastEventAt, updatedAt)
     VALUES (1, 1, 'branch', 'branch:a', 'abc', 'main', 'Add a', 'commit', ?, ?)`,
  ).run(T0, T0);
  raw.prepare(
    `INSERT INTO snapshots (changeId, head, dirty, report, summary, touched, contentHash, computedAt)
     VALUES (1, 'abc', 0, '{}', '{}', '[]', 'hash', ?)`,
  ).run(T0);
  raw.close();
  return path;
}

describe('schema v2', () => {
  it('db/migrate-v1-to-v2: a v1 database migrates in place and keeps its rows', () => {
    const path = v1Database();
    const db = openDb(path);
    const latest = db.snapshots.latest(1);
    expect(latest).toMatchObject({ head: 'abc', contentHash: 'hash', mergeBase: null, fingerprints: null });
    expect(db.snapshots.latestFingerprints(1)).toBeNull();
    db.close();

    const raw = rawConnection(path, { readOnly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const tables = raw.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['review_marks', 'review_notes']));
    const columns = raw.prepare<[], { name: string }>('PRAGMA table_info(snapshots)').all().map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['mergeBase', 'fingerprints']));
    raw.close();
  });

  it('db/migrate-v1-to-v2: review_marks has the ADR-028 columns, constraints and index', () => {
    const path = v1Database();
    openDb(path).close();
    const raw = rawConnection(path, { readOnly: true });
    const columns = raw.prepare<[], { name: string }>('PRAGMA table_info(review_marks)').all().map((c) => c.name);
    expect(columns).toEqual([
      'id', 'changeId', 'targetKind', 'targetId', 'filePath', 'mark', 'note', 'lineSide', 'lineStart', 'lineEnd',
      'fingerprint', 'snapshotId', 'state', 'outdatedAt', 'createdAt', 'updatedAt',
    ]);
    const notes = raw.prepare<[], { name: string }>('PRAGMA table_info(review_notes)').all().map((c) => c.name);
    expect(notes).toEqual(['changeId', 'note', 'updatedAt']);
    const sql = raw.prepare<[], { name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE name IN ('review_marks','review_marks_change')").all();
    const text = sql.map((r) => r.sql).join('\n');
    expect(text).toContain("CHECK (targetKind IN ('file','symbol'))");
    expect(text).toContain("CHECK (mark IN ('checked','good','rewrite'))");
    expect(text).toContain("CHECK (lineSide IN ('old','new'))");
    expect(text).toContain("CHECK (state IN ('current','outdated'))");
    expect(text).toContain('UNIQUE (changeId, targetKind, targetId)');
    expect(text).toContain('REFERENCES snapshots(id) ON DELETE SET NULL');
    expect(text).toContain('CREATE INDEX review_marks_change ON review_marks(changeId, state)');
    raw.close();
  });

  it('db/migrate-v1-to-v2: marks enforce their constraints and cascade with the change', () => {
    const path = v1Database();
    openDb(path).close();
    const raw = rawConnection(path);
    raw.pragma('foreign_keys = ON');
    const insert = (fields: string, values: string): void => {
      raw.prepare(
        `INSERT INTO review_marks (changeId, targetKind, targetId, filePath, fingerprint, createdAt, updatedAt, ${fields})
         VALUES (1, 'file', 'src/a.ts', 'src/a.ts', 'f', '${T0}', '${T0}', ${values})`,
      ).run();
    };
    insert('mark', "'checked'");
    expect(() => { insert('mark', "'good'"); }).toThrow(/UNIQUE/);
    raw.prepare('DELETE FROM review_marks').run();
    expect(() => { insert('mark', "'rewrite'"); }).toThrow(/CHECK/);
    expect(() => { insert('mark, note', "'rewrite', ''"); }).toThrow(/CHECK/);
    expect(() => { insert('mark, note', `'rewrite', '${'x'.repeat(2001)}'`); }).toThrow(/CHECK/);
    insert('mark, note', "'rewrite', 'split this'");
    raw.prepare('DELETE FROM review_marks').run();
    expect(() => { insert('mark, lineStart, lineEnd', "'checked', 3, 4"); }).toThrow(/CHECK/);
    expect(() => { insert('mark, lineSide, lineStart, lineEnd', "'checked', 'new', 5, 4"); }).toThrow(/CHECK/);
    expect(() => { insert('mark, lineSide, lineStart, lineEnd', "'checked', 'left', 1, 1"); }).toThrow(/CHECK/);
    insert('mark, lineSide, lineStart, lineEnd', "'good', 'old', 3, 4");
    expect(() => { insert('mark, state', "'checked', 'stale'"); }).toThrow(/CHECK/);
    raw.prepare("INSERT INTO review_notes (changeId, note, updatedAt) VALUES (1, 'overall fine', ?)").run(T0);
    expect(() => raw.prepare("INSERT INTO review_notes (changeId, note, updatedAt) VALUES (1, 'again', ?)").run(T0)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => raw.prepare('UPDATE review_notes SET note = ? WHERE changeId = 1').run('x'.repeat(4001))).toThrow(/CHECK/);
    raw.prepare('DELETE FROM changes WHERE id = 1').run();
    expect(raw.prepare('SELECT count(*) AS n FROM review_marks').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT count(*) AS n FROM review_notes').get()).toEqual({ n: 0 });
    raw.close();
  });

  it('db/migrate-v1-to-v2: deleting a snapshot nulls the snapshotId of its marks', () => {
    const path = v1Database();
    openDb(path).close();
    const raw = rawConnection(path);
    raw.pragma('foreign_keys = ON');
    const snapshotId = (raw.prepare<[], { id: number }>('SELECT id FROM snapshots').get() ?? { id: -1 }).id;
    raw.prepare(
      `INSERT INTO review_marks (changeId, targetKind, targetId, filePath, mark, fingerprint, snapshotId, createdAt, updatedAt)
       VALUES (1, 'file', 'src/a.ts', 'src/a.ts', 'checked', 'f', ?, ?, ?)`,
    ).run(snapshotId, T0, T0);
    raw.prepare('DELETE FROM snapshots').run();
    expect(raw.prepare('SELECT snapshotId, state FROM review_marks').get()).toEqual({ snapshotId: null, state: 'current' });
    raw.close();
  });

  it('db/migrate-v2-idempotent: reopening a v2 database changes nothing', () => {
    const path = v1Database();
    openDb(path).close();
    const snapshot = (): unknown => {
      const raw = rawConnection(path, { readOnly: true });
      try {
        return {
          version: raw.pragma('user_version', { simple: true }),
          master: raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
          snapshots: raw.prepare('SELECT * FROM snapshots').all(),
        };
      } finally {
        raw.close();
      }
    };
    const before = snapshot();
    openDb(path).close();
    expect(snapshot()).toEqual(before);
  });
});
