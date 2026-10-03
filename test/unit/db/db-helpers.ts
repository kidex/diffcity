// Temporary databases and sample rows for the db tests. Every database lives in
// its own directory under os.tmpdir(); nothing touches DIFFCITY_HOME or the
// real ~/.config/diffcity.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection } from '../../../src/core/db/driver.js';
import { openDb, type ChangeFields, type Db, type SnapshotInput } from '../../../src/core/db/index.js';
import type { RepoRecord, SnapshotSummary } from '../../../src/core/model/types.js';

export interface TempDb {
  db: Db;
  path: string;
  /** Closes the database (if still open) and removes its directory. */
  cleanup: () => void;
}

/** A fresh directory under os.tmpdir() with the path of a database file that does not exist yet. */
export function tempDbPath(): { path: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dc-db-'));
  return { path: join(dir, 'diffcity.db'), remove: () => { rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * A plain connection to a database file, outside the stores (no migrations,
 * no foreign_keys), for reading tables directly or writing rows that have no
 * store yet. busy_timeout defaults to 5000 ms, like the daemon's connection.
 */
export function rawConnection(path: string, options: { readOnly?: boolean; busyTimeoutMs?: number } = {}): Connection {
  const raw = new Connection(path, { readOnly: options.readOnly ?? false });
  raw.pragma(`busy_timeout = ${String(options.busyTimeoutMs ?? 5000)}`);
  return raw;
}

export function tempDb(): TempDb {
  const { path, remove } = tempDbPath();
  const db = openDb(path);
  return {
    db,
    path,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // Already closed by the test.
      }
      remove();
    },
  };
}

export const T0 = '2026-09-01T10:00:00.000Z';

/** `T0` plus `days` (fractions allowed), in the stored ISO form. */
export function daysAfter(base: string, days: number): string {
  return new Date(Date.parse(base) + days * 86_400_000).toISOString();
}

export function addRepo(db: Db, name = 'sample-shop', active = true): RepoRecord {
  return db.repos.upsert({
    path: `/work/${name}`,
    gitCommonDir: `/work/${name}/.git`,
    name,
    active,
    seenAt: T0,
  }).repo;
}

let shaCounter = 0;

/** A distinct 40-hex fake sha. */
export function sha(): string {
  shaCounter += 1;
  return shaCounter.toString(16).padStart(40, 'a');
}

export function branchFields(name: string, overrides: Partial<ChangeFields> = {}): ChangeFields {
  return {
    kind: 'branch',
    ref: `branch:${name}`,
    prNumber: null,
    head: sha(),
    headAvailable: true,
    dirty: false,
    worktreePath: null,
    base: 'main',
    title: `Add ${name}`,
    ahead: 2,
    behind: 0,
    reviewState: 'unreviewed',
    lastEventType: 'commit',
    lastEventAt: T0,
    ...overrides,
  };
}

export function sampleSummary(overrides: Partial<SnapshotSummary> = {}): SnapshotSummary {
  return {
    files: 4,
    byStatus: { add: 2, mod: 1, sig: 1, del: 0, same: 6 },
    byVerdict: { eyes: 1, risky: 0, spec: 0, ok: 1, same: 2 },
    tier1Files: ['src/auth/session.ts'],
    touchedFiles: 2,
    ...overrides,
  };
}

export function snapshotInput(changeId: number, head: string, overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    changeId,
    head,
    dirty: false,
    report: '{"meta":{"repo":"sample-shop"}}',
    summary: sampleSummary(),
    touched: ['src/auth/session.ts', 'src/orders/cart.ts'],
    contentHash: 'hash-1',
    computedAt: T0,
    mergeBase: 'c'.repeat(40),
    fingerprints: '{"files":{},"symbols":{}}',
    ...overrides,
  };
}
