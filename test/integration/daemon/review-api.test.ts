// The review routes of ADR-028 and the write guard, over HTTP against an
// in-process daemon with the API plugin, a temporary DIFFCITY_HOME and a
// database seeded with an invented change (no repository needed).

import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import type { ApiError, ReviewMark, ReviewProgress } from '../../../src/core/model/types.js';
import { waitFor } from '../../helpers/daemon.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, startTestDaemon, type TestDaemon } from '../collect/collect-helpers.js';
import { addRepo, branchFields, snapshotInput, T0 } from '../../unit/db/db-helpers.js';
import { sampleFingerprints, sampleReport } from '../../unit/review/review-helpers.js';

cleanupAfterEach();

interface Seeded {
  test: TestDaemon;
  db: Db;
  port: number;
  repoId: number;
  changeId: number;
  snapshotId: number;
  head: string;
}

/** A daemon with the API, one change with one snapshot of the sample report. */
async function seeded(options: { apiNow?: () => Date; archived?: boolean; reviewState?: 'unreviewed' | 'approved' } = {}): Promise<Seeded> {
  const test = await startTestDaemon({}, { api: true, ...(options.apiNow === undefined ? {} : { apiNow: options.apiNow }) });
  const db = test.collection.db();
  const repo = addRepo(db);
  const change = db.changes.applyPlan(
    repo.id,
    { create: [branchFields('totals', { reviewState: options.reviewState ?? 'unreviewed' })], update: [], archive: [] },
    T0,
  ).created[0];
  if (change === undefined) throw new Error('no change');
  db.snapshots.put(
    snapshotInput(change.id, change.head, {
      report: JSON.stringify(sampleReport()),
      fingerprints: JSON.stringify(sampleFingerprints()),
      contentHash: 'h1',
    }),
  );
  if (options.archived === true) {
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: change.id, reason: 'merged' }] }, '2026-09-02T00:00:00.000Z');
  }
  const snapshot = db.snapshots.latest(change.id);
  if (snapshot === null) throw new Error('no snapshot');
  return { test, db, port: test.daemon.info.port, repoId: repo.id, changeId: change.id, snapshotId: snapshot.id, head: change.head };
}

interface ReviewBody {
  snapshotId: number;
  marks: ReviewMark[];
  note: string | null;
  progress: ReviewProgress;
}

const reviewPath = (changeId: number, rest = ''): string => `/api/changes/${String(changeId)}/review${rest}`;
const errorCode = (answer: { json(): unknown }): string => (answer.json() as ApiError).error.code;

