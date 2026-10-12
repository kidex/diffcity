// Schema v5 (ADR-018 migrations, ADR-028 amendment, DC-135): a v4 database
// with review marks migrates in place; `review_marks` is rebuilt once with its
// rows, ids, references and index, and a "Needs rewrite" mark may have no
// note. A newer database is refused untouched.

import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION, newerVersionMessage, openDb } from '../../../src/core/db/index.js';
import { T0, rawConnection, tempDbPath } from './db-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A database exactly as diffcity v4 left it: a repo, a change, two snapshots and three marks. */
function v4Database(): string {
  const { path, remove } = tempDbPath();
  cleanups.push(remove);
  const raw = rawConnection(path);
  for (const sql of MIGRATIONS.slice(0, 4)) raw.execScript(sql);
  raw.pragma('user_version = 4');
  raw.prepare(
    "INSERT INTO repos (id, path, gitCommonDir, name, lastSeenAt, createdAt) VALUES (1, '/work/sample-shop', '/work/sample-shop/.git', 'sample-shop', ?, ?)",
  ).run(T0, T0);
  raw.prepare(
    `INSERT INTO changes (id, repoId, kind, ref, head, base, title, lastEventType, lastEventAt, updatedAt)
     VALUES (1, 1, 'branch', 'branch:a', 'abc', 'main', 'Add a', 'commit', ?, ?)`,
  ).run(T0, T0);
  for (const id of [1, 2]) {
    raw.prepare(
      `INSERT INTO snapshots (id, changeId, head, dirty, report, summary, touched, contentHash, computedAt, mergeBase, fingerprints)
       VALUES (?, 1, ?, 0, '{}', '{}', '[]', ?, ?, 'mb', '{"files":{},"symbols":{}}')`,
    ).run(id, `head-${String(id)}`, `hash-${String(id)}`, T0);
  }
  const mark = raw.prepare<[number, string, string, string | null, string | null, number | null, number | null, number, string]>(
    `INSERT INTO review_marks (id, changeId, targetKind, targetId, filePath, mark, note, lineSide, lineStart, lineEnd, fingerprint, snapshotId, state, createdAt, updatedAt)
     VALUES (?, 1, 'file', ?, 'src/a.ts', ?, ?, ?, ?, ?, 'fp', ?, ?, '${T0}', '${T0}')`,
  );
  mark.run(3, 'f-a', 'checked', null, null, null, null, 1, 'current');
  mark.run(7, 'f-b', 'rewrite', 'Split it.', 'new', 2, 5, 2, 'current');
  mark.run(8, 'f-c', 'good', null, null, null, null, 1, 'outdated');
  raw.close();
  return path;
}

describe('schema v5', () => {
  it('db/migrate-v4-to-v5-with-data: marks keep their rows and ids; a rewrite mark takes no note', () => {
    const path = v4Database();
    const db = openDb(path);
    expect(db.review.list(1).map((m) => [m.targetId, m.mark, m.note, m.lines, m.state])).toEqual([
      ['f-a', 'checked', null, null, 'current'],
      ['f-b', 'rewrite', 'Split it.', { side: 'new', start: 2, end: 5 }, 'current'],
      ['f-c', 'good', null, null, 'outdated'],
    ]);
    const bare = db.review.upsert({
      changeId: 1,
      target: { kind: 'symbol', id: 's-d' },
      filePath: 'src/d.ts',
      mark: 'rewrite',
      note: null,
      lines: null,
      fingerprint: 'fp-d',
      snapshotId: 2,
      at: T0,
    });
    expect(bare).toMatchObject({ targetId: 's-d', mark: 'rewrite', note: null });
    db.close();

    const raw = rawConnection(path);
    raw.pragma('foreign_keys = ON');
    expect(raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(5);
    expect(raw.prepare('SELECT id FROM review_marks ORDER BY id').all()).toEqual([{ id: 3 }, { id: 7 }, { id: 8 }, { id: 9 }]);
    expect(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'review_marks_v5'").get()).toEqual({ n: 0 });
    const index = raw.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'review_marks_change'").get();
    expect(index?.sql).toBe('CREATE INDEX review_marks_change ON review_marks(changeId, state)');

    // A note, when there is one, is still 1 to 2000 characters; the other constraints hold.
    const insert = (targetId: string, fields: string, values: string): void => {
      raw.prepare(
        `INSERT INTO review_marks (changeId, targetKind, targetId, filePath, fingerprint, createdAt, updatedAt, ${fields})
         VALUES (1, 'file', '${targetId}', 'src/x.ts', 'f', '${T0}', '${T0}', ${values})`,
      ).run();
    };
    expect(() => { insert('x1', 'mark, note', "'rewrite', ''"); }).toThrow(/CHECK/);
    expect(() => { insert('x2', 'mark, note', `'rewrite', '${'x'.repeat(2001)}'`); }).toThrow(/CHECK/);
    expect(() => { insert('x3', 'mark', "'redo'"); }).toThrow(/CHECK/);
    expect(() => { insert('x4', 'mark, lineStart, lineEnd', "'rewrite', 3, 4"); }).toThrow(/CHECK/);
    expect(() => { insert('f-a', 'mark', "'good'"); }).toThrow(/UNIQUE/);
    insert('x5', 'mark', "'rewrite'");

    // The references survive the rebuild: a deleted snapshot clears snapshotId, a deleted change takes its marks.
    raw.prepare('DELETE FROM snapshots WHERE id = 2').run();
    expect(raw.prepare('SELECT snapshotId FROM review_marks WHERE id = 7').get()).toEqual({ snapshotId: null });
    raw.prepare('DELETE FROM changes WHERE id = 1').run();
    expect(raw.prepare('SELECT count(*) AS n FROM review_marks').get()).toEqual({ n: 0 });
    raw.close();
  });

  it('db/migrate-v5-idempotent: reopening a v5 database changes nothing', () => {
    const path = v4Database();
    openDb(path).close();
    const read = (): unknown => {
      const raw = rawConnection(path, { readOnly: true });
      try {
        return {
          master: raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
          marks: raw.prepare('SELECT * FROM review_marks ORDER BY id').all(),
        };
      } finally {
        raw.close();
      }
    };
    const before = read();
    openDb(path).close();
    expect(read()).toEqual(before);
  });

  it('db/v6-refused: user_version 6 is a clear error and the file is left as it was', () => {
    const { path, remove } = tempDbPath();
    cleanups.push(remove);
    const raw = rawConnection(path);
    raw.pragma('user_version = 6');
    raw.close();
    expect(() => openDb(path)).toThrow(new Error(newerVersionMessage(6)));
    const check = rawConnection(path, { readOnly: true });
    expect(check.pragma('user_version', { simple: true })).toBe(6);
    expect(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 0 });
    check.close();
  });
});
