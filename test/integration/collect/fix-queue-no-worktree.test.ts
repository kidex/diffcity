// fix-queue/no-working-tree-refused on a collected branch (ADR-036): a branch
// collected while another branch is checked out has no working tree at its
// head, so "Ask agent to fix" is refused with 409 `no-working-tree` and nothing
// is written into the repo's checkout (which holds another commit).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anchor } from '../../../src/core/findings/index.js';
import type { ApiError } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { storeFindingsImport } from '../../../src/daemon/findings.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

describe('fix-queue/no-working-tree-refused', () => {
  it('a branch collected while main is checked out cannot queue a fix, and nothing is written', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/totals');
    await repo.commit('sum the cart', { 'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n' });
    await repo.checkout('main');
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const tracked = await test.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    await test.idle();
    const db = test.collection.db();
    const change = db.changes.listLive(tracked.repo.id).find((c) => c.ref === 'branch:feature/totals');
    if (change === undefined) throw new Error('feature change not collected');
    expect(change.worktreePath).toBeNull();
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null) throw new Error('no snapshot');

    const anchored = anchor(
      {
        source: 'claude',
        severity: 'high',
        category: 'correctness',
        file: 'src/cart/total.ts',
        line: 2,
        title: 'Total starts from zero',
        message: 'An invented finding.',
      },
      JSON.parse(snapshot.report) as Report,
    );
    if (!anchored.ok) throw new Error('not anchored');
    storeFindingsImport({ db, broadcast: () => undefined }, tracked.repo.id, {
      changeId: change.id,
      head: snapshot.head,
      findings: [anchored.stored],
      fixed: [],
      at: new Date().toISOString(),
    });

    const answer = await call(test.daemon.info.port, 'POST', `/api/changes/${String(change.id)}/findings/${anchored.stored.key}/fix`);
    expect([answer.status, (answer.json() as ApiError).error.code]).toEqual([409, 'no-working-tree']);
    expect(existsSync(join(repo.dir, '.diffcity'))).toBe(false);
  });
});