describe('api/review-put-get-delete', () => {
  it('marks a file and a symbol, reads them back with progress, keeps a note, renders the summary and undoes a mark', async () => {
    const { port, changeId, snapshotId } = await seeded();

    const empty = await call(port, 'GET', reviewPath(changeId));
    expect(empty.status).toBe(200);
    expect(empty.json()).toEqual({
      snapshotId,
      marks: [],
      note: null,
      progress: { attention: { done: 0, total: 1 }, touched: { done: 0, total: 2 }, tier1: { done: 0, total: 0 }, rewrite: 0, outdated: 0, allAttentionDone: false },
    });

    const file = await call(port, 'PUT', reviewPath(changeId, '/marks'), {
      body: { snapshotId, target: { kind: 'file', id: 'f-tax' }, mark: 'good' },
    });
    expect(file.status).toBe(200);
    const fileBody = file.json() as { mark: ReviewMark; progress: ReviewProgress };
    expect(fileBody.mark).toMatchObject({ targetKind: 'file', targetId: 'f-tax', filePath: 'src/cart/tax.ts', mark: 'good', note: null, lines: null, state: 'current', outdatedAt: null });
    expect(Object.keys(fileBody.mark).sort()).toEqual(
      ['createdAt', 'filePath', 'lines', 'mark', 'note', 'outdatedAt', 'state', 'targetId', 'targetKind', 'updatedAt'],
    );
    expect(fileBody.progress.touched).toEqual({ done: 1, total: 2 });

    const symbol = await call(port, 'PUT', reviewPath(changeId, '/marks'), {
      body: { snapshotId, target: { kind: 'symbol', id: 's-total' }, mark: 'rewrite', note: 'Handle empty carts.', lines: { side: 'new', start: 2, end: 4 } },
    });
    expect(symbol.status).toBe(200);
    expect((symbol.json() as { progress: ReviewProgress }).progress.rewrite).toBe(1);

    expect((await call(port, 'PUT', reviewPath(changeId, '/note'), { body: { note: 'Overall fine.' } })).json()).toEqual({ note: 'Overall fine.' });

    const read = (await call(port, 'GET', reviewPath(changeId))).json() as ReviewBody;
    expect(read.note).toBe('Overall fine.');
    expect(read.marks.map((m) => [m.targetKind, m.targetId, m.mark])).toEqual([
      ['file', 'f-tax', 'good'],
      ['symbol', 's-total', 'rewrite'],
    ]);
    expect(read.marks[1]?.lines).toEqual({ side: 'new', start: 2, end: 4 });

    const summary = await call(port, 'GET', reviewPath(changeId, '/summary'));
    expect(summary.status).toBe(200);
    expect(summary.contentType).toBe('text/markdown; charset=utf-8');
    expect(summary.text).toContain('# Review of branch:totals in sample-shop (head ');
    expect(summary.text).toContain('Overall fine.');
    expect(summary.text).toContain('### src/cart/total.ts\n- `total`, lines 2–4: Handle empty carts.\n');

    // Marking a target again replaces its mark.
    const again = await call(port, 'PUT', reviewPath(changeId, '/marks'), { body: { snapshotId, target: { kind: 'file', id: 'f-tax' }, mark: 'checked' } });
    expect((again.json() as { mark: ReviewMark }).mark.mark).toBe('checked');
    expect(((await call(port, 'GET', reviewPath(changeId))).json() as ReviewBody).marks).toHaveLength(2);

    const del = await call(port, 'DELETE', `${reviewPath(changeId, '/marks')}?kind=file&id=f-tax`);
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
    expect(((await call(port, 'GET', reviewPath(changeId))).json() as ReviewBody).marks).toHaveLength(1);
    expect((await call(port, 'DELETE', `${reviewPath(changeId, '/marks')}?kind=file&id=f-tax`)).status).toBe(404);

    // An empty string clears the note.
    expect((await call(port, 'PUT', reviewPath(changeId, '/note'), { body: { note: '' } })).json()).toEqual({ note: null });
    expect(((await call(port, 'GET', reviewPath(changeId))).json() as ReviewBody).note).toBeNull();
  });

  it('answers 404 for an unknown change and a target that is not markable, 400 for a bad body, 409 without a snapshot', async () => {
    const { port, db, repoId, changeId, snapshotId } = await seeded();
    const url = reviewPath(changeId, '/marks');
    expect((await call(port, 'GET', reviewPath(9999))).status).toBe(404);
    expect((await call(port, 'GET', '/api/changes/abc/review')).status).toBe(400);

    for (const target of [
      { kind: 'file', id: 'f-readme' },
      { kind: 'symbol', id: 's-banner' },
      { kind: 'file', id: 'nope' },
    ]) {
      const answer = await call(port, 'PUT', url, { body: { snapshotId, target, mark: 'checked' } });
      expect(answer.status).toBe(404);
      expect(errorCode(answer)).toBe('target-not-found');
    }
    const noNote = await call(port, 'PUT', url, { body: { snapshotId, target: { kind: 'file', id: 'f-tax' }, mark: 'rewrite' } });
    expect(noNote.status).toBe(400);
    expect(errorCode(noNote)).toBe('bad-request');
    expect((await call(port, 'PUT', url, { body: '{ nope' })).status).toBe(400);
    expect((await call(port, 'PUT', reviewPath(changeId, '/note'), { body: { note: 'x'.repeat(4001) } })).status).toBe(400);
    expect((await call(port, 'DELETE', `${url}?kind=package&id=f-tax`)).status).toBe(400);
    expect((await call(port, 'DELETE', `${url}?kind=file`)).status).toBe(400);

    const bare = db.changes.applyPlan(repoId, { create: [branchFields('bare')], update: [], archive: [] }, T0).created[0];
    if (bare === undefined) throw new Error('no change');
    for (const rest of ['', '/summary']) {
      const answer = await call(port, 'GET', reviewPath(bare.id, rest));
      expect(answer.status).toBe(409);
      expect(errorCode(answer)).toBe('no-snapshot');
    }
  });
});

describe('api/review-snapshot-moved-409', () => {
  it('a mark made against an older snapshot is refused when the target changed since', async () => {
    const { db, port, changeId, snapshotId } = await seeded();
    db.snapshots.put(
      snapshotInput(changeId, 'b'.repeat(40), {
        report: JSON.stringify(sampleReport()),
        fingerprints: JSON.stringify(sampleFingerprints({ files: { 'f-total': { before: 'b-total', after: 'a-total-2' } } })),
        contentHash: 'h2',
        computedAt: '2026-09-01T11:00:00.000Z',
      }),
    );
    const latest = db.snapshots.latest(changeId);
    expect(latest?.id).not.toBe(snapshotId);

    const answer = await call(port, 'PUT', reviewPath(changeId, '/marks'), {
      body: { snapshotId, target: { kind: 'file', id: 'f-total' }, mark: 'checked' },
    });
    expect(answer.status).toBe(409);
    expect(errorCode(answer)).toBe('snapshot-moved');
    expect(db.review.list(changeId)).toEqual([]);

    // A snapshot id the server does not know cannot be compared: also moved.
    const unknown = await call(port, 'PUT', reviewPath(changeId, '/marks'), {
      body: { snapshotId: 4242, target: { kind: 'file', id: 'f-tax' }, mark: 'checked' },
    });
    expect(unknown.status).toBe(409);
    expect(errorCode(unknown)).toBe('snapshot-moved');
  });
});

