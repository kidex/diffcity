// Restarts and the review state (ADR-030, DC-121): a restart whose rules key
// differs from the stored one computes the snapshot again on the same head.
// When that gives another Report the approval goes, while a mark on content
// that did not change stays current; when it gives the same Report (a row
// stored before schema v6, recomputed once) the approval and marks stay and
// no collect event is written. A rule list set to null while the daemon is
// stopped shows its config error check on the first collection. Temp
// DIFFCITY_HOME, invented `orchard` repo.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeRecord } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import { rawConnection } from '../../unit/db/db-helpers.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon, type TestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const BRANCH = 'agent/pick';
const FILE = 'src/harvest/pick.ts';
const SIZE_RULE = { id: 'size', kind: 'file-size', maxLines: 5 };

function body(count: number): string {
  return ['export function pick(rows: number[]): number {', ...Array.from({ length: count }, (_, i) => `  rows.push(${String(i)});`), '  return rows.length;', '}', ''].join('\n');
}

function settingsOf(home: TempHome): (rules: unknown) => Promise<void> {
  return (rules) => writeFile(join(home.home, 'settings.json'), JSON.stringify({ v: 1, trustedRepos: [], rules }));
}

function branchChange(test: TestDaemon, repoId: number): ChangeRecord {
  const change = test.collection.db().changes.listLive(repoId).find((candidate) => candidate.ref.endsWith(BRANCH));
  if (change === undefined) throw new Error('the branch change was not collected');
  return change;
}

function checks(test: TestDaemon, changeId: number): string[] {
  const json = test.collection.db().snapshots.latestReport(changeId);
  if (json === null) return [];
  return ((JSON.parse(json) as Report).checks ?? []).map((check) => `${check.ruleId}:${check.state}`);
}

function countCollect(test: TestDaemon, changeId: number): number {
  const raw = rawConnection(join(test.home.home, 'diffcity.db'), { readOnly: true });
  try {
    return raw.prepare<[number], { n: number }>("SELECT count(*) AS n FROM events WHERE type = 'collect' AND changeId = ?").get(changeId)?.n ?? 0;
  } finally {
    raw.close();
  }
}

/** Tracks a fresh repo, marks its file Checked and approves the branch change through the API. */
async function approvedChange(rules: unknown): Promise<{ home: TempHome; repoId: number; change: ChangeRecord; first: TestDaemon }> {
  const home = await tempHome();
  const repo = await sampleRepo({ name: 'orchard', files: { [FILE]: body(1), 'README.md': '# orchard\n' } });
  await repo.branch(BRANCH);
  await repo.commit('longer pick', { [FILE]: body(10) });
  const first = await startTestDaemon({ gh: ghNotInstalled() }, { api: true, home });
  await settingsOf(home)(rules);
  const tracked = await first.track(repo.dir);
  if (!tracked.ok) throw new Error(tracked.error);
  await first.idle();
  const repoId = tracked.repo.id;
  const change = branchChange(first, repoId);
  const snapshot = first.collection.db().snapshots.latest(change.id);
  if (snapshot === null) throw new Error('no snapshot');
  const fileId = (JSON.parse(snapshot.report) as Report).packages.flatMap((pkg) => pkg.files).find((file) => file.path === FILE)?.id;
  if (fileId === undefined) throw new Error(`${FILE} not in the report`);
  const port = first.daemon.info.port;
  const marked = await call(port, 'PUT', `/api/changes/${String(change.id)}/review/marks`, {
    body: { snapshotId: snapshot.id, target: { kind: 'file', id: fileId }, mark: 'checked' },
  });
  expect(marked.status).toBe(200);
  const approved = await call(port, 'POST', `/api/changes/${String(change.id)}/approve`);
  expect(approved.status).toBe(200);
  expect(branchChange(first, repoId).reviewState).toBe('approved');
  return { home, repoId, change, first };
}

describe('restart with other rules and the review state', () => {
  it('rules/restart-report-changed: a new check on the same head drops the approval, the mark stays current', async () => {
    const { home, repoId, change, first } = await approvedChange([]);
    await first.stop();

    await settingsOf(home)([SIZE_RULE]);
    const second = await startTestDaemon({ gh: ghNotInstalled() }, { api: true, home });
    await waitFor(() => checks(second, change.id).length > 0, 30_000, 'the snapshot computed under the new rules');
    await second.idle();
    expect(checks(second, change.id)).toEqual(['size:violations']);
    const after = branchChange(second, repoId);
    expect(after.head).toBe(change.head);
    expect(after.reviewState).not.toBe('approved');
    expect(second.collection.db().review.list(change.id).map((mark) => [mark.filePath, mark.state])).toEqual([[FILE, 'current']]);
  });

  it('rules/restart-keyless-same-report: a row without a key is computed once; the same Report keeps approval, marks and events', async () => {
    const { home, repoId, change, first } = await approvedChange([]);
    const keyBefore = first.collection.db().snapshots.latestComputed(change.id)?.rulesKey ?? null;
    expect(keyBefore).toMatch(/^[0-9a-f]{64}$/);
    const eventsBefore = countCollect(first, change.id);
    await first.stop();

    // As a row written before schema v6.
    const raw = rawConnection(join(home.home, 'diffcity.db'));
    raw.prepare('UPDATE snapshots SET rulesKey = NULL').run();
    const reportBefore = raw.prepare<[number], { report: string; id: number }>('SELECT id, report FROM snapshots WHERE changeId = ?').get(change.id);
    raw.close();

    const second = await startTestDaemon({ gh: ghNotInstalled() }, { api: true, home });
    await waitFor(() => second.collection.db().snapshots.latestComputed(change.id)?.rulesKey === keyBefore, 30_000, 'the keyless snapshot computed again');
    await second.idle();
    const db = second.collection.db();
    expect(db.snapshots.latest(change.id)?.id).toBe(reportBefore?.id);
    expect(db.snapshots.latestReport(change.id)).toBe(reportBefore?.report);
    expect(branchChange(second, repoId).reviewState).toBe('approved');
    expect(db.changes.approval(change.id)?.approvedHead).toBe(change.head);
    expect(db.review.list(change.id).map((mark) => [mark.filePath, mark.state])).toEqual([[FILE, 'current']]);
    expect(countCollect(second, change.id)).toBe(eventsBefore);
  });

  it('rules/restart-null-list: rules set to null while stopped give the config error check on the first collection', async () => {
    const { home, change, first } = await approvedChange([]);
    await first.stop();

    await settingsOf(home)(null);
    const second = await startTestDaemon({ gh: ghNotInstalled() }, { api: true, home });
    await waitFor(() => checks(second, change.id).length > 0, 30_000, 'the config error check');
    await second.idle();
    expect(checks(second, change.id)).toEqual(['settings:rules:error']);
  });
});
