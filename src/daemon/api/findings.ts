// The findings actions and Approve (ADR-036). Every route here writes, so the
// server's write guard (ADR-028: own Origin, no cross-site Fetch metadata,
// JSON) runs first; an archived change is refused. The finding a key names,
// the Approve gate and the fix-queue item are computed in src/core from the
// latest snapshot and the stored data, never taken from the request.
//
//   PUT    /api/changes/:id/findings/:key/state   { state: 'open' | 'intended' }
//   POST   /api/changes/:id/findings/:key/fix
//   POST   /api/changes/:id/approve
//   DELETE /api/changes/:id/approve

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../core/db/index.js';
import { appendToFixQueue, fixQueueItem, fixQueueRoot } from '../../core/fix-queue/index.js';
import type { ChangeRecord, SseEvent } from '../../core/model/types.js';
import type { Report } from '../../core/report/types.js';
import { uncheckedTier1Files } from '../../core/review/index.js';
import { resolveFinding, stateTargets, type ResolvedFinding } from '../../core/served/index.js';
import { HttpError } from '../http/errors.js';
import { recordReviewActivity } from './activity.js';
import { parseId } from './params.js';

export interface FindingsDeps {
  db: Db;
  broadcast: (event: SseEvent) => void;
  now: () => Date;
}

interface KeyParams {
  id: string;
  key: string;
}

interface IdParams {
  id: string;
}

/** A finding key is `f:<16 hex>` or a rule finding id; anything longer than this is not one. */
export const FINDING_KEY_MAX = 512;

/** How many unchecked tier 1 paths the refusal names. */
const LISTED_PATHS = 5;

export interface StateAnswer {
  key: string;
  state: 'open' | 'intended';
  /** The stored findings the state was written to: the rule finding id, or every imported part of the served entry. */
  keys: string[];
}

export interface FixAnswer {
  /** The key of the queued item: the served entry's id. */
  key: string;
  /** False when the key was already in the queue (nothing was written). */
  queued: boolean;
  /** Items in the queue after the request. */
  count: number;
}

export interface ApprovalAnswer {
  reviewState: 'approved' | 'in-review';
  approvedHead: string | null;
  approvedAt: string | null;
}

function parseState(body: unknown): 'open' | 'intended' {
  const state = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)['state'] : undefined;
  if (state !== 'open' && state !== 'intended') throw new HttpError(400, 'bad-request', "the body must be { state: 'open' | 'intended' }");
  return state;
}

function parseKey(key: string): string {
  if (key.length === 0 || key.length > FINDING_KEY_MAX) {
    throw new HttpError(400, 'bad-request', `key must be a string of 1 to ${String(FINDING_KEY_MAX)} characters`);
  }
  return key;
}

