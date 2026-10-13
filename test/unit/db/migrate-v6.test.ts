// Schema v6 (ADR-018 migrations, ADR-030, DC-121): a v5 database migrates in
// place; every snapshot keeps its row, id and Report and gains a null
// `rulesKey`, which the collector reads as "computed under unknown rules" and
// recomputes once. A newer database is refused untouched.

import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION, newerVersionMessage, openDb } from '../../../src/core/db/index.js';
import { T0, rawConnection, tempDbPath } from './db-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A database exactly as diffcity v5 left it: a repo, a change, two snapshots and a mark. */
function v5Database(): string {
  const { path, remove } = tempDbPath();
  cleanups.push(remove);
  const raw = rawConnection(path);
  for (const sql of MIGRATIONS.slice(0, 5)) raw.execScript(sql);
  raw.pragma('user_version = 5');
  raw.prepare(
    "INSERT INTO repos (id, path, gitCommonDir, name, lastSeenAt, createdAt) VALUES (1, '/work/sample-shop', '/work/sample-shop/.git', 'sample-shop', ?, ?)",
  ).run(T0, T0);
  raw.prepare(
    `INSERT INTO changes (id, repoId, kind, ref, head, base, title, lastEventType, lastEventAt, updatedAt)
     VALUES (1, 1, 'branch', 'branch:a', 'head-2', 'main', 'Add a', 'commit', ?, ?)`,
  ).run(T0, T0);
  for (const id of [1, 2]) {
    raw.prepare(
      `INSERT INTO snapshots (id, changeId, head, dirty, report, summary, touched, contentHash, computedAt, mergeBase, fingerprints)
       VALUES (?, 1, ?, 0, '{"meta":{"repo":"sample-shop"}}', '{}', '["src/a.ts"]', ?, ?, 'mb', '{"files":{},"symbols":{}}')`,
    ).run(id, `head-${String(id)}`, `hash-${String(id)}`, `2026-01-0${String(id)}T00:00:00.000Z`);
  }
  raw.prepare(
    `INSERT INTO review_marks (id, changeId, targetKind, targetId, filePath, mark, fingerprint, snapshotId, state, createdAt, updatedAt)
     VALUES (4, 1, 'file', 'f-a', 'src/a.ts', 'checked', 'fp', 2, 'current', ?, ?)`,
  ).run(T0, T0);
  raw.close();
  return path;
}

describe('schema v6', () => {
  it('db/migrate-v5-to-v6-with-data: snapshots keep their rows, ids and Reports and have no rules key yet', () => {
    const path = v5Database();
    const db = openDb(path);
    expect(db.snapshots.latestComputed(1)).toEqual({ head: 'head-2', dirty: false, rulesKey: null });
    expect(db.snapshots.latestReport(1)).toBe('{"meta":{"repo":"sample-shop"}}');
    expect(db.review.list(1).map((m) => [m.targetId, m.snapshotId, m.state])).toEqual([['f-a', 2, 'current']]);
    db.close();

    const raw = rawConnection(path);
    expect(raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(6);
    expect(raw.prepare('SELECT id, head, contentHash, rulesKey FROM snapshots ORDER BY id').all()).toEqual([
      { id: 1, head: 'head-1', contentHash: 'hash-1', rulesKey: null },
      { id: 2, head: 'head-2', contentHash: 'hash-2', rulesKey: null },
    ]);
    raw.close();
  });

  it('db/migrate-v6-idempotent: reopening a v6 database changes nothing', () => {
    const path = v5Database();
    openDb(path).close();
    const read = (): unknown => {
      const raw = rawConnection(path, { readOnly: true });
      try {
        return {
          master: raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
          snapshots: raw.prepare('SELECT * FROM snapshots ORDER BY id').all(),
        };
      } finally {
        raw.close();
      }
    };
    const before = read();
    openDb(path).close();
    expect(read()).toEqual(before);
  });

  it('db/v7-refused: user_version 7 is a clear error and the file is left as it was', () => {
    const { path, remove } = tempDbPath();
    cleanups.push(remove);
    const raw = rawConnection(path);
    raw.pragma('user_version = 7');
    raw.close();
    expect(() => openDb(path)).toThrow(new Error(newerVersionMessage(7)));
    const check = rawConnection(path, { readOnly: true });
    expect(check.pragma('user_version', { simple: true })).toBe(7);
    expect(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 0 });
    check.close();
  });
});
