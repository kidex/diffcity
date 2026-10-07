// Approve stays valid only while the content is unchanged (ADR-036, ADR-019):
// an approved branch that is checked out, whose working tree then changes
// without a new commit, is `unreviewed` after the next collection; the fix
// queue it writes there is checked to be the working tree at the change head.
// A real repository, a real collection, the routes over HTTP.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Report } from '../../../src/core/report/types.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const SESSION_V1 = 'export function refresh(token: string): string {\n  return token;\n}\n';
const SESSION_DIRTY = 'export function refresh(token: string): string {\n  return token.toUpperCase();\n}\n';

describe('approve', () => {
  it('approve/dirty-content-unreviewed: an approved checked-out branch whose working tree changes is unreviewed after the next collection', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/session');
    await repo.commit('refresh the session', { 'src/auth/session.ts': SESSION_V1 });
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const tracked = await test.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    await test.idle();
    const db = test.collection.db();
    const change = db.changes.listLive(tracked.repo.id).find((c) => c.ref === 'branch:feature/session');
    if (change === undefined) throw new Error('feature change not collected');
    expect(change.worktreePath).not.toBeNull();
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null) throw new Error('no snapshot');
    const report = JSON.parse(snapshot.report) as Report;
    expect(report.summary.tier1Files).toEqual(['src/auth/session.ts']);
    const sessionId = report.packages.flatMap((p) => p.files).find((f) => f.path === 'src/auth/session.ts')?.id;
    const port = test.daemon.info.port;
    const mark = await call(port, 'PUT', `/api/changes/${String(change.id)}/review/marks`, {
      body: { snapshotId: snapshot.id, target: { kind: 'file', id: sessionId }, mark: 'good' },
    });
    expect(mark.status).toBe(200);
    expect((await call(port, 'POST', `/api/changes/${String(change.id)}/approve`)).status).toBe(200);
    expect(db.changes.get(change.id)?.reviewState).toBe('approved');

    // The same head, new content in the working tree.
    await repo.write({ 'src/auth/session.ts': SESSION_DIRTY });
    const again = await test.track(repo.dir);
    if (!again.ok) throw new Error(again.error);
    await test.idle();
    const after = db.changes.get(change.id);
    expect(after?.head).toBe(change.head);
    expect(after?.reviewState).toBe('unreviewed');
    const refused = await call(port, 'POST', `/api/changes/${String(change.id)}/approve`);
    expect(refused.status).toBe(409);
    expect(existsSync(join(repo.dir, '.diffcity'))).toBe(false);
  });
});
