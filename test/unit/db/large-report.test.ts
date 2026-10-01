// A Report of several MB (ADR-011 keeps untouched files, ADR-018) is stored and
// read back byte for byte, and summaries never touch it.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import type { ChangeRecord } from '../../../src/core/model/types.js';
import { T0, addRepo, branchFields, daysAfter, snapshotInput, tempDb, type TempDb } from './db-helpers.js';

let temp: TempDb;
let db: Db;
let change: ChangeRecord;

beforeEach(() => {
  temp = tempDb();
  db = temp.db;
  const repo = addRepo(db);
  const [created] = db.changes.applyPlan(repo.id, { create: [branchFields('bulk-import')], update: [], archive: [] }, T0)
    .created;
  if (created === undefined) throw new Error('not created');
  change = created;
});
afterEach(() => {
  temp.cleanup();
});

/**
 * A Report-shaped JSON text of at least `bytes` UTF-8 bytes, with the things a
 * naive re-serialization would alter: non-ASCII text, escapes, key order,
 * insignificant whitespace and number spellings.
 */
function bigReport(bytes: number): string {
  const files: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i += 1) {
    const file =
      `{"path": "src/catalog/mödule-${String(i)}.ts","status":"same", "verdict":"ok",` +
      `"note":"tab\\tquote\\"newline\\n emoji \u{1F3D9} \\u00e9","weight":1.50,"z":1,"a":2}`;
    files.push(file);
    size += Buffer.byteLength(file, 'utf8') + 1;
  }
  return `{"meta": {"repo":"bulk-shop", "generatedAt":"${T0}"},\n  "files":[${files.join(',')}]}`;
}

describe('large reports', () => {
  it('a report of several MB is stored and read back verbatim', () => {
    const report = bigReport(8 * 1024 * 1024);
    expect(Buffer.byteLength(report, 'utf8')).toBeGreaterThan(8 * 1024 * 1024);

    expect(db.snapshots.put(snapshotInput(change.id, change.head, { report, contentHash: 'big-1' }))).toBe('created');

    expect(db.snapshots.latestReport(change.id) === report).toBe(true);
    expect(db.snapshots.latest(change.id)?.report === report).toBe(true);

    // Byte for byte on disk, through a separate connection after the writer closed.
    db.close();
    const raw = new Database(temp.path, { readonly: true });
    try {
      const row = raw
        .prepare<[number], { report: string; bytes: number }>(
          'SELECT report, length(CAST(report AS BLOB)) AS bytes FROM snapshots WHERE changeId = ?',
        )
        .get(change.id);
      expect(row?.bytes).toBe(Buffer.byteLength(report, 'utf8'));
      expect(row?.report === report).toBe(true);
    } finally {
      raw.close();
    }
  });

  it('replacing a large report on the same head keeps exactly the new text', () => {
    const first = bigReport(4 * 1024 * 1024);
    const second = bigReport(5 * 1024 * 1024).replace('bulk-shop', 'bulk-shop-2');
    db.snapshots.put(snapshotInput(change.id, change.head, { report: first, contentHash: 'big-1' }));
    expect(
      db.snapshots.put(snapshotInput(change.id, change.head, { report: second, contentHash: 'big-2', computedAt: daysAfter(T0, 1) })),
    ).toBe('replaced');
    expect(db.snapshots.latestReport(change.id) === second).toBe(true);
  });

  it('summaries come from the summary column, not the large report', () => {
    const report = bigReport(4 * 1024 * 1024);
    db.snapshots.put(snapshotInput(change.id, change.head, { report, contentHash: 'big-1' }));

    // Break the stored report behind the store's back: summaries must still build.
    const raw = new Database(temp.path);
    raw.prepare("UPDATE snapshots SET report = 'not json at all' WHERE changeId = ?").run(change.id);
    raw.close();

    const summary = db.changes.getSummary(change.id);
    expect(summary?.stats).toEqual({
      touchedFiles: 2,
      symbolsByStatus: { add: 2, mod: 1, sig: 1, del: 0, same: 6 },
      filesByVerdict: { eyes: 1, risky: 0, spec: 0, ok: 1, same: 2 },
      tier1Files: ['src/auth/session.ts'],
    });
    expect(db.changes.listLiveSummaries(change.repoId)).toHaveLength(1);
    expect(db.repos.listSummaries()[0]?.counts).toEqual({ draft: 0, branch: 1, pr: 0 });
  });
});
