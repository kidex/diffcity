// Schema v3 (ADR-018 migrations, ADR-036): a v2 database migrates in place,
// keeps its rows, gains the findings and approval columns. The newer-version
// refusal is in migrate-v4.test.ts (db/v5-refused).

import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION, openDb } from '../../../src/core/db/index.js';
import { T0, rawConnection, tempDbPath } from './db-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A database exactly as diffcity v2 left it: one repo, one change, one snapshot, one mark and a legacy findings row. */
function v2Database(): string {
  const { path, remove } = tempDbPath();
  cleanups.push(remove);
  const raw = rawConnection(path);
  raw.execScript(MIGRATIONS[0] ?? '');
  raw.execScript(MIGRATIONS[1] ?? '');
  raw.pragma('user_version = 2');
  raw.prepare(
    "INSERT INTO repos (id, path, gitCommonDir, name, lastSeenAt, createdAt) VALUES (1, '/work/sample-shop', '/work/sample-shop/.git', 'sample-shop', ?, ?)",
  ).run(T0, T0);
  raw.prepare(
    `INSERT INTO changes (id, repoId, kind, ref, head, base, title, reviewState, lastEventType, lastEventAt, updatedAt)
     VALUES (1, 1, 'branch', 'branch:a', 'abc', 'main', 'Add a', 'approved', 'commit', ?, ?)`,
  ).run(T0, T0);
  raw.prepare(
    `INSERT INTO snapshots (id, changeId, head, dirty, report, summary, touched, contentHash, computedAt, mergeBase, fingerprints)
     VALUES (1, 1, 'abc', 0, '{}', '{}', '[]', 'hash', ?, 'mb', '{"files":{},"symbols":{}}')`,
  ).run(T0);
  raw.prepare(
    `INSERT INTO review_marks (changeId, targetKind, targetId, filePath, mark, fingerprint, snapshotId, createdAt, updatedAt)
     VALUES (1, 'file', 'f-a', 'src/a.ts', 'checked', 'fp', 1, ?, ?)`,
  ).run(T0, T0);
  raw.prepare("INSERT INTO findings (changeId, head, finding, state) VALUES (1, 'abc', '{\"title\":\"legacy\"}', 'open')").run();
  raw.close();
  return path;
}

function columnsOf(path: string, table: string): string[] {
  const raw = rawConnection(path, { readOnly: true });
  try {
    return raw
      .prepare<[], { name: string; type: string; notnull: number; dflt_value: string | null }>(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value === null ? '' : ` = ${c.dflt_value}`}`);
  } finally {
    raw.close();
  }
}

describe('schema v3', () => {
  it('db/migrate-v2-to-v3: a v2 database migrates in place and keeps its rows', () => {
    const path = v2Database();
    const db = openDb(path);
    expect(db.snapshots.latest(1)).toMatchObject({ head: 'abc', contentHash: 'hash', mergeBase: 'mb' });
    expect(db.review.list(1).map((m) => [m.targetId, m.state])).toEqual([['f-a', 'current']]);
    expect(db.changes.get(1)).toMatchObject({ reviewState: 'approved' });
    expect(db.changes.approval(1)).toEqual({ approvedHead: null, approvedAt: null });
    // The legacy row has no key: the store does not serve it, and it stays in the table.
    expect(db.findings.list(1)).toEqual([]);
    expect(db.findings.hasAny(1)).toBe(false);
    db.close();

    const raw = rawConnection(path, { readOnly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(raw.prepare('SELECT origin, key, finding FROM findings').all()).toEqual([
      { origin: 'import', key: null, finding: '{"title":"legacy"}' },
    ]);
    raw.close();
  });

  it('db/migrate-v2-to-v3: findings and changes have the v3 columns, the key index and the CHECKs', () => {
    const path = v2Database();
    openDb(path).close();
    expect(columnsOf(path, 'findings')).toEqual([
      'id INTEGER',
      'changeId INTEGER NOT NULL',
      'head TEXT NOT NULL',
      'finding TEXT NOT NULL',
      'state TEXT NOT NULL',
      'key TEXT',
      "origin TEXT NOT NULL = 'import'",
      'anchorFingerprint TEXT',
      'importedAt TEXT',
      'alias TEXT',
      'why TEXT',
      'symbolName TEXT',
      'symbolKind TEXT',
      'symbolStart INTEGER',
      'updatedAt TEXT',
    ]);
    expect(columnsOf(path, 'changes').slice(-2)).toEqual(['approvedHead TEXT', 'approvedAt TEXT']);

    const raw = rawConnection(path);
    raw.pragma('foreign_keys = ON');
    const index = raw.prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'findings_change_key'").get();
    expect(index?.sql).toBe('CREATE UNIQUE INDEX findings_change_key ON findings(changeId, key)');
    const insert = (key: string, origin: string, symbolKind: string | null = null): void => {
      raw.prepare("INSERT INTO findings (changeId, head, finding, state, key, origin, symbolKind) VALUES (1, 'abc', '{}', 'open', ?, ?, ?)").run(
        key,
        origin,
        symbolKind,
      );
    };
    insert('f:0000000000000001', 'import', 'method');
    expect(() => { insert('f:0000000000000001', 'import'); }).toThrow(/UNIQUE/);
    expect(() => { insert('f:0000000000000002', 'other'); }).toThrow(/CHECK/);
    expect(() => { insert('f:0000000000000003', 'import', 'module'); }).toThrow(/CHECK/);
    insert('rule:size:1', 'rule-state');
    raw.prepare('DELETE FROM changes WHERE id = 1').run();
    expect(raw.prepare('SELECT count(*) AS n FROM findings').get()).toEqual({ n: 0 });
    raw.close();
  });

  it('db/migrate-v3-idempotent: reopening a v3 database changes nothing', () => {
    const path = v2Database();
    openDb(path).close();
    const read = (): unknown => {
      const raw = rawConnection(path, { readOnly: true });
      try {
        return {
          version: raw.pragma('user_version', { simple: true }),
          master: raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
          findings: raw.prepare('SELECT * FROM findings').all(),
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
