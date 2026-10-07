// Approve stays valid only while the head and the content are unchanged
// (ADR-036): the existing ADR-019 reconcile returns an approved change to
// `unreviewed` when a collection finds it moved. A real repository, a real
// collection, the approve route over HTTP.

import { describe, expect, it } from 'vitest';
import type { Report } from '../../../src/core/report/types.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const SESSION_V1 = 'export function refresh(token: string): string {\n  return token;\n}\n';
const SESSION_V2 = 'export function refresh(token: string): string {\n  return token.trim();\n}\n';

describe('approve', () => {
  it('approve/ok-then-head-moves-unreviewed: an approved change whose head moves is unreviewed after the next collection', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/session');
    await repo.commit('refresh the session', { 'src/auth/session.ts': SESSION_V1, 'src/cart/note.ts': 'export const note = 1;\n' });
    await repo.checkout('main');
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const tracked = await test.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    await test.idle();
    const db = test.collection.db();
    const change = db.changes.listLive(tracked.repo.id).find((c) => c.ref === 'branch:feature/session');
    if (change === undefined) throw new Error('feature change not collected');
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null) throw new Error('no snapshot');
    const report = JSON.parse(snapshot.report) as Report;
    expect(report.summary.tier1Files).toEqual(['src/auth/session.ts']);
    const sessionId = report.packages.flatMap((p) => p.files).find((f) => f.path === 'src/auth/session.ts')?.id;
    const port = test.daemon.info.port;
    const approve = (): ReturnType<typeof call> => call(port, 'POST', `/api/changes/${String(change.id)}/approve`);

    expect((await approve()).status).toBe(409);
    const mark = await call(port, 'PUT', `/api/changes/${String(change.id)}/review/marks`, {
      body: { snapshotId: snapshot.id, target: { kind: 'file', id: sessionId }, mark: 'good' },
    });
    expect(mark.status).toBe(200);
    const ok = await approve();
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ reviewState: 'approved', approvedHead: change.head });
    expect(db.changes.get(change.id)?.reviewState).toBe('approved');

    // A collection with nothing new keeps the approval.
    const same = await test.track(repo.dir);
    if (!same.ok) throw new Error(same.error);
    await test.idle();
    expect(db.changes.get(change.id)?.reviewState).toBe('approved');

    await repo.checkout('feature/session');
    await repo.commit('trim the token', { 'src/auth/session.ts': SESSION_V2 });
    await repo.checkout('main');
    const moved = await test.track(repo.dir);
    if (!moved.ok) throw new Error(moved.error);
    await test.idle();

    const after = db.changes.get(change.id);
    expect(after?.head).not.toBe(change.head);
    expect(after?.reviewState).toBe('unreviewed');
    const summary = (await call(port, 'GET', `/api/changes/${String(change.id)}`)).json() as { reviewState: string };
    expect(summary.reviewState).toBe('unreviewed');
    // The mark on the changed tier 1 file is outdated, so Approve is refused again.
    const again = await approve();
    expect(again.status).toBe(409);
  });
});
