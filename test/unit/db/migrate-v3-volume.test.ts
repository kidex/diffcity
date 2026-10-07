// Schema v3 (ADR-036) on a v2 database with many rows: every row survives the
// migration, legacy findings rows (no key) never collide on the unique key
// index and are never served, and a reopened v3 database keeps what the v3
// stores wrote (imported findings, rule states, approvals).

import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDb } from '../../../src/core/db/index.js';
import type { StoredFinding } from '../../../src/core/findings/types.js';
import { T0, rawConnection, tempDbPath } from './db-helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const CHANGES = 60;
const LEGACY_PER_CHANGE = 100;

function bigV2Database(): string {
  const { path, remove } = tempDbPath();
  cleanups.push(remove);
  const raw = rawConnection(path);
  raw.execScript(MIGRATIONS[0] ?? '');
  raw.execScript(MIGRATIONS[1] ?? '');
  raw.pragma('user_version = 2');
  raw.prepare(
    "INSERT INTO repos (id, path, gitCommonDir, name, lastSeenAt, createdAt) VALUES (1, '/work/sample-depot', '/work/sample-depot/.git', 'sample-depot', ?, ?)",
  ).run(T0, T0);
  const change = raw.prepare(
    `INSERT INTO changes (id, repoId, kind, ref, head, base, title, reviewState, lastEventType, lastEventAt, updatedAt)
     VALUES (?, 1, 'branch', ?, ?, 'main', ?, 'in-review', 'commit', ?, ?)`,
  );
  const snapshot = raw.prepare(
    `INSERT INTO snapshots (changeId, head, dirty, report, summary, touched, contentHash, computedAt, mergeBase, fingerprints)
     VALUES (?, ?, 0, '{}', '{}', '[]', ?, ?, 'mb', '{"files":{},"symbols":{}}')`,
  );
  const legacy = raw.prepare("INSERT INTO findings (changeId, head, finding, state) VALUES (?, ?, ?, 'open')");
  raw.execScript('BEGIN');
  for (let id = 1; id <= CHANGES; id += 1) {
    const head = id.toString(16).padStart(40, '0');
    change.run(id, `branch:topic-${String(id)}`, head, `Topic ${String(id)}`, T0, T0);
    snapshot.run(id, head, `hash-${String(id)}`, T0);
    for (let n = 0; n < LEGACY_PER_CHANGE; n += 1) legacy.run(id, head, JSON.stringify({ title: `legacy ${String(n)}` }));
  }
  raw.execScript('COMMIT');
  raw.close();
  return path;
}

function stored(n: number): StoredFinding {
  const key = `f:${n.toString(16).padStart(16, '0')}`;
  return {
    key,
    finding: {
      id: key,
      source: 'claude',
      severity: 'med',
      category: 'correctness',
      file: 'src/depot/stock.ts',
      line: n + 1,
      title: `Stock finding ${String(n)}`,
      message: 'An invented finding.',
      state: 'open',
    },
    anchor: { fingerprint: null },
  };
}

describe('schema v3 on a large v2 database', () => {
  it('db/migrate-v2-to-v3: thousands of rows survive, legacy findings are kept unkeyed and unserved', () => {
    const path = bigV2Database();
    const db = openDb(path);
    for (let id = 1; id <= CHANGES; id += 1) {
      expect(db.findings.list(id)).toEqual([]);
      expect(db.findings.hasAny(id)).toBe(false);
      expect(db.changes.approval(id)).toEqual({ approvedHead: null, approvedAt: null });
    }
    // The store writes into a migrated change next to its legacy rows.
    const result = db.findings.importBatch({ changeId: 7, head: '7'.padStart(40, '0'), findings: [stored(1), stored(2)], fixed: [], at: T0 });
    expect(result).toMatchObject({ inserted: 2, updated: 0, fixed: 0 });
    expect(db.findings.list(7).map((f) => f.key)).toEqual([stored(1).key, stored(2).key]);
    db.close();

    const raw = rawConnection(path, { readOnly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(3);
    expect(raw.prepare('SELECT count(*) AS n FROM changes').get()).toEqual({ n: CHANGES });
    expect(raw.prepare('SELECT count(*) AS n FROM snapshots').get()).toEqual({ n: CHANGES });
    expect(raw.prepare('SELECT count(*) AS n FROM findings WHERE key IS NULL').get()).toEqual({ n: CHANGES * LEGACY_PER_CHANGE });
    expect(raw.prepare("SELECT count(*) AS n FROM findings WHERE origin = 'import'").get()).toEqual({ n: CHANGES * LEGACY_PER_CHANGE + 2 });
    raw.close();
  });

  it('db/migrate-v3-idempotent: a reopened v3 database keeps imported findings, rule states and approvals', () => {
    const path = bigV2Database();
    const first = openDb(path);
    first.findings.importBatch({ changeId: 3, head: '3'.padStart(40, '0'), findings: [stored(5), stored(6)], fixed: [], at: T0 });
    first.findings.setStates(3, [stored(5).key], 'intended', T0);
    first.findings.setRuleState(3, 'rule:size:0001', '3'.padStart(40, '0'), 'intended', T0);
    first.changes.setApproval(4, { approvedHead: '4'.padStart(40, '0'), approvedAt: T0 });
    const before = { list: first.findings.list(3), rules: first.findings.ruleStates(3), approval: first.changes.approval(4) };
    first.close();

    const again = openDb(path);
    expect({ list: again.findings.list(3), rules: again.findings.ruleStates(3), approval: again.changes.approval(4) }).toEqual(before);
    expect(before.list.map((f) => [f.key, f.finding.state])).toEqual([
      [stored(5).key, 'intended'],
      [stored(6).key, 'open'],
    ]);
    expect(before.rules).toEqual({ 'rule:size:0001': 'intended' });
    // The version is per process: a reopened store starts again, so the served cache (also per process) cannot be stale.
    expect(again.findings.version(3)).toBe(0);
    again.close();
  });
});