describe('api/review-snapshot-moved-same-fingerprint-ok', () => {
  it('the same older snapshot is accepted for a target whose fingerprint did not change; the mark uses the latest snapshot', async () => {
    const { db, port, changeId, snapshotId } = await seeded();
    db.snapshots.put(
      snapshotInput(changeId, 'b'.repeat(40), {
        report: JSON.stringify(sampleReport()),
        fingerprints: JSON.stringify(sampleFingerprints({ files: { 'f-total': { before: 'b-total', after: 'a-total-2' } } })),
        contentHash: 'h2',
        computedAt: '2026-09-01T11:00:00.000Z',
      }),
    );
    const latestId = db.snapshots.latest(changeId)?.id;
    const answer = await call(port, 'PUT', reviewPath(changeId, '/marks'), {
      body: { snapshotId, target: { kind: 'file', id: 'f-tax' }, mark: 'checked' },
    });
    expect(answer.status).toBe(200);
    const [stored] = db.review.list(changeId);
    expect(stored).toMatchObject({ targetId: 'f-tax', fingerprint: 'b-tax|a-tax', snapshotId: latestId, state: 'current' });
  });
});

describe('api/review-cross-site-403', () => {
  it('a foreign Origin or cross-site Fetch metadata gets 403 cross-site and writes nothing', async () => {
    const { db, port, changeId, snapshotId } = await seeded();
    const body = { snapshotId, target: { kind: 'file', id: 'f-tax' }, mark: 'checked' };
    const own = `http://127.0.0.1:${String(port)}`;
    const json = { 'content-type': 'application/json' };
    const attempts: [string, Record<string, string>][] = [
      ['PUT', { ...json, origin: 'http://evil.example' }],
      ['PUT', { ...json, origin: `http://127.0.0.1:${String(port + 1)}` }],
      ['PUT', { ...json, origin: own, 'sec-fetch-site': 'cross-site' }],
      ['PUT', { ...json, origin: own, 'sec-fetch-site': 'same-site' }],
      ['PUT', { ...json, origin: own, 'sec-fetch-site': 'none' }],
    ];
    for (const [method, headers] of attempts) {
      const answer = await call(port, method, reviewPath(changeId, '/marks'), { body, headers });
      expect(answer.status).toBe(403);
      expect(errorCode(answer)).toBe('cross-site');
    }
    const del = await call(port, 'DELETE', `${reviewPath(changeId, '/marks')}?kind=file&id=f-tax`, { headers: { origin: 'http://evil.example' } });
    expect(del.status).toBe(403);
    const note = await call(port, 'PUT', reviewPath(changeId, '/note'), { body: { note: 'x' }, headers: { ...json, origin: 'http://evil.example' } });
    expect(note.status).toBe(403);
    expect(db.review.list(changeId)).toEqual([]);
    expect(db.review.note(changeId)).toBeNull();

    // Same-origin Fetch metadata and localhost as the origin pass.
    const ok = await call(port, 'PUT', reviewPath(changeId, '/marks'), {
      body,
      headers: { ...json, origin: `http://localhost:${String(port)}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(ok.status).toBe(200);
  });
});

describe('api/review-no-origin-403', () => {
  it('a write without an Origin header is refused, as curl would be', async () => {
    const { db, port, changeId, snapshotId } = await seeded();
    const body = { snapshotId, target: { kind: 'file', id: 'f-tax' }, mark: 'checked' };
    const put = await call(port, 'PUT', reviewPath(changeId, '/marks'), { body, headers: { 'content-type': 'application/json' } });
    expect(put.status).toBe(403);
    expect(errorCode(put)).toBe('cross-site');
    const del = await call(port, 'DELETE', `${reviewPath(changeId, '/marks')}?kind=file&id=f-tax`, { headers: {} });
    expect(del.status).toBe(403);
    expect(db.review.list(changeId)).toEqual([]);
  });
});

describe('api/review-wrong-content-type-415', () => {
  it('a body that is not application/json gets 415; a bodyless DELETE needs no content type', async () => {
    const { db, port, changeId, snapshotId } = await seeded();
    const own = { origin: `http://127.0.0.1:${String(port)}` };
    const text = JSON.stringify({ snapshotId, target: { kind: 'file', id: 'f-tax' }, mark: 'checked' });
    for (const headers of [{ ...own, 'content-type': 'text/plain' }, { ...own, 'content-type': 'application/x-www-form-urlencoded' }, { ...own }]) {
      const answer = await call(port, 'PUT', reviewPath(changeId, '/marks'), { body: text, headers });
      expect(answer.status).toBe(415);
      expect(errorCode(answer)).toBe('unsupported-media-type');
    }
    expect(db.review.list(changeId)).toEqual([]);

    expect((await call(port, 'PUT', reviewPath(changeId, '/marks'), { body: text })).status).toBe(200);
    const del = await call(port, 'DELETE', `${reviewPath(changeId, '/marks')}?kind=file&id=f-tax`, { headers: own });
    expect(del.status).toBe(204);
  });
});

describe('api/review-archived-409', () => {
  it('an archived change refuses marks and notes, and can still be read', async () => {
    const { port, changeId, snapshotId } = await seeded({ archived: true });
    const mark = await call(port, 'PUT', reviewPath(changeId, '/marks'), {
      body: { snapshotId, target: { kind: 'file', id: 'f-tax' }, mark: 'checked' },
    });
    expect(mark.status).toBe(409);
    expect(errorCode(mark)).toBe('archived');
    const note = await call(port, 'PUT', reviewPath(changeId, '/note'), { body: { note: 'late' } });
    expect(note.status).toBe(409);
    expect(errorCode(note)).toBe('archived');
    expect((await call(port, 'GET', reviewPath(changeId))).status).toBe(200);
  });
});

describe('api/review-first-mark-in-review', () => {
  it('the first mark sets an unreviewed change in-review, stamps the last event and signals; an approved change stays approved', async () => {
    let now = new Date('2026-09-03T10:00:00.000Z');
    const { test, db, port, changeId, snapshotId, repoId } = await seeded({ apiNow: () => now });
    const put = (id: string, mark = 'checked') =>
      call(port, 'PUT', reviewPath(changeId, '/marks'), { body: { snapshotId, target: { kind: 'file', id }, mark } });

    expect(db.changes.get(changeId)?.reviewState).toBe('unreviewed');
    expect((await put('f-tax')).status).toBe(200);
    expect(db.changes.get(changeId)).toMatchObject({ reviewState: 'in-review', lastEventType: 'review', lastEventAt: '2026-09-03T10:00:00.000Z' });
    expect(db.changes.getSummary(changeId)?.lastEvent).toEqual({ type: 'review', at: '2026-09-03T10:00:00.000Z' });
    const reviewEvents = () => db.events.listForRepo(repoId).filter((e) => e.type === 'review');
    expect(reviewEvents()).toHaveLength(1);
    const isSignal = (e: { event: string }): boolean => e.event === 'review' || e.event === 'changes';
    await waitFor(() => test.events().filter(isSignal).length >= 2, 5000, 'the review and changes signals');
    const signals = test.events().filter(isSignal);
    expect(signals.map((e) => e.event)).toEqual(['review', 'changes']);
    expect(signals[0]?.data).toEqual({ repoId, changeId });
    expect(signals[1]?.data).toEqual({ repoId });

    // Within 10 minutes: the change moves, no new events row.
    now = new Date('2026-09-03T10:09:59.000Z');
    expect((await put('f-total', 'good')).status).toBe(200);
    expect(db.changes.get(changeId)?.lastEventAt).toBe('2026-09-03T10:09:59.000Z');
    expect(reviewEvents()).toHaveLength(1);
    // Notes and undo are writes too.
    now = new Date('2026-09-03T10:10:00.000Z');
    await call(port, 'PUT', reviewPath(changeId, '/note'), { body: { note: 'n' } });
    expect(reviewEvents()).toHaveLength(1);
    // Older than 10 minutes since the previous review event: a new row.
    now = new Date('2026-09-03T10:10:01.000Z');
    await call(port, 'DELETE', `${reviewPath(changeId, '/marks')}?kind=file&id=f-total`);
    expect(reviewEvents()).toHaveLength(2);
    expect(db.changes.get(changeId)?.reviewState).toBe('in-review');
  });

  it('a change that is already approved keeps its state when marked', async () => {
    const { db, port, changeId, snapshotId } = await seeded({ reviewState: 'approved' });
    await call(port, 'PUT', reviewPath(changeId, '/marks'), { body: { snapshotId, target: { kind: 'file', id: 'f-tax' }, mark: 'checked' } });
    expect(db.changes.get(changeId)).toMatchObject({ reviewState: 'approved', lastEventType: 'review' });
  });
});
