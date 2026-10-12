// "Check the rest and approve" (ADR-028 amendment, DC-135) over HTTP against an
// in-process daemon with the API plugin, a temporary DIFFCITY_HOME and a
// database seeded with an invented change: GET /approve/remaining lists the
// touched tier 1 files without a current mark with a token bound to the
// snapshot's content; POST /approve { checkRemaining, snapshotId, files, token }
// marks those files Checked and approves in one transaction.

import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import type { ApiError, ChangeRecord, ReviewMark } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { waitFor } from '../../helpers/daemon.js';
import { call, type Answer } from '../../helpers/review-api.js';
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

async function seeded(options: { archived?: boolean; tier1Files?: string[]; apiNow?: () => Date } = {}): Promise<Seeded> {
  const test = await startTestDaemon({}, { api: true, ...(options.apiNow === undefined ? {} : { apiNow: options.apiNow }) });
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

interface Remaining {
  snapshotId: number;
  head: string;
  files: string[];
  token: string;
}

async function remaining(s: Seeded): Promise<Remaining> {
  const answer = await call(s.port, 'GET', path(s, '/approve/remaining'));
  expect(answer.status).toBe(200);
  return answer.json() as Remaining;
}

/** The confirmation accepted: what GET /approve/remaining answered, sent back. */
function confirm(s: Seeded, shown: Remaining): Promise<Answer> {
  return call(s.port, 'POST', path(s, '/approve'), { body: { checkRemaining: true, snapshotId: shown.snapshotId, files: shown.files, token: shown.token } });
}

/** A body the guards and the archived check refuse before the token is looked at. */
const ANY_BODY = { checkRemaining: true, snapshotId: 1, files: [], token: 'a'.repeat(64) };

describe('approve/check-remaining', () => {
  it('marks only the tier 1 files without a current mark as Checked, keeps the existing marks, then approves', async () => {
    const s = await seeded();
    await mark(s, 'file', 'f-tax', 'good');
    await mark(s, 'symbol', 's-total', 'rewrite');
    const before = s.db.review.list(s.change.id).find((m) => m.targetId === 'f-tax');

    const shown = await remaining(s);
    expect(shown).toEqual({ snapshotId: s.snapshotId, head: s.change.head, files: [TOTAL], token: expect.stringMatching(/^[0-9a-f]{64}$/) as string });

    const answer = await confirm(s, shown);
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

  it('marks every tier 1 file when none is marked, in tier1Files order', async () => {
    const s = await seeded();
    const shown = await remaining(s);
    expect(shown.files).toEqual([TOTAL, TAX]);
    const answer = await confirm(s, shown);
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
    const shown = await remaining(s);
    const first = await confirm(s, shown);
    expect(first.status).toBe(200);
    const body = first.json() as { approvedAt: string; marked: string[] };
    expect(body.marked).toEqual([]);
    const again = await confirm(s, shown);
    expect(again.json()).toEqual({ reviewState: 'approved', approvedHead: s.change.head, approvedAt: body.approvedAt, marked: [] });
  });

  it('already approved at this head with a mark gone outdated: marks it, keeps the approval and records review activity', async () => {
    let clock = Date.parse('2026-09-03T10:00:00.000Z');
    const s = await seeded({ apiNow: () => new Date(clock) });
    await mark(s, 'file', 'f-total', 'checked');
    await mark(s, 'file', 'f-tax', 'checked');
    const approved = (await confirm(s, await remaining(s))).json() as { approvedAt: string };
    s.db.review.markOutdated(s.change.id, [{ kind: 'file', id: 'f-total' }], '2026-09-03T10:30:00.000Z');

    clock = Date.parse('2026-09-03T11:00:00.000Z');
    const shown = await remaining(s);
    expect(shown.files).toEqual([TOTAL]);
    const answer = await confirm(s, shown);
    expect(answer.json()).toEqual({ reviewState: 'approved', approvedHead: s.change.head, approvedAt: approved.approvedAt, marked: [TOTAL] });
    expect(marksOf(s)).toEqual([
      ['f-tax', 'checked', null, 'current'],
      ['f-total', 'checked', null, 'current'],
    ]);
    expect(s.db.changes.get(s.change.id)).toMatchObject({ reviewState: 'approved', lastEventType: 'review', lastEventAt: '2026-09-03T11:00:00.000Z' });
    expect(s.db.events.latestAt(s.change.id, 'review')).toBe('2026-09-03T11:00:00.000Z');
  });

  it('refused when the head moved: snapshot-pending before its snapshot, snapshot-moved after; nothing is marked', async () => {
    const s = await seeded();
    const shown = await remaining(s);
    const newHead = sha();
    s.db.changes.applyPlan(s.repoId, { create: [], update: [{ id: s.change.id, head: newHead }], archive: [] }, T0);
    const pending = await confirm(s, shown);
    expect([pending.status, errorCode(pending)]).toEqual([409, 'snapshot-pending']);
    const pendingList = await call(s.port, 'GET', path(s, '/approve/remaining'));
    expect([pendingList.status, errorCode(pendingList)]).toEqual([409, 'snapshot-pending']);

    s.db.snapshots.put(
      snapshotInput(s.change.id, newHead, { report: JSON.stringify(report(newHead, [TOTAL, TAX])), fingerprints: JSON.stringify(sampleFingerprints()), contentHash: 'h2' }),
    );
    const moved = await confirm(s, shown);
    expect([moved.status, errorCode(moved)]).toEqual([409, 'snapshot-moved']);
    expect(marksOf(s)).toEqual([]);
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('unreviewed');
    // The new snapshot's id and token are what the dialog sends next time.
    expect((await remaining(s)).snapshotId).not.toBe(s.snapshotId);
  });

  it('refused when the snapshot was recomputed in place at the same head: snapshot-moved, no marks, not approved', async () => {
    const s = await seeded();
    const shown = await remaining(s);
    expect(shown.files).toEqual([TOTAL, TAX]);
    // A dirty working tree recomputes the same head: the row is replaced, its id kept, tax.ts has new content.
    const changed = sampleFingerprints({ files: { 'f-tax': { before: 'b-tax', after: 'a-tax-edited' } } });
    const put = s.db.snapshots.put(
      snapshotInput(s.change.id, s.change.head, { report: JSON.stringify(report(s.change.head, [TOTAL, TAX])), fingerprints: JSON.stringify(changed), contentHash: 'h1-edited' }),
    );
    expect(s.db.snapshots.latest(s.change.id)?.id).toBe(s.snapshotId);
    expect(put).toBeTruthy();

    const answer = await confirm(s, shown);
    expect([answer.status, errorCode(answer)]).toEqual([409, 'snapshot-moved']);
    expect(marksOf(s)).toEqual([]);
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('unreviewed');
    // Looking again gives a new token, which is accepted.
    const again = await remaining(s);
    expect(again.token).not.toBe(shown.token);
    expect((await confirm(s, again)).status).toBe(200);
  });

  it('refused when the files to mark are not the ones the confirmation listed: remaining-changed, nothing written', async () => {
    const s = await seeded();
    await mark(s, 'file', 'f-tax', 'good');
    const shown = await remaining(s);
    expect(shown.files).toEqual([TOTAL]);
    // Another tab removes the tax.ts mark before the confirmation is accepted.
    expect((await call(s.port, 'DELETE', `${path(s, '/review/marks')}?kind=file&id=f-tax`)).status).toBe(204);
    const answer = await confirm(s, shown);
    expect([answer.status, errorCode(answer)]).toEqual([409, 'remaining-changed']);
    expect(marksOf(s)).toEqual([]);
    expect(s.db.changes.get(s.change.id)?.reviewState).not.toBe('approved');
  });

  it('a tier 1 file that cannot be marked refuses the whole request: tier1-unchecked, no mark written, not approved', async () => {
    const s = await seeded({ tier1Files: [TOTAL, 'src/auth/session.ts'] });
    const shown = await remaining(s);
    expect(shown.files).toEqual([TOTAL, 'src/auth/session.ts']);
    const answer = await confirm(s, shown);
    expect([answer.status, errorCode(answer)]).toEqual([409, 'tier1-unchecked']);
    expect((answer.json() as ApiError).error.message).toContain('src/auth/session.ts');
    expect(marksOf(s)).toEqual([]);
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('unreviewed');
  });

  it('a bad body is a 400: checkRemaining not a boolean, snapshotId, files or token missing or malformed', async () => {
    const s = await seeded();
    const shown = await remaining(s);
    const good = { checkRemaining: true, snapshotId: shown.snapshotId, files: shown.files, token: shown.token };
    const without = (key: keyof typeof good): Record<string, unknown> => Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
    for (const body of [
      { ...good, checkRemaining: 'yes' },
      without('snapshotId'),
      { ...good, snapshotId: 0 },
      { ...good, snapshotId: '1' },
      without('files'),
      { ...good, files: null },
      { ...good, files: TOTAL },
      { ...good, files: [1] },
      without('token'),
      { ...good, token: 'not-a-token' },
      { ...good, token: shown.token.toUpperCase() },
    ]) {
      const answer = await call(s.port, 'POST', path(s, '/approve'), { body });
      expect([JSON.stringify(body), answer.status, errorCode(answer)]).toEqual([JSON.stringify(body), 400, 'bad-request']);
    }
    // A well-formed token that is not the one shown is a moved snapshot.
    const forged = await call(s.port, 'POST', path(s, '/approve'), { body: { ...good, token: 'a'.repeat(64) } });
    expect([forged.status, errorCode(forged)]).toEqual([409, 'snapshot-moved']);
    // checkRemaining false is the plain Approve: the gate refuses, nothing is marked.
    const plain = await call(s.port, 'POST', path(s, '/approve'), { body: { ...good, checkRemaining: false } });
    expect([plain.status, errorCode(plain)]).toEqual([409, 'tier1-unchecked']);
    expect(marksOf(s)).toEqual([]);
  });

  it('archived: 409 for the bulk approval and the remaining list', async () => {
    const s = await seeded({ archived: true });
    const post = await call(s.port, 'POST', path(s, '/approve'), { body: ANY_BODY });
    expect([post.status, errorCode(post)]).toEqual([409, 'archived']);
    const get = await call(s.port, 'GET', path(s, '/approve/remaining'));
    expect([get.status, errorCode(get)]).toEqual([409, 'archived']);
    expect(marksOf(s)).toEqual([]);
  });

  it('cross-site: 403 for the bulk approval and the remaining list; nothing marked', async () => {
    const s = await seeded();
    const shown = await remaining(s);
    const body = { checkRemaining: true, snapshotId: shown.snapshotId, files: shown.files, token: shown.token };
    const own = `http://127.0.0.1:${String(s.port)}`;
    for (const headers of [
      { origin: 'http://evil.example', 'content-type': 'application/json' },
      { origin: own, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      { 'content-type': 'application/json' },
    ]) {
      const answer = await call(s.port, 'POST', path(s, '/approve'), { body, headers });
      expect([answer.status, errorCode(answer)]).toEqual([403, 'cross-site']);
    }
    for (const headers of [{ origin: 'http://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { referer: 'http://evil.example/page' }]) {
      const answer = await call(s.port, 'GET', path(s, '/approve/remaining'), { headers });
      expect([JSON.stringify(headers), answer.status, errorCode(answer)]).toEqual([JSON.stringify(headers), 403, 'cross-site']);
    }
    expect(marksOf(s)).toEqual([]);
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('unreviewed');
  });

  it('the remaining list is answered with cache-control: no-store', async () => {
    const s = await seeded();
    const answer = await call(s.port, 'GET', path(s, '/approve/remaining'));
    expect(answer.status).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');
  });

  it('a token shown for one file list is refused for another list on the same snapshot: 409, nothing written', async () => {
    const s = await seeded();
    const both = await remaining(s);
    expect(both.files).toEqual([TOTAL, TAX]);
    await mark(s, 'file', 'f-tax', 'good');
    const one = await remaining(s);
    expect(one.snapshotId).toBe(both.snapshotId);
    expect(one.files).toEqual([TOTAL]);
    expect(one.token).not.toBe(both.token);

    // The current list with the token of the earlier list, and the earlier list with the current token.
    for (const body of [
      { checkRemaining: true, snapshotId: one.snapshotId, files: one.files, token: both.token },
      { checkRemaining: true, snapshotId: both.snapshotId, files: both.files, token: one.token },
    ]) {
      const answer = await call(s.port, 'POST', path(s, '/approve'), { body });
      expect(answer.status).toBe(409);
      expect(['snapshot-moved', 'remaining-changed']).toContain(errorCode(answer));
    }
    expect(marksOf(s)).toEqual([['f-tax', 'good', null, 'current']]);
    expect(s.db.changes.get(s.change.id)?.reviewState).not.toBe('approved');
    // The matching pair is still accepted.
    expect((await confirm(s, one)).status).toBe(200);
  });

  it('the remaining list answers 404 for an unknown change, 409 without a snapshot', async () => {
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
