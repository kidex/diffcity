// Review marks across collections (ADR-028): a new snapshot that changes a
// marked file flags the mark outdated in the collector's transaction, leaves
// the others current, and signals SSE `review` after `snapshot`.

import { describe, expect, it } from 'vitest';
import type { ReviewMark } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const TOTAL_V1 = 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n';
const TOTAL_V2 = 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 1);\n}\n';

/** A feature branch that changes total.ts and adds tax.ts, collected once. */
async function collected() {
  const repo = await sampleRepo();
  await repo.branch('feature/totals');
  await repo.commit('sum the cart', { 'src/cart/total.ts': TOTAL_V1 });
  await repo.commit('add tax', { 'src/cart/tax.ts': 'export const rate = 0.2;\n' });
  await repo.checkout('main');
  const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
  const response = await test.track(repo.dir);
  if (!response.ok) throw new Error(response.error);
  await test.idle();
  const db = test.collection.db();
  const change = db.changes.listLive(response.repo.id).find((c) => c.ref === 'branch:feature/totals');
  if (change === undefined) throw new Error('feature change not collected');
  const snapshot = db.snapshots.latest(change.id);
  if (snapshot === null) throw new Error('no snapshot');
  const report = JSON.parse(snapshot.report) as Report;
  const fileId = (path: string): string => {
    const found = report.packages.flatMap((p) => p.files).find((f) => f.path === path);
    if (found === undefined) throw new Error(`${path} not in the report`);
    return found.id;
  };
  return { repo, test, db, change, snapshot, repoId: response.repo.id, fileId, port: test.daemon.info.port };
}

describe('collect/new-snapshot-outdates-marks', () => {
  it('a commit that changes a marked file outdates its mark; the mark on an untouched-since file stays current', async () => {
    const { repo, test, db, change, snapshot, fileId, port } = await collected();
    const mark = (id: string, snapshotId: number) =>
      call(port, 'PUT', `/api/changes/${String(change.id)}/review/marks`, { body: { snapshotId, target: { kind: 'file', id }, mark: 'checked' } });
    expect((await mark(fileId('src/cart/total.ts'), snapshot.id)).status).toBe(200);
    expect((await mark(fileId('src/cart/tax.ts'), snapshot.id)).status).toBe(200);
    expect(db.review.list(change.id).map((m) => m.state)).toEqual(['current', 'current']);

    await repo.checkout('feature/totals');
    await repo.commit('start from one', { 'src/cart/total.ts': TOTAL_V2 });
    await repo.checkout('main');
    const again = await test.track(repo.dir);
    if (!again.ok) throw new Error(again.error);
    await test.idle();

    const latest = db.snapshots.latest(change.id);
    expect(latest?.id).not.toBe(snapshot.id);
    const marks = (await call(port, 'GET', `/api/changes/${String(change.id)}/review`)).json() as { marks: ReviewMark[]; progress: { outdated: number } };
    expect(marks.marks.map((m) => [m.filePath, m.state])).toEqual([
      ['src/cart/total.ts', 'outdated'],
      ['src/cart/tax.ts', 'current'],
    ]);
    expect(marks.marks[0]?.outdatedAt).not.toBeNull();
    expect(marks.progress.outdated).toBe(1);

    // A recollect with nothing new stores nothing (`unchanged`) and flags nothing.
    const stable = db.review.list(change.id).map((m) => m.updatedAt);
    const third = await test.track(repo.dir);
    if (!third.ok) throw new Error(third.error);
    await test.idle();
    expect(db.review.list(change.id).map((m) => m.updatedAt)).toEqual(stable);
  });
});

describe('sse/review-after-snapshot', () => {
  it('a stored snapshot is followed by a review signal for the same change', async () => {
    const { repo, test, change, repoId } = await collected();
    const names = () => test.events().filter((e) => e.event === 'snapshot' || e.event === 'review');
    await waitFor(() => names().some((e) => e.event === 'review'), 5000, 'the review signal');
    const first = names();
    expect(first.map((e) => e.event)).toEqual(['snapshot', 'review']);
    expect(first[1]?.data).toEqual({ repoId, changeId: change.id });

    await repo.checkout('feature/totals');
    await repo.commit('start from one', { 'src/cart/total.ts': TOTAL_V2 });
    await repo.checkout('main');
    const again = await test.track(repo.dir);
    if (!again.ok) throw new Error(again.error);
    await test.idle();
    await waitFor(() => names().length >= 4, 5000, 'the second review signal');
    expect(names().map((e) => e.event)).toEqual(['snapshot', 'review', 'snapshot', 'review']);

    // An unchanged recollect sends neither.
    const third = await test.track(repo.dir);
    if (!third.ok) throw new Error(third.error);
    await test.idle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(names()).toHaveLength(4);
  });
});
