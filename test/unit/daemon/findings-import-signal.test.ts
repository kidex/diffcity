// storeFindingsImport signals `findings` (the change's Report moved),
// `changes` (its listed counts moved) and `repo` (the repo's highFindings
// moved, so Fleet reloads; DC-106), like the findings state route.

import { afterEach, describe, expect, it } from 'vitest';
import type { SseEvent } from '../../../src/core/model/types.js';
import { storeFindingsImport } from '../../../src/daemon/findings.js';
import { addRepo, branchFields, snapshotInput, T0, tempDb, type TempDb } from '../db/db-helpers.js';

let temp: TempDb | null = null;
afterEach(() => {
  temp?.cleanup();
  temp = null;
});

describe('storeFindingsImport signals', () => {
  it('an import sends `findings` for the change, then `changes` and `repo` for its repo', () => {
    temp = tempDb();
    const { db } = temp;
    const repo = addRepo(db, 'corner-till');
    const change = db.changes.applyPlan(repo.id, { create: [branchFields('till')], update: [], archive: [] }, T0).created[0];
    if (change === undefined) throw new Error('no change');
    db.snapshots.put(snapshotInput(change.id, change.head));
    const sent: SseEvent[] = [];
    storeFindingsImport({ db, broadcast: (event) => sent.push(event) }, repo.id, { changeId: change.id, head: change.head, findings: [], fixed: [], at: T0 });
    expect(sent).toEqual([
      { event: 'findings', data: { repoId: repo.id, changeId: change.id } },
      { event: 'changes', data: { repoId: repo.id } },
      { event: 'repo', data: { repoId: repo.id } },
    ]);
  });
});
