// Schema v2 (ADR-018 migrations, ADR-027, ADR-028): a v1 database migrates in
// place, a second open changes nothing, a newer database is refused.

import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, newerVersionMessage, openDb } from '../../../src/core/db/index.js';
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
    expect(raw.pragma('user_version', { simple: true })).toBe(2);
    const tables = raw.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['review_marks', 'review_notes']));
    const columns = raw.prepare<[], { name: string }>('PRAGMA table_info(snapshots)').all().map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['mergeBase', 'fingerprints']));
    raw.close();
  });

  it('db/migrate-v1-to-v2: review marks and notes cascade with their change and marks are unique per target', () => {
    const path = v1Database();
    openDb(path).close();
    const raw = rawConnection(path);
    raw.pragma('foreign_keys = ON');
    const mark = raw.prepare("INSERT INTO review_marks (changeId, kind, target, fingerprint, markedAt) VALUES (1, 'file', 'src/a.ts', 'f', ?)");
    mark.run(T0);
    expect(() => mark.run(T0)).toThrow(/UNIQUE/);
    expect(() =>
      raw.prepare("INSERT INTO review_marks (changeId, kind, target, fingerprint, markedAt) VALUES (1, 'dir', 'src', 'f', ?)").run(T0),
    ).toThrow(/CHECK/);
    raw.prepare("INSERT INTO review_notes (changeId, path, line, body, createdAt, updatedAt) VALUES (1, 'src/a.ts', NULL, 'why?', ?, ?)").run(T0, T0);
    raw.prepare('DELETE FROM changes WHERE id = 1').run();
    expect(raw.prepare('SELECT count(*) AS n FROM review_marks').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT count(*) AS n FROM review_notes').get()).toEqual({ n: 0 });
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

  it('db/v3-refused: user_version 3 is a clear error and the file is left as it was', () => {
    const { path, remove } = tempDbPath();
    cleanups.push(remove);
    const raw = rawConnection(path);
    raw.pragma('user_version = 3');
    raw.close();
    expect(() => openDb(path)).toThrow(new Error(newerVersionMessage(3)));
    expect(newerVersionMessage(3)).toBe('database was created by a newer diffcity (v3); upgrade diffcity');
    const check = rawConnection(path, { readOnly: true });
    expect(check.pragma('user_version', { simple: true })).toBe(3);
    check.close();
  });
});
