// The rules key outlives the daemon (ADR-030, DC-121): each snapshot stores
// the key of the rules it was computed under, so a collector started on the
// same database recomputes only the changes whose stored key differs from the
// current one, even on an unchanged head, and a snapshot stored without a key
// (before schema v6) once. Each collector created on the same database stands
// for one daemon run; a stub snapshot pool counts the jobs.

import { afterEach, describe, expect, it } from 'vitest';
import { identifyRepo } from '../../../src/core/changes/index.js';
import type { ComputedSnapshot, SnapshotJobInput } from '../../../src/core/report/snapshot.js';
import type { UserRuleSettings } from '../../../src/core/settings/index.js';
import { createCollector, type Collector } from '../../../src/daemon/collector/collector.js';
import type { SnapshotPool } from '../../../src/daemon/collector/snapshot-pool.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { rawConnection, tempDb, type TempDb } from '../../unit/db/db-helpers.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

let db: TempDb | null = null;
afterEach(() => {
  db?.cleanup();
  db = null;
});

const SIZE_RULE: UserRuleSettings = { settings: [{ id: 'size', kind: 'file-size', maxLines: 5 }] };

/** Snapshot jobs the stub pool received, by head. */
function stubPool(jobs: string[]): SnapshotPool {
  return {
    submit: (_key: string, _priority: unknown, input: SnapshotJobInput): Promise<ComputedSnapshot> => {
      const head = input.head ?? '';
      jobs.push(head);
      return Promise.resolve({
        reportJson: '{}',
        summary: {
          files: 0,
          byStatus: { add: 0, mod: 0, sig: 0, del: 0, same: 0 },
          byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 },
          tier1Files: [],
          touchedFiles: 0,
        },
        touched: [],
        contentHash: `hash-${head}`,
        headCommit: head,
        mergeBase: head,
        fingerprintsJson: '{"files":{},"symbols":{}}',
      });
    },
    pending: 0,
    workers: 0,
    shutdown: () => Promise.resolve(),
  };
}

describe('collector rules key across restarts', () => {
  it('collect/rules-key-restart: a new run recomputes only the changes whose stored rules key differs, a keyless one once', async () => {
    const repo = await sampleRepo({ name: 'shopfront' });
    await repo.branch('agent/cart');
    await repo.commit('cart', { 'src/cart/line.ts': 'export const line = 1;\n' });
    const cartHead = await repo.head();
    await repo.checkout('main');
    await repo.branch('agent/tax');
    await repo.commit('tax', { 'src/cart/tax.ts': 'export const rate = 0.2;\n' });
    const taxHead = await repo.head();
    await repo.checkout('main');

    db = tempDb();
    const store = db.db;
    const identity = await identifyRepo(repo.dir);
    const { repo: stored } = store.repos.upsert({ ...identity, active: true, seenAt: '2026-02-01T00:00:00.000Z' });

    /** One daemon run: a fresh collector on the same database, one full collection, then closed. */
    const run = async (rules: UserRuleSettings): Promise<string[]> => {
      const jobs: string[] = [];
      const collector: Collector = createCollector({
        db: store,
        snapshots: stubPool(jobs),
        broadcast: () => undefined,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined, close: () => undefined },
        gh: ghNotInstalled(),
        isTrusted: () => Promise.resolve(false),
        ruleSettings: () => Promise.resolve(rules),
      });
      try {
        expect(await collector.request(stored.id, 'full', 'high')).toEqual({ ok: true });
      } finally {
        await collector.close();
      }
      return jobs.sort();
    };
    const both = [cartHead, taxHead].sort();

    expect(await run({})).toEqual(both);
    // Restart, nothing changed: nothing is computed again.
    expect(await run({})).toEqual([]);
    // Rules edited while stopped: both changes, same heads, are computed again; their Reports are identical here.
    expect(await run(SIZE_RULE)).toEqual(both);
    expect(await run(SIZE_RULE)).toEqual([]);

    // A snapshot stored before schema v6 has no key: computed again once, the other change is left alone.
    const raw = rawConnection(db.path);
    raw.prepare('UPDATE snapshots SET rulesKey = NULL WHERE head = ?').run(taxHead);
    raw.close();
    expect(await run(SIZE_RULE)).toEqual([taxHead]);
    expect(await run(SIZE_RULE)).toEqual([]);

    // The stored key is a hash: no rule text, no path.
    const keys = rawConnection(db.path, { readOnly: true });
    const rows = keys.prepare<[], { rulesKey: string | null }>('SELECT rulesKey FROM snapshots').all();
    keys.close();
    for (const row of rows) expect(row.rulesKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