export function registerFindingsRoutes(http: FastifyInstance, deps: FindingsDeps): void {
  const { db } = deps;

  const changeOf = (rawId: string): ChangeRecord => {
    const id = parseId('id', rawId);
    const change = db.changes.get(id);
    if (change === null) throw new HttpError(404, 'not-found', `change ${String(id)} not found`);
    return change;
  };

  const notArchived = (change: ChangeRecord): void => {
    if (change.archivedAt !== null) throw new HttpError(409, 'archived', `change ${String(change.id)} is archived`);
  };

  /** The latest snapshot's head and Report; 409 `no-snapshot` while there is none. */
  const latestOf = (change: ChangeRecord): { head: string; report: Report } => {
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null) throw new HttpError(409, 'no-snapshot', `change ${String(change.id)} has no snapshot yet`);
    return { head: snapshot.head, report: JSON.parse(snapshot.report) as Report };
  };

  const findingOf = (change: ChangeRecord, report: Report, key: string): ResolvedFinding => {
    const resolved = resolveFinding(report, { stored: db.findings.list(change.id), ruleStates: db.findings.ruleStates(change.id) }, key);
    if (resolved === null) throw new HttpError(404, 'finding-not-found', `no finding ${key} in change ${String(change.id)}`);
    return resolved;
  };

  const signal = (change: ChangeRecord, events: readonly ('findings' | 'review' | 'changes')[]): void => {
    for (const event of events) {
      deps.broadcast(
        event === 'changes'
          ? { event, data: { repoId: change.repoId } }
          : { event, data: { repoId: change.repoId, changeId: change.id } },
      );
    }
  };

  http.put<{ Params: KeyParams; Body: unknown }>('/api/changes/:id/findings/:key/state', (request): StateAnswer => {
    const change = changeOf(request.params.id);
    const state = parseState(request.body);
    const key = parseKey(request.params.key);
    notArchived(change);
    const { head, report } = latestOf(change);
    const resolved = findingOf(change, report, key);
    const at = deps.now();
    const keys = db.transaction(() => {
      let written: string[];
      if (resolved.origin === 'rule') {
        db.findings.setRuleState(change.id, key, head, state, at.toISOString());
        written = [key];
      } else {
        written = stateTargets(resolved.parts);
        db.findings.setStates(change.id, written, state, at.toISOString());
      }
      // A `review` event (coalesced like marks), never an `import` one.
      recordReviewActivity(db, change, at);
      return written;
    });
    signal(change, ['findings', 'changes']);
    return { key, state, keys };
  });

  http.post<{ Params: KeyParams }>('/api/changes/:id/findings/:key/fix', (request, reply) => {
    const change = changeOf(request.params.id);
    const key = parseKey(request.params.key);
    notArchived(change);
    const { report } = latestOf(change);
    const resolved = findingOf(change, report, key);
    const item = fixQueueItem(report, resolved.finding, deps.now().toISOString());
    const result = appendToFixQueue(fixQueueRoot(change), item);
    if (!result.ok) throw new HttpError(409, result.code, result.message);
    signal(change, ['findings']);
    const answer: FixAnswer = { key: item.key, queued: result.queued, count: result.count };
    return reply.send(answer);
  });

  http.post<{ Params: IdParams }>('/api/changes/:id/approve', (request): ApprovalAnswer => {
    const change = changeOf(request.params.id);
    notArchived(change);
    // Whatever the request carries, the gate is computed here from the latest snapshot and the stored marks.
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null) throw new HttpError(409, 'no-snapshot', `change ${String(change.id)} has no snapshot yet`);
    if (snapshot.head !== change.head) {
      throw new HttpError(409, 'snapshot-pending', `change ${String(change.id)} moved to a head whose snapshot is not computed yet`);
    }
    const unchecked = uncheckedTier1Files(JSON.parse(snapshot.report) as Report, db.review.list(change.id));
    if (unchecked.length > 0) {
      const listed = unchecked.slice(0, LISTED_PATHS).join(', ');
      const more = unchecked.length > LISTED_PATHS ? ` and ${String(unchecked.length - LISTED_PATHS)} more` : '';
      throw new HttpError(409, 'tier1-unchecked', `${String(unchecked.length)} touched tier 1 file(s) have no current review mark: ${listed}${more}`);
    }
    const current = db.changes.approval(change.id);
    if (change.reviewState === 'approved' && current?.approvedHead === change.head) {
      return { reviewState: 'approved', approvedHead: current.approvedHead, approvedAt: current.approvedAt };
    }
    const at = deps.now();
    const approvedAt = at.toISOString();
    db.transaction(() => {
      recordReviewActivity(db, change, at, 'approved');
      db.changes.setApproval(change.id, { approvedHead: change.head, approvedAt });
    });
    signal(change, ['review', 'changes']);
    return { reviewState: 'approved', approvedHead: change.head, approvedAt };
  });

  http.delete<{ Params: IdParams }>('/api/changes/:id/approve', (request): ApprovalAnswer => {
    const change = changeOf(request.params.id);
    notArchived(change);
    if (change.reviewState !== 'approved') throw new HttpError(409, 'not-approved', `change ${String(change.id)} is not approved`);
    const at = deps.now();
    db.transaction(() => {
      recordReviewActivity(db, change, at, 'in-review');
      db.changes.setApproval(change.id, { approvedHead: null, approvedAt: null });
    });
    signal(change, ['review', 'changes']);
    return { reviewState: 'in-review', approvedHead: null, approvedAt: null };
  });
}
