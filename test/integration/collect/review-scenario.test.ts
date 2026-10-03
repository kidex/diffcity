// One review session end to end on a real in-process daemon and a real git
// repository (ADR-028): mark, edit the working tree, watch the mark go
// outdated and the progress drop, leave a rewrite note, read it in the
// summary, delete it, and fail a cross-site write.

import { describe, expect, it } from 'vitest';
import type { ReviewMark, ReviewProgress } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const TOTAL_EDIT_1 = 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n';
// One more line: the Report changes, so the draft stores a new snapshot.
const TOTAL_EDIT_2 = 'export function total(items: number[]): number {\n  const sum = items.reduce((a, b) => a + b, 0);\n  return sum;\n}\n';
const TAX = 'export function tax(amount: number): number {\n  return amount * 0.2;\n}\n';

interface ReviewBody {
  snapshotId: number;
  marks: ReviewMark[];
  progress: ReviewProgress;
}

describe('review session on a working-tree change', () => {
  it('mark -> progress -> edit -> outdated -> rewrite note -> summary -> delete, and a cross-site write changes nothing', async () => {
    const repo = await sampleRepo();
    await repo.write({ 'src/cart/total.ts': TOTAL_EDIT_1, 'src/cart/tax.ts': TAX });
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const tracked = await test.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    await test.idle();

    const db = test.collection.db();
    const port = test.daemon.info.port;
    const change = db.changes.listLive(tracked.repo.id).find((c) => c.kind === 'draft');
    if (change === undefined) throw new Error('draft not collected');
    const path = (rest = ''): string => `/api/changes/${String(change.id)}/review${rest}`;
    const read = async (): Promise<ReviewBody> => (await call(port, 'GET', path())).json() as ReviewBody;
    const report = (): Report => {
      const snapshot = db.snapshots.latest(change.id);
      if (snapshot === null) throw new Error('no snapshot');
      return JSON.parse(snapshot.report) as Report;
    };
    const fileOf = (name: string) => {
      const found = report().packages.flatMap((p) => p.files).find((f) => f.path === name);
      if (found === undefined) throw new Error(`${name} not in the report`);
      return found;
    };
    const put = (snapshotId: number, body: object) => call(port, 'PUT', path('/marks'), { body: { snapshotId, ...body } });

    // 1. A `checked` file mark counts in the progress.
    const before = await read();
    expect(before.marks).toEqual([]);
    expect(before.progress.touched.done).toBe(0);
    const total = before.progress.touched.total;
    expect(total).toBe(2);
    const checked = await put(before.snapshotId, { target: { kind: 'file', id: fileOf('src/cart/total.ts').id }, mark: 'checked' });
    expect(checked.status).toBe(200);
    expect((await read()).progress.touched).toEqual({ done: 1, total });
    expect((await read()).progress.outdated).toBe(0);

    // 2. An edit in the working tree, then a collect: the mark is outdated, the progress drops.
    await repo.write({ 'src/cart/total.ts': TOTAL_EDIT_2 });
    const again = await test.track(repo.dir);
    if (!again.ok) throw new Error(again.error);
    const firstHash = db.snapshots.latest(change.id)?.contentHash;
    await waitFor(() => db.snapshots.latest(change.id)?.contentHash !== firstHash, 20_000, 'the snapshot of the edited tree');
    await test.idle();
    const outdated = await read();
    // A draft's snapshot is replaced in place, so the id may stay.
    expect(outdated.marks.map((m) => [m.filePath, m.mark, m.state])).toEqual([['src/cart/total.ts', 'checked', 'outdated']]);
    expect(outdated.progress.touched).toEqual({ done: 0, total });
    expect(outdated.progress.outdated).toBe(1);

    // 3. A rewrite mark on a symbol with a note and lines shows in the summary under its file.
    const totalFile = fileOf('src/cart/total.ts');
    const symbol = totalFile.symbols.find((s) => s.name === 'total');
    if (symbol === undefined) throw new Error('symbol total missing');
    const rewrite = await put(outdated.snapshotId, {
      target: { kind: 'symbol', id: symbol.id },
      mark: 'rewrite',
      note: 'Start the sum from zero.',
      lines: { side: 'new', start: 2, end: 2 },
    });
    expect(rewrite.status).toBe(200);
    const summary = await call(port, 'GET', path('/summary'));
    expect(summary.status).toBe(200);
    expect(summary.text).toContain('## Needs rewrite (1)');
    expect(summary.text).toContain('### src/cart/total.ts\n- `total`, lines 2–2: Start the sum from zero.\n');
    expect(summary.text).not.toContain('src/cart/tax.ts');

    // 4. A cross-site write is refused and changes nothing.
    const snapshotNow = (await read()).snapshotId;
    const marksNow = JSON.stringify((await read()).marks);
    const foreign = await call(port, 'PUT', path('/marks'), {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: { snapshotId: snapshotNow, target: { kind: 'file', id: fileOf('src/cart/tax.ts').id }, mark: 'good' },
    });
    expect(foreign.status).toBe(403);
    expect(JSON.stringify((await read()).marks)).toBe(marksNow);
    const foreignDelete = await call(port, 'DELETE', `${path('/marks')}?kind=symbol&id=${encodeURIComponent(symbol.id)}`, {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(foreignDelete.status).toBe(403);
    expect(JSON.stringify((await read()).marks)).toBe(marksNow);

    // 5. A same-site DELETE removes the rewrite mark and the summary forgets it.
    const del = await call(port, 'DELETE', `${path('/marks')}?kind=symbol&id=${encodeURIComponent(symbol.id)}`);
    expect(del.status).toBe(204);
    expect((await read()).marks.map((m) => m.mark)).toEqual(['checked']);
    const empty = await call(port, 'GET', path('/summary'));
    expect(empty.text).toContain('## Needs rewrite (0)');
    expect(empty.text).not.toContain('Start the sum from zero.');
  });
});

describe('review session: an edit that leaves the Report as it was', () => {
  // The snapshot's content hash covers the Report only: bytes can change under an
  // identical Report. The put is then `refreshed` (DC-74): the marks are reconciled
  // in the same transaction, an approved change goes back to unreviewed, and a later
  // revert (A-B-A) does not bring the marks back.
  it('a literal edit with an identical Report outdates the symbol and file marks, resets approved, and stays outdated after a revert', async () => {
    const repo = await sampleRepo();
    await repo.write({ 'src/cart/total.ts': TOTAL_EDIT_1 });
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const tracked = await test.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    await test.idle();
    const db = test.collection.db();
    const port = test.daemon.info.port;
    const change = db.changes.listLive(tracked.repo.id).find((c) => c.kind === 'draft');
    if (change === undefined) throw new Error('draft not collected');
    const reviewPath = `/api/changes/${String(change.id)}/review`;
    const read = async (): Promise<{ snapshotId: number; marks: ReviewMark[]; progress: ReviewProgress }> =>
      (await call(port, 'GET', reviewPath)).json() as { snapshotId: number; marks: ReviewMark[]; progress: ReviewProgress };
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null) throw new Error('no snapshot');
    const report = JSON.parse(snapshot.report) as Report;
    const file = report.packages.flatMap((p) => p.files).find((f) => f.path === 'src/cart/total.ts');
    if (file === undefined) throw new Error('total.ts not in the report');
    const symbol = file.symbols.find((s) => s.name === 'total');
    if (symbol === undefined) throw new Error('symbol total missing');
    const mark = async (target: { kind: 'file' | 'symbol'; id: string }): Promise<void> => {
      const res = await call(port, 'PUT', `${reviewPath}/marks`, { body: { snapshotId: snapshot.id, target, mark: 'checked' } });
      expect(res.status).toBe(200);
    };
    await mark({ kind: 'symbol', id: symbol.id });
    await mark({ kind: 'file', id: file.id });
    const marked = await read();
    expect(marked.marks.map((m) => m.state)).toEqual(['current', 'current']);
    expect(marked.progress.touched.done).toBeGreaterThan(0);
    const doneBefore = marked.progress.touched.done;
    const outdatedBefore = marked.progress.outdated;
    db.changes.applyPlan(tracked.repo.id, { create: [], update: [{ id: change.id, reviewState: 'approved' }], archive: [] }, new Date().toISOString());
    expect(db.changes.get(change.id)?.reviewState).toBe('approved');

    const collectAfter = async (content: string): Promise<void> => {
      const before = db.snapshots.latest(change.id);
      await repo.write({ 'src/cart/total.ts': content });
      const again = await test.track(repo.dir);
      if (!again.ok) throw new Error(again.error);
      // The Report hash stays equal, so wait on the stored fingerprints instead.
      await waitFor(() => db.snapshots.latest(change.id)?.fingerprints !== before?.fingerprints, 20_000, 'the refreshed fingerprints');
      await test.idle();
    };

    // Same length, same statuses: only the literal changes (A -> B).
    await collectAfter(TOTAL_EDIT_1.replace('0)', '1)'));
    const afterEdit = db.snapshots.latest(change.id);
    expect(afterEdit?.contentHash).toBe(snapshot.contentHash);
    expect(afterEdit?.id).toBe(snapshot.id);
    const outdated = await read();
    expect(outdated.marks.map((m) => [m.targetKind, m.state]).sort()).toEqual([
      ['file', 'outdated'],
      ['symbol', 'outdated'],
    ]);
    expect(outdated.progress.touched.done).toBeLessThan(doneBefore);
    expect(outdated.progress.outdated).toBeGreaterThan(outdatedBefore);
    expect(db.changes.get(change.id)?.reviewState).toBe('unreviewed');

    // Revert (B -> A): the marks stay outdated, they do not come back.
    await collectAfter(TOTAL_EDIT_1);
    const reverted = await read();
    expect(reverted.marks.map((m) => m.state)).toEqual(['outdated', 'outdated']);
    expect(reverted.progress.touched.done).toBe(outdated.progress.touched.done);
    expect(reverted.progress.outdated).toBe(outdated.progress.outdated);
  });
});
