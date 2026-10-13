// Rules edited while the daemon is stopped (ADR-030, DC-121): the snapshots
// keep the key of the rules they were computed under, so the collection a
// daemon runs on start computes again, on the same head, the snapshot of a
// change whose rules changed. A review mark on content that did not change
// stays current. Temp DIFFCITY_HOME, invented `shopfront` repo.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeRecord } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { tempHome } from '../../helpers/config.js';
import { waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon, type TestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const BRANCH = 'agent/cart';
const TOTAL = 'src/cart/total.ts';
const SIZE_RULE = { id: 'size', kind: 'file-size', maxLines: 5 };

function body(count: number): string {
  return ['export function total(items: number[]): number {', ...Array.from({ length: count }, (_, i) => `  items.push(${String(i)});`), '  return items.length;', '}', ''].join('\n');
}

function branchChange(test: TestDaemon, repoId: number): ChangeRecord {
  const change = test.collection.db().changes.listLive(repoId).find((candidate) => candidate.ref.endsWith(BRANCH));
  if (change === undefined) throw new Error('the branch change was not collected');
  return change;
}

function checks(test: TestDaemon, changeId: number): string[] {
  const json = test.collection.db().snapshots.latestReport(changeId);
  if (json === null) return [];
  return ((JSON.parse(json) as Report).checks ?? []).map((check) => `${check.ruleId}:${check.state}:${String(check.findings)}`);
}

describe('rules edited while the daemon is stopped', () => {
  it('rules/restart-recompute: the collection on start shows the new check on the same head, and a mark stays current', async () => {
    const home = await tempHome();
    const settings = (rules: unknown[]): Promise<void> =>
      writeFile(join(home.home, 'settings.json'), JSON.stringify({ v: 1, trustedRepos: [], rules }));
    const repo = await sampleRepo({ name: 'shopfront', files: { [TOTAL]: body(1), 'README.md': '# shopfront\n' } });
    await repo.branch(BRANCH);
    await repo.commit('longer total', { [TOTAL]: body(10) });

    const first = await startTestDaemon({ gh: ghNotInstalled() }, { api: true, home });
    await settings([]);
    const tracked = await first.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    await first.idle();
    const repoId = tracked.repo.id;
    const change = branchChange(first, repoId);
    expect(checks(first, change.id)).toEqual([]);

    // A mark on the file, bound to this snapshot's content.
    const snapshot = first.collection.db().snapshots.latest(change.id);
    if (snapshot === null) throw new Error('no snapshot');
    const fileId = (JSON.parse(snapshot.report) as Report).packages.flatMap((pkg) => pkg.files).find((file) => file.path === TOTAL)?.id;
    if (fileId === undefined) throw new Error(`${TOTAL} not in the report`);
    const marked = await call(first.daemon.info.port, 'PUT', `/api/changes/${String(change.id)}/review/marks`, {
      body: { snapshotId: snapshot.id, target: { kind: 'file', id: fileId }, mark: 'checked' },
    });
    expect(marked.status).toBe(200);
    await first.stop();

    // settings.json gains a rule while no daemon runs.
    await settings([SIZE_RULE]);
    const second = await startTestDaemon({ gh: ghNotInstalled() }, { api: true, home });
    // No track: the collection the daemon runs on start is the first one.
    await waitFor(() => checks(second, change.id).length > 0, 30_000, 'the snapshot computed under the new rules');
    await second.idle();
    expect(checks(second, change.id)).toEqual(['size:violations:1']);
    const db = second.collection.db();
    expect(branchChange(second, repoId).head).toBe(change.head);
    expect(db.snapshots.latestComputed(change.id)?.head).toBe(change.head);
    expect(db.review.list(change.id).map((mark) => [mark.filePath, mark.state])).toEqual([[TOTAL, 'current']]);
  });
});
