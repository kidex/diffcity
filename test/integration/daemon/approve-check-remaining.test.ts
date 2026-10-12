// "Check the rest and approve" (ADR-028 amendment, DC-135) over HTTP against an
// in-process daemon with the API plugin, a temporary DIFFCITY_HOME and a
// database seeded with an invented change: POST /approve { checkRemaining }
// marks the touched tier 1 files without a current mark as Checked and
// approves in one transaction; GET /approve/remaining lists those files.

import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import type { ApiError, ChangeRecord, ReviewMark } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { waitFor } from '../../helpers/daemon.js';
import { call } from '../../helpers/review-api.js';
import { addRepo, branchFields, sha, snapshotInput, T0 } from '../../unit/db/db-helpers.js';
import { sampleFingerprints, sampleReport } from '../../unit/review/review-helpers.js';
import { cleanupAfterEach, startTestDaemon, type TestDaemon } from '../collect/collect-helpers.js';

cleanupAfterEach();

const TOTAL = 'src/cart/total.ts';
const TAX = 'src/cart/tax.ts';

interface Seeded {
  test: TestDaemon;
  db: Db;
  port: number;
  repoId: number;
  change: ChangeRecord;
  snapshotId: number;
}

/** The review sample with total.ts and tax.ts as tier 1 (and, when asked, a tier 1 path the Report does not list). */
function report(head: string, tier1Files: string[]): Report {
  const base = sampleReport();
  return { ...base, meta: { ...base.meta, head }, summary: { ...base.summary, tier1Files } };
}

async function seeded(options: { archived?: boolean; tier1Files?: string[] } = {}): Promise<Seeded> {
  const test = await startTestDaemon({}, { api: true });
  const db = test.collection.db();
  const repo = addRepo(db);
  const change = db.changes.applyPlan(repo.id, { create: [branchFields('totals')], update: [], archive: [] }, T0).created[0];
  if (change === undefined) throw new Error('no change');
  const stored = JSON.stringify(report(change.head, options.tier1Files ?? [TOTAL, TAX]));
  db.snapshots.put(snapshotInput(change.id, change.head, { report: stored, fingerprints: JSON.stringify(sampleFingerprints()), contentHash: 'h1' }));
  if (options.archived === true) {
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: change.id, reason: 'merged' }] }, '2026-09-02T00:00:00.000Z');
  }
  const snapshotId = db.snapshots.latest(change.id)?.id;
  if (snapshotId === undefined) throw new Error('no snapshot');
  return { test, db, port: test.daemon.info.port, repoId: repo.id, change, snapshotId };
}

const path = (s: Seeded, rest: string): string => `/api/changes/${String(s.change.id)}${rest}`;
const errorCode = (answer: { json(): unknown }): string => (answer.json() as ApiError).error.code;
/** The stored marks as [target, mark, note, state], sorted by target id. */
const marksOf = (s: Seeded): [string, string, string | null, string][] =>
  s.db.review
    .list(s.change.id)
    .map((mark: ReviewMark): [string, string, string | null, string] => [mark.targetId, mark.mark, mark.note, mark.state])
    .sort((a, b) => a[0].localeCompare(b[0]));

async function mark(s: Seeded, kind: 'file' | 'symbol', id: string, value: 'checked' | 'good' | 'rewrite'): Promise<void> {
  const answer = await call(s.port, 'PUT', path(s, '/review/marks'), { body: { snapshotId: s.snapshotId, target: { kind, id }, mark: value } });
  expect(answer.status).toBe(200);
}

async function remaining(s: Seeded): Promise<{ snapshotId: number; head: string; files: string[] }> {
  const answer = await call(s.port, 'GET', path(s, '/approve/remaining'));
  expect(answer.status).toBe(200);
  return answer.json() as { snapshotId: number; head: string; files: string[] };
}

