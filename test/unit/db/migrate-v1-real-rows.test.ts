// A v1 database with several rows in every table survives the v2 migration,
// and the v1 SQL used to build it is the one main shipped (kept verbatim in
// test/fixtures/db/migration-v1.sql, so the check needs no git history).

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDb } from '../../../src/core/db/index.js';
import { T0, rawConnection, tempDbPath } from './db-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('db/migrate-v1-to-v2: rows', () => {
  it('the v1 migration SQL is byte-identical to the one main shipped before DC-69', () => {
    const shipped = readFileSync(new URL('../../fixtures/db/migration-v1.sql', import.meta.url), 'utf8');
    expect(MIGRATIONS[0]).toBe(shipped);
  });

  it('every v1 row survives with mergeBase and fingerprints null', () => {
    const { path, remove } = tempDbPath();
    cleanups.push(remove);
    const raw = rawConnection(path);
    raw.execScript(MIGRATIONS[0] ?? '');
    raw.pragma('user_version = 1');
    const repo = raw.prepare(
      "INSERT INTO repos (id, path, gitCommonDir, name, lastSeenAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
    );
    repo.run(1, '/work/sample-shop', '/work/sample-shop/.git', 'sample-shop', T0, T0);
    repo.run(2, '/work/sample-api', '/work/sample-api/.git', 'sample-api', T0, T0);
    const change = raw.prepare(
      `INSERT INTO changes (id, repoId, kind, ref, head, base, title, lastEventType, lastEventAt, updatedAt)
       VALUES (?, ?, 'branch', ?, ?, 'main', ?, 'commit', ?, ?)`,
    );
    change.run(1, 1, 'branch:a', 'aaa', 'Add a', T0, T0);
    change.run(2, 1, 'branch:b', 'bbb', 'Add b', T0, T0);
    change.run(3, 2, 'branch:c', 'ccc', 'Add c', T0, T0);
    const snap = raw.prepare(
      `INSERT INTO snapshots (changeId, head, dirty, report, summary, touched, contentHash, computedAt)
       VALUES (?, ?, 0, ?, '{}', '[]', ?, ?)`,
    );
    snap.run(1, 'a1', '{"n":1}', 'h1', T0);
    snap.run(1, 'a2', '{"n":2}', 'h2', T0);
    snap.run(2, 'b1', '{"n":3}', 'h3', T0);
    snap.run(3, 'c1', '{"n":4}', 'h4', T0);
    raw.close();

    const db = openDb(path);
    db.close();
    const after = rawConnection(path, { readOnly: true });
    expect(after.pragma('user_version', { simple: true })).toBe(2);
    expect(after.prepare<[], { n: number }>('SELECT count(*) AS n FROM repos').get()?.n).toBe(2);
    expect(after.prepare<[], { n: number }>('SELECT count(*) AS n FROM changes').get()?.n).toBe(3);
    const rows = after
      .prepare<[], { changeId: number; head: string; report: string; contentHash: string; mergeBase: string | null; fingerprints: string | null }>(
        'SELECT changeId, head, report, contentHash, mergeBase, fingerprints FROM snapshots ORDER BY id',
      )
      .all();
    expect(rows).toEqual([
      { changeId: 1, head: 'a1', report: '{"n":1}', contentHash: 'h1', mergeBase: null, fingerprints: null },
      { changeId: 1, head: 'a2', report: '{"n":2}', contentHash: 'h2', mergeBase: null, fingerprints: null },
      { changeId: 2, head: 'b1', report: '{"n":3}', contentHash: 'h3', mergeBase: null, fingerprints: null },
      { changeId: 3, head: 'c1', report: '{"n":4}', contentHash: 'h4', mergeBase: null, fingerprints: null },
    ]);
    expect(after.prepare<[], { n: number }>('SELECT count(*) AS n FROM review_marks').get()?.n).toBe(0);
    after.close();
  });
});
