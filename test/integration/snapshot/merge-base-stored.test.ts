// The merge-base and the fingerprints travel from the worker's ComputedSnapshot
// into the snapshots table (ADR-027).

import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../../src/core/db/index.js';
import { computeSnapshot } from '../../../src/core/report/snapshot.js';
import type { Fingerprints } from '../../../src/core/model/types.js';
import { branchFields, tempDbPath, T0 } from '../../unit/db/db-helpers.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const repos: TempRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

describe('snapshot/merge-base-stored', () => {
  it('computeSnapshot -> put -> latest and latestFingerprints', async () => {
    const repo = await createRepo({ name: 'sample-shop', files: { 'src/a.ts': 'export const a = 1;\n' } });
    repos.push(repo);
    const mergeBase = await repo.head();
    await repo.branch('feature/a');
    const tip = await repo.commit('edit', { 'src/a.ts': 'export const a = 2;\n' });
    const computed = await computeSnapshot({ repoDir: repo.dir, base: 'main', head: tip, now: T0, trustConfig: false });
    expect(computed.mergeBase).toBe(mergeBase);

    const { path, remove } = tempDbPath();
    const db = openDb(path);
    try {
      const stored = db.repos.upsert({ path: repo.dir, gitCommonDir: `${repo.dir}/.git`, name: 'sample-shop', active: true, seenAt: T0 }).repo;
      const applied = db.changes.applyPlan(stored.id, { create: [branchFields('a', { head: tip })], update: [], archive: [] }, T0);
      const changeId = applied.created[0]?.id ?? -1;
      expect(db.snapshots.latestFingerprints(changeId)).toBeNull();
      db.snapshots.put({
        changeId,
        head: computed.headCommit,
        dirty: false,
        report: computed.reportJson,
        summary: computed.summary,
        touched: computed.touched,
        contentHash: computed.contentHash,
        computedAt: T0,
        mergeBase: computed.mergeBase,
        fingerprints: computed.fingerprintsJson,
      });
      expect(db.snapshots.latest(changeId)?.mergeBase).toBe(mergeBase);
      expect(db.snapshots.latest(changeId)?.fingerprints).toBe(computed.fingerprintsJson);
      expect(db.snapshots.latestFingerprints(changeId)).toBe(computed.fingerprintsJson);
      const parsed = JSON.parse(computed.fingerprintsJson) as Fingerprints;
      expect(Object.keys(parsed.files)).toEqual(['src/a.ts']);
    } finally {
      db.close();
      remove();
    }
  });
});