describe('approve/check-remaining', () => {
  it('marks only the tier 1 files without a current mark as Checked, keeps the existing marks, then approves', async () => {
    const s = await seeded();
    await mark(s, 'file', 'f-tax', 'good');
    await mark(s, 'symbol', 's-total', 'rewrite');
    const before = s.db.review.list(s.change.id).find((m) => m.targetId === 'f-tax');

    expect(await remaining(s)).toEqual({ snapshotId: s.snapshotId, head: s.change.head, files: [TOTAL] });

    const answer = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: s.snapshotId, files: [TOTAL] } });
    expect(answer.status).toBe(200);
    const body = answer.json() as { reviewState: string; approvedHead: string; approvedAt: string; marked: string[] };
    expect(body).toEqual({ reviewState: 'approved', approvedHead: s.change.head, approvedAt: expect.any(String) as string, marked: [TOTAL] });

    expect(marksOf(s)).toEqual([
      ['f-tax', 'good', null, 'current'],
      ['f-total', 'checked', null, 'current'],
      ['s-total', 'rewrite', null, 'current'],
    ]);
    // The existing mark is left exactly as it was.
    expect(s.db.review.list(s.change.id).find((m) => m.targetId === 'f-tax')).toEqual(before);
    expect(s.db.changes.get(s.change.id)).toMatchObject({ reviewState: 'approved', lastEventType: 'review' });
    expect(s.db.changes.approval(s.change.id)).toEqual({ approvedHead: s.change.head, approvedAt: body.approvedAt });
    expect((await remaining(s)).files).toEqual([]);
    await waitFor(() => s.test.events().some((e) => e.event === 'review' && e.data['changeId'] === s.change.id), 5000, 'the review signal');
  });

  it('marks every tier 1 file when none is marked, and order follows tier1Files; without files in the body it still re-checks itself', async () => {
    const s = await seeded();
    expect((await remaining(s)).files).toEqual([TOTAL, TAX]);
    const answer = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: s.snapshotId } });
    expect(answer.status).toBe(200);
    expect((answer.json() as { marked: string[] }).marked).toEqual([TOTAL, TAX]);
    expect(marksOf(s).map(([id, value]) => [id, value])).toEqual([
      ['f-tax', 'checked'],
      ['f-total', 'checked'],
    ]);
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('approved');
  });

  it('nothing left to mark: approves with marked []; an approval at the same head is answered as it is', async () => {
    const s = await seeded();
    await mark(s, 'file', 'f-total', 'checked');
    await mark(s, 'file', 'f-tax', 'checked');
    const first = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: s.snapshotId, files: [] } });
    expect(first.status).toBe(200);
    const body = first.json() as { approvedAt: string; marked: string[] };
    expect(body.marked).toEqual([]);
    const again = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: s.snapshotId } });
    expect(again.json()).toEqual({ reviewState: 'approved', approvedHead: s.change.head, approvedAt: body.approvedAt, marked: [] });
  });

  it('refused when the head moved: snapshot-pending before its snapshot, snapshot-moved after; nothing is marked', async () => {
    const s = await seeded();
    const newHead = sha();
    s.db.changes.applyPlan(s.repoId, { create: [], update: [{ id: s.change.id, head: newHead }], archive: [] }, T0);
    const pending = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: s.snapshotId } });
    expect([pending.status, errorCode(pending)]).toEqual([409, 'snapshot-pending']);
    const pendingList = await call(s.port, 'GET', path(s, '/approve/remaining'));
    expect([pendingList.status, errorCode(pendingList)]).toEqual([409, 'snapshot-pending']);

    s.db.snapshots.put(
      snapshotInput(s.change.id, newHead, { report: JSON.stringify(report(newHead, [TOTAL, TAX])), fingerprints: JSON.stringify(sampleFingerprints()), contentHash: 'h2' }),
    );
    const moved = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: s.snapshotId } });
    expect([moved.status, errorCode(moved)]).toEqual([409, 'snapshot-moved']);
    expect(marksOf(s)).toEqual([]);
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('unreviewed');
    // The new snapshot's id is what the dialog sends next time.
    expect((await remaining(s)).snapshotId).not.toBe(s.snapshotId);
  });

  it('refused when the files to mark are not the ones the confirmation listed: remaining-changed, nothing written', async () => {
    const s = await seeded();
    await mark(s, 'file', 'f-tax', 'good');
    const listed = (await remaining(s)).files;
    expect(listed).toEqual([TOTAL]);
    // Another tab removes the tax.ts mark before the confirmation is accepted.
    expect((await call(s.port, 'DELETE', `${path(s, '/review/marks')}?kind=file&id=f-tax`)).status).toBe(204);
    const answer = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: s.snapshotId, files: listed } });
    expect([answer.status, errorCode(answer)]).toEqual([409, 'remaining-changed']);
    expect(marksOf(s)).toEqual([]);
    expect(s.db.changes.get(s.change.id)?.reviewState).not.toBe('approved');
  });

  it('a tier 1 file that cannot be marked refuses the whole request: tier1-unchecked, no mark written, not approved', async () => {
    const s = await seeded({ tier1Files: [TOTAL, 'src/auth/session.ts'] });
    const answer = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: s.snapshotId } });
    expect([answer.status, errorCode(answer)]).toEqual([409, 'tier1-unchecked']);
    expect((answer.json() as ApiError).error.message).toContain('src/auth/session.ts');
    expect(marksOf(s)).toEqual([]);
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('unreviewed');
  });

  it('a bad body is a 400: checkRemaining not a boolean, no or a bad snapshotId, files not a string list', async () => {
    const s = await seeded();
    for (const body of [
      { checkRemaining: 'yes', snapshotId: s.snapshotId },
      { checkRemaining: true },
      { checkRemaining: true, snapshotId: 0 },
      { checkRemaining: true, snapshotId: '1' },
      { checkRemaining: true, snapshotId: s.snapshotId, files: TOTAL },
      { checkRemaining: true, snapshotId: s.snapshotId, files: [1] },
    ]) {
      const answer = await call(s.port, 'POST', path(s, '/approve'), { body });
      expect([JSON.stringify(body), answer.status, errorCode(answer)]).toEqual([JSON.stringify(body), 400, 'bad-request']);
    }
    // checkRemaining false is the plain Approve: the gate refuses, nothing is marked.
    const plain = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: false, snapshotId: s.snapshotId } });
    expect([plain.status, errorCode(plain)]).toEqual([409, 'tier1-unchecked']);
    expect(marksOf(s)).toEqual([]);
  });

  it('archived: 409 for the bulk approval and the remaining list', async () => {
    const s = await seeded({ archived: true });
    const post = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: s.snapshotId } });
    expect([post.status, errorCode(post)]).toEqual([409, 'archived']);
    const get = await call(s.port, 'GET', path(s, '/approve/remaining'));
    expect([get.status, errorCode(get)]).toEqual([409, 'archived']);
    expect(marksOf(s)).toEqual([]);
  });

  it('cross-site: 403 for the bulk approval and the remaining list; nothing marked', async () => {
    const s = await seeded();
    const own = `http://127.0.0.1:${String(s.port)}`;
    for (const headers of [
      { origin: 'http://evil.example', 'content-type': 'application/json' },
      { origin: own, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      { 'content-type': 'application/json' },
    ]) {
      const answer = await call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: s.snapshotId }, headers });
      expect([answer.status, errorCode(answer)]).toEqual([403, 'cross-site']);
    }
    for (const headers of [{ origin: 'http://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { referer: 'http://evil.example/page' }]) {
      const answer = await call(s.port, 'GET', path(s, '/approve/remaining'), { headers });
      expect([JSON.stringify(headers), answer.status, errorCode(answer)]).toEqual([JSON.stringify(headers), 403, 'cross-site']);
    }
    expect(marksOf(s)).toEqual([]);
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('unreviewed');
  });

  it('the remaining list is not cached and answers 404 for an unknown change, 409 without a snapshot', async () => {
    const s = await seeded();
    const answer = await call(s.port, 'GET', path(s, '/approve/remaining'));
    expect(answer.status).toBe(200);
    const unknown = await call(s.port, 'GET', '/api/changes/9999/approve/remaining');
    expect([unknown.status, errorCode(unknown)]).toEqual([404, 'not-found']);
    const bare = s.db.changes.applyPlan(s.repoId, { create: [branchFields('bare')], update: [], archive: [] }, T0).created[0];
    if (bare === undefined) throw new Error('no change');
    const none = await call(s.port, 'GET', `/api/changes/${String(bare.id)}/approve/remaining`);
    expect([none.status, errorCode(none)]).toEqual([409, 'no-snapshot']);
  });
});
