// The notes a snapshot worker returns (the call graph's fallback to name
// matching, ADR-034) reach daemon.log through the collector: a worker thread
// has no log of its own. A stub snapshot pool returns the notes.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { identifyRepo } from '../../../src/core/changes/index.js';
import type { ComputedSnapshot } from '../../../src/core/report/snapshot.js';
import { createCollector, type Collector } from '../../../src/daemon/collector/collector.js';
import type { SnapshotPool } from '../../../src/daemon/collector/snapshot-pool.js';
import { createFileLogger } from '../../../src/daemon/log.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { tempDb, type TempDb } from '../../unit/db/db-helpers.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

let db: TempDb | null = null;
let collector: Collector | null = null;
let home: string | null = null;
afterEach(async () => {
  await collector?.close();
  db?.cleanup();
  if (home !== null) rmSync(home, { recursive: true, force: true });
  collector = null;
  db = null;
  home = null;
});

const NOTE = 'call graph: 412 touched TS files exceed the ts-morph limit of 400; matching names for the whole change';

describe('collector snapshot notes', () => {
  it('collect/snapshot-notes-to-daemon-log: each note of a computed snapshot is one daemon.log line naming the change', async () => {
    const repo = await sampleRepo();
    await repo.write({ 'src/cart/line.ts': 'export const line = 1;\n' });
    const head = await repo.head();
    home = mkdtempSync(join(tmpdir(), 'diffcity-notes-'));
    const logPath = join(home, 'daemon.log');
    const log = createFileLogger(logPath);
    db = tempDb();
    const identity = await identifyRepo(repo.dir);
    const { repo: stored } = db.db.repos.upsert({ ...identity, active: true, seenAt: '2026-02-01T00:00:00.000Z' });
    const computed: ComputedSnapshot = {
      reportJson: '{}',
      summary: {
        files: 0,
        byStatus: { add: 0, mod: 0, sig: 0, del: 0, same: 0 },
        byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 },
        tier1Files: [],
        touchedFiles: 0,
      },
      touched: [],
      contentHash: 'hash-notes',
      headCommit: head,
      mergeBase: head,
      fingerprintsJson: '{"files":{},"symbols":{}}',
      notes: [NOTE],
    };
    const pool: SnapshotPool = {
      submit: () => Promise.resolve(computed),
      pending: 0,
      workers: 0,
      shutdown: () => Promise.resolve(),
    };
    collector = createCollector({
      db: db.db,
      snapshots: pool,
      broadcast: () => undefined,
      log,
      gh: ghNotInstalled(),
      isTrusted: () => Promise.resolve(false),
    });

    expect(await collector.request(stored.id, 'full', 'high')).toEqual({ ok: true });
    const change = db.db.changes.listLive(stored.id).find((c) => c.kind === 'draft');
    expect(change).toBeDefined();
    log.close();
    const lines = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.includes(NOTE));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ info snapshot of .+: call graph: 412 touched TS files/);
    expect(lines[0]).toContain(`snapshot of ${change?.ref ?? ''}: ${NOTE}`);
  });
});
