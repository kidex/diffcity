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

/** A draft with a marked file, then a same-length edit that leaves the Report as it was (DC-74). */
async function refreshedEdit() {
  const repo = await sampleRepo();
  // Step.diff carries the lines of every changed symbol (ADR-034): the edit that leaves the
  // Report as it was is a note line outside the symbol.
  const body = (n: number): string => `// pass ${String(n)}\nexport function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n`;
  await repo.write({ 'src/cart/total.ts': body(0) });
  const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
  const tracked = await test.track(repo.dir);
  if (!tracked.ok) throw new Error(tracked.error);
  await test.idle();
  const db = test.collection.db();
  const change = db.changes.listLive(tracked.repo.id).find((c) => c.kind === 'draft');
  if (change === undefined) throw new Error('draft not collected');
  const first = db.snapshots.latest(change.id);
  if (first === null) throw new Error('no snapshot');
  const file = (JSON.parse(first.report) as Report).packages.flatMap((p) => p.files).find((f) => f.path === 'src/cart/total.ts');
  if (file === undefined) throw new Error('total.ts missing');
  const marked = await call(test.daemon.info.port, 'PUT', `/api/changes/${String(change.id)}/review/marks`, {
    body: { snapshotId: first.id, target: { kind: 'file', id: file.id }, mark: 'checked' },
  });
  expect(marked.status).toBe(200);
  db.changes.applyPlan(tracked.repo.id, { create: [], update: [{ id: change.id, reviewState: 'approved' }], archive: [] }, new Date().toISOString());
  const collects = (): number => db.events.listForRepo(tracked.repo.id).filter((e) => e.type === 'collect' && e.changeId === change.id).length;
  // The mark's own SSE signals arrive first; count from after them.
  await waitFor(() => test.events().some((e) => e.event === 'review'), 5000, 'the review signal of the mark');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = { collects: collects(), signals: test.events().length };

  await repo.write({ 'src/cart/total.ts': body(1) });
  const again = await test.track(repo.dir);
  if (!again.ok) throw new Error(again.error);
  await waitFor(() => db.review.list(change.id)[0]?.state === 'outdated', 15_000, 'the mark to turn outdated');
  await test.idle();
  return { test, db, change, first, repoId: tracked.repo.id, collects, before };
}

describe('collect/refreshed-outdates-checked-mark', () => {
  it('bytes changing under an identical Report: the mark is outdated, the snapshot row is the same row, approved resets, no collect event row', async () => {
    const { db, change, first, collects, before } = await refreshedEdit();
    const after = db.snapshots.latest(change.id);
    expect(after).toMatchObject({ id: first.id, contentHash: first.contentHash, report: first.report });
    expect(after?.fingerprints).not.toBe(first.fingerprints);
    expect(collects()).toBe(before.collects);
    expect(db.changes.get(change.id)?.reviewState).toBe('unreviewed');
    expect(db.review.list(change.id)[0]).toMatchObject({ state: 'outdated' });
  });
});

describe('sse/refreshed-emits-review-not-snapshot', () => {
  it('a refreshed put sends review for the change and no snapshot', async () => {
    const { test, change, repoId, before } = await refreshedEdit();
    const signals = test.events().slice(before.signals).filter((e) => e.event === 'snapshot' || e.event === 'review');
    expect(signals.map((e) => e.event)).toEqual(['review']);
    expect(signals[0]?.data).toEqual({ repoId, changeId: change.id });
  });
});

