// Collections of one repo that finish out of order (ADR-021): only the most
// recently started run records the repo's error and sends the final `collect`.
// A fake snapshot pool decides when each snapshot finishes.

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { identifyRepo } from '../../../src/core/changes/index.js';
import type { SseEvent } from '../../../src/core/model/types.js';
import type { ComputedSnapshot, SnapshotJobInput } from '../../../src/core/report/snapshot.js';
import { createCollector, type Collector } from '../../../src/daemon/collector/collector.js';
import type { SnapshotPool } from '../../../src/daemon/collector/snapshot-pool.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { tempDb, type TempDb } from '../../unit/db/db-helpers.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

let db: TempDb | null = null;
let collector: Collector | null = null;
afterEach(async () => {
  await collector?.close();
  db?.cleanup();
  collector = null;
  db = null;
});

interface HeldJob {
  input: SnapshotJobInput;
  resolve: (value: ComputedSnapshot) => void;
  reject: (error: Error) => void;
}

function heldPool(): { pool: SnapshotPool; jobs: HeldJob[] } {
  const jobs: HeldJob[] = [];
  const pool: SnapshotPool = {
    submit: (_key, _priority, input) =>
      new Promise<ComputedSnapshot>((resolve, reject) => {
        jobs.push({ input, resolve, reject });
      }),
    pending: 0,
    workers: 0,
    shutdown: () => Promise.resolve(),
  };
  return { pool, jobs };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('collector run order', () => {
  it('an older run finishing after a newer failed one does not clear the error or send `done`', async () => {
    const repo = await sampleRepo();
    await repo.write({ 'src/cart/line.ts': 'export const line = 1;\n' });
    const head = await repo.head();
    db = tempDb();
    const identity = await identifyRepo(repo.dir);
    const { repo: stored } = db.db.repos.upsert({ ...identity, active: true, seenAt: '2026-02-01T00:00:00.000Z' });
    const events: SseEvent[] = [];
    const { pool, jobs } = heldPool();
    collector = createCollector({
      db: db.db,
      snapshots: pool,
      broadcast: (event) => events.push(event),
      log: createStreamLogger(new PassThrough()),
      gh: ghNotInstalled(),
      isTrusted: () => Promise.resolve(false),
    });

    // Run 1 lists the Draft and waits on its snapshot.
    const first = collector.request(stored.id, 'full', 'high');
    await until(() => jobs.length === 1);
    // Run 2 starts (the sources slot is free) and its snapshot fails.
    const second = collector.request(stored.id, 'full', 'high');
    await until(() => jobs.length === 2);
    jobs[1]?.reject(new Error('parse exploded'));
    expect(await second).toEqual({ ok: false, error: expect.stringMatching(/parse exploded/) as string });
    expect(db.db.repos.get(stored.id)?.collectError).toMatch(/parse exploded/);

    // Run 1 now succeeds: its caller hears so, the repo state stays the newer run's.
    jobs[0]?.resolve({
      reportJson: '{}',
      summary: {
        files: 0,
        byStatus: { add: 0, mod: 0, sig: 0, del: 0, same: 0 },
        byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 },
        tier1Files: [],
        touchedFiles: 0,
      },
      touched: [],
      contentHash: 'hash-1',
      headCommit: head,
      mergeBase: head,
      fingerprintsJson: '{"files":{},"symbols":{}}',
    });
    expect(await first).toEqual({ ok: true });
    expect(db.db.repos.get(stored.id)?.collectError).toMatch(/parse exploded/);
    const finals = events.flatMap((event) => (event.event === 'collect' && event.data.state !== 'started' ? [event.data.state] : []));
    expect(finals).toEqual(['error']);
  });
});
