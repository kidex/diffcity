// The review routes (ADR-028): the first API routes that write. The write guard
// itself is a server hook (src/daemon/http/server.ts); these handlers validate,
// look up and call src/core/review. The fingerprint of a mark always comes from
// the server's latest snapshot, never from the client.

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../core/db/index.js';
import type { ChangeRecord, Fingerprints, ReviewMark, ReviewProgress, SseEvent } from '../../core/model/types.js';
import type { Report } from '../../core/report/types.js';
import {
  computeProgress,
  currentFingerprint,
  markableTargets,
  parseTargetId,
  parseTargetKind,
  renderSummary,
  validateGeneralNote,
  validateMarkInput,
  type StoredMark,
  type TargetRef,
} from '../../core/review/index.js';
import { HttpError } from '../http/errors.js';
import { recordReviewActivity } from './activity.js';
import { parseId, type Query } from './params.js';

export { REVIEW_EVENT_GAP_MS } from './activity.js';

export interface ReviewDeps {
  db: Db;
  broadcast: (event: SseEvent) => void;
  now: () => Date;
}

interface IdParams {
  id: string;
}

/** The ReviewMark of the API: the stored fields the client never sees are left out. */
const publicMark = (stored: StoredMark): ReviewMark => ({
  targetKind: stored.targetKind,
  targetId: stored.targetId,
  filePath: stored.filePath,
  mark: stored.mark,
  note: stored.note,
  lines: stored.lines,
  state: stored.state,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
  outdatedAt: stored.outdatedAt,
});

function badRequest(message: string): HttpError {
  return new HttpError(400, 'bad-request', message);
}

export function registerReviewRoutes(http: FastifyInstance, deps: ReviewDeps): void {
  const { db } = deps;

  const changeOf = (rawId: string) => {
    const id = parseId('id', rawId);
    const change = db.changes.get(id);
    if (change === null) throw new HttpError(404, 'not-found', `change ${String(id)} not found`);
    return change;
  };

  const progressOf = (changeId: number, report: Report): { marks: ReviewMark[]; progress: ReviewProgress } => {
    const marks = db.review.list(changeId).map(publicMark);
    return { marks, progress: computeProgress(report, marks) };
  };

  /** A write happened: lastEventType/lastEventAt, a throttled `review` event; the first mark starts the review. */
  const recordWrite = (at: Date, change: ChangeRecord, firstMark: boolean): void => {
    recordReviewActivity(db, change, at, firstMark && change.reviewState === 'unreviewed' ? 'in-review' : undefined);
  };

  const signal = (repoId: number, changeId: number): void => {
    deps.broadcast({ event: 'review', data: { repoId, changeId } });
    deps.broadcast({ event: 'changes', data: { repoId } });
  };

  http.get<{ Params: IdParams }>('/api/changes/:id/review', (request) => {
    const change = changeOf(request.params.id);
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null) throw new HttpError(409, 'no-snapshot', `change ${String(change.id)} has no snapshot yet`);
    const { marks, progress } = progressOf(change.id, JSON.parse(snapshot.report) as Report);
    return { snapshotId: snapshot.id, marks, note: db.review.note(change.id), progress };
  });

  http.put<{ Params: IdParams; Body: unknown }>('/api/changes/:id/review/marks', (request) => {
    const change = changeOf(request.params.id);
    const parsed = validateMarkInput(request.body);
    if (!parsed.ok) throw badRequest(parsed.message);
    if (change.archivedAt !== null) throw new HttpError(409, 'archived', `change ${String(change.id)} is archived`);
    const input = parsed.value;

    const notFound = (): HttpError =>
      new HttpError(404, 'target-not-found', `${input.target.kind} ${input.target.id} is not a markable target of the latest snapshot`);
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null || snapshot.fingerprints === null) throw notFound();
    const report = JSON.parse(snapshot.report) as Report;
    const fingerprints = JSON.parse(snapshot.fingerprints) as Fingerprints;
    const target = markableTargets(report, fingerprints).get(`${input.target.kind}:${input.target.id}`);
    if (target === undefined) throw notFound();

    if (input.snapshotId !== snapshot.id) {
      // The client looked at an older snapshot: fine only if this target did not change since.
      const seenJson = db.snapshots.fingerprintsOf(change.id, input.snapshotId);
      const seen = seenJson === null ? null : currentFingerprint(JSON.parse(seenJson) as Fingerprints, input.target);
      if (seen !== target.fingerprint) {
        throw new HttpError(409, 'snapshot-moved', `the snapshot moved and ${input.target.kind} ${input.target.id} changed since snapshot ${String(input.snapshotId)}`);
      }
    }

    const at = deps.now();
    const mark = db.transaction(() => {
      const written = db.review.upsert({
        changeId: change.id,
        target: input.target,
        filePath: target.filePath,
        mark: input.mark,
        note: input.note,
        lines: input.lines,
        fingerprint: target.fingerprint,
        snapshotId: snapshot.id,
        at: at.toISOString(),
      });
      recordWrite(at, change, true);
      return written;
    });
    signal(change.repoId, change.id);
    return { mark: publicMark(mark), progress: progressOf(change.id, report).progress };
  });

  http.delete<{ Params: IdParams; Querystring: Query }>('/api/changes/:id/review/marks', (request, reply) => {
    const change = changeOf(request.params.id);
    const kind = parseTargetKind(request.query.kind);
    const targetId = parseTargetId(request.query.id);
    if (kind === null) throw badRequest("kind must be 'file' or 'symbol'");
    if (targetId === null) throw badRequest('id must be given once, as a non-empty string');
    const ref: TargetRef = { kind, id: targetId };
    const at = deps.now();
    const removed = db.transaction(() => {
      if (!db.review.remove(change.id, ref)) return false;
      recordWrite(at, change, false);
      return true;
    });
    if (!removed) throw new HttpError(404, 'not-found', `no mark on ${kind} ${targetId}`);
    signal(change.repoId, change.id);
    return reply.status(204).send();
  });

  http.put<{ Params: IdParams; Body: unknown }>('/api/changes/:id/review/note', (request) => {
    const change = changeOf(request.params.id);
    const parsed = validateGeneralNote(request.body);
    if (!parsed.ok) throw badRequest(parsed.message);
    if (change.archivedAt !== null) throw new HttpError(409, 'archived', `change ${String(change.id)} is archived`);
    const at = deps.now();
    const note = db.transaction(() => {
      const stored = db.review.setNote(change.id, parsed.value, at.toISOString());
      recordWrite(at, change, false);
      return stored;
    });
    signal(change.repoId, change.id);
    return { note };
  });

  http.get<{ Params: IdParams }>('/api/changes/:id/review/summary', (request, reply) => {
    const change = changeOf(request.params.id);
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null) throw new HttpError(409, 'no-snapshot', `change ${String(change.id)} has no snapshot yet`);
    const text = renderSummary({
      ref: change.ref,
      repoName: db.repos.get(change.repoId)?.name ?? '',
      head: snapshot.head,
      note: db.review.note(change.id),
      report: JSON.parse(snapshot.report) as Report,
      marks: db.review.list(change.id),
    });
    return reply.type('text/markdown; charset=utf-8').send(text);
  });
}
