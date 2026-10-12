// The findings actions and Approve (ADR-036). Every write here goes through the
// server's write guard (ADR-028: own Origin, no cross-site Fetch metadata,
// JSON) first; the one GET checks the origin itself. An archived change is
// refused. The finding a key names, the Approve gate, the files "Check the
// rest" marks and the fix-queue item are computed in src/core from the latest
// snapshot and the stored data, never taken from the request.
//
//   PUT    /api/changes/:id/findings/:key/state   { state: 'open' | 'intended' }
//   POST   /api/changes/:id/findings/:key/fix
//   POST   /api/changes/:id/approve                [{ checkRemaining: true, snapshotId, files? }]
//   DELETE /api/changes/:id/approve
//   GET    /api/changes/:id/approve/remaining  -> { snapshotId, head, files }
//
// "Check the rest and approve" (ADR-028 amendment, DC-135): with
// `checkRemaining: true`, one transaction marks every touched tier 1 file
// without a current mark as Checked, against the snapshot the reviewer saw
// (`snapshotId`; 409 `snapshot-moved` when a newer one exists), then approves
// through the unchanged gate. `files`, when given, is the list the confirmation
// showed; 409 `remaining-changed` when the server would mark other files.

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../core/db/index.js';
import { appendToFixQueue, fixQueueItem, fixQueueRoot } from '../../core/fix-queue/index.js';
import type { ChangeRecord, SseEvent } from '../../core/model/types.js';
import type { Report } from '../../core/report/types.js';
import type { Fingerprints } from '../../core/model/types.js';
import { checkRemainingPlan, uncheckedTier1Files } from '../../core/review/index.js';
import { resolveFinding, stateTargets, type ResolvedFinding } from '../../core/served/index.js';
import { HttpError } from '../http/errors.js';
import { recordReviewActivity } from './activity.js';
import { isSameOrigin } from './origin.js';
import { parseId } from './params.js';

export interface FindingsDeps {
  db: Db;
  broadcast: (event: SseEvent) => void;
  now: () => Date;
  /** The daemon's HTTP port, read per request, for the origin check of the GET. */
  port: () => number;
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

/** The answer of POST /approve with `checkRemaining`: the approval and the paths it marked Checked. */
export interface CheckRemainingAnswer extends ApprovalAnswer {
  marked: string[];
}

/** GET /approve/remaining: what the confirmation of "Check the rest and approve" lists. */
export interface RemainingAnswer {
  /** The snapshot the list is computed from; the confirmation sends it back. */
  snapshotId: number;
  head: string;
  /** The touched tier 1 files without a current mark, in `tier1Files` order. */
  files: string[];
}

interface CheckRemainingInput {
  snapshotId: number;
  files: string[] | null;
}

/** The body of POST /approve: null for the plain Approve, the bulk input with `checkRemaining: true`. */
function parseApproveBody(body: unknown): CheckRemainingInput | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const flag = record['checkRemaining'];
  if (flag === undefined || flag === false) return null;
  if (flag !== true) throw new HttpError(400, 'bad-request', 'checkRemaining must be a boolean');
  const snapshotId = record['snapshotId'];
  if (typeof snapshotId !== 'number' || !Number.isSafeInteger(snapshotId) || snapshotId < 1) {
    throw new HttpError(400, 'bad-request', 'snapshotId must be a positive integer');
  }
  const files = record['files'];
  if (files === undefined || files === null) return { snapshotId, files: null };
  if (!Array.isArray(files) || !files.every((path): path is string => typeof path === 'string')) {
    throw new HttpError(400, 'bad-request', 'files must be a list of paths');
  }
  return { snapshotId, files };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((path, index) => path === b[index]);

function uncheckedError(unchecked: readonly string[]): HttpError {
  const listed = unchecked.slice(0, LISTED_PATHS).join(', ');
  const more = unchecked.length > LISTED_PATHS ? ` and ${String(unchecked.length - LISTED_PATHS)} more` : '';
  return new HttpError(409, 'tier1-unchecked', `${String(unchecked.length)} touched tier 1 file(s) have no current review mark: ${listed}${more}`);
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

  const signal = (change: ChangeRecord, events: readonly ('findings' | 'review' | 'changes' | 'repo')[]): void => {
    for (const event of events) {
      deps.broadcast(
        event === 'changes' || event === 'repo'
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
    // The Report, the listed counts and the repo's highFindings (Fleet) moved (DC-106).
    signal(change, ['findings', 'changes', 'repo']);
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

  /** The latest snapshot, which must be the one of the change's head (409 `no-snapshot`, `snapshot-pending`). */
  const approvableSnapshot = (change: ChangeRecord) => {
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null) throw new HttpError(409, 'no-snapshot', `change ${String(change.id)} has no snapshot yet`);
    if (snapshot.head !== change.head) {
      throw new HttpError(409, 'snapshot-pending', `change ${String(change.id)} moved to a head whose snapshot is not computed yet`);
    }
    return snapshot;
  };

  /** Approves `change` at its head, unless it already is; run inside the caller's transaction or alone. */
  const approve = (change: ChangeRecord): { answer: ApprovalAnswer; wrote: boolean } => {
    const current = db.changes.approval(change.id);
    if (change.reviewState === 'approved' && current?.approvedHead === change.head) {
      return { answer: { reviewState: 'approved', approvedHead: current.approvedHead, approvedAt: current.approvedAt }, wrote: false };
    }
    const at = deps.now();
    const approvedAt = at.toISOString();
    db.transaction(() => {
      recordReviewActivity(db, change, at, 'approved');
      db.changes.setApproval(change.id, { approvedHead: change.head, approvedAt });
    });
    return { answer: { reviewState: 'approved', approvedHead: change.head, approvedAt }, wrote: true };
  };

  /** "Check the rest and approve": the marks and the approval in one transaction, every check done again inside it. */
  const checkRemainingAndApprove = (changeId: number, input: CheckRemainingInput): { answer: CheckRemainingAnswer; wrote: boolean } =>
    db.transaction(() => {
      const change = db.changes.get(changeId);
      if (change === null) throw new HttpError(404, 'not-found', `change ${String(changeId)} not found`);
      notArchived(change);
      const snapshot = approvableSnapshot(change);
      if (snapshot.id !== input.snapshotId) {
        throw new HttpError(409, 'snapshot-moved', `the change has a newer snapshot than ${String(input.snapshotId)}; look again before approving`);
      }
      const report = JSON.parse(snapshot.report) as Report;
      const fingerprints: Fingerprints = snapshot.fingerprints === null ? { files: {}, symbols: {} } : (JSON.parse(snapshot.fingerprints) as Fingerprints);
      const plan = checkRemainingPlan(report, fingerprints, db.review.list(change.id));
      if (input.files !== null && !sameList(input.files, plan.files)) {
        throw new HttpError(409, 'remaining-changed', 'the files without a mark are not the ones the confirmation listed; look again');
      }
      if (plan.unmarkable.length > 0) throw uncheckedError(plan.unmarkable);
      const at = deps.now();
      for (const mark of plan.marks) {
        db.review.upsert({
          changeId: change.id,
          target: mark.target,
          filePath: mark.filePath,
          mark: 'checked',
          note: null,
          lines: null,
          fingerprint: mark.fingerprint,
          snapshotId: snapshot.id,
          at: at.toISOString(),
        });
      }
      // The gate of section 6, unchanged, on what is stored now.
      const unchecked = uncheckedTier1Files(report, db.review.list(change.id));
      if (unchecked.length > 0) throw uncheckedError(unchecked);
      const { answer, wrote } = approve(change);
      return { answer: { ...answer, marked: plan.marks.map((mark) => mark.filePath) }, wrote: wrote || plan.marks.length > 0 };
    });

  http.post<{ Params: IdParams; Body: unknown }>('/api/changes/:id/approve', (request): ApprovalAnswer | CheckRemainingAnswer => {
    const change = changeOf(request.params.id);
    notArchived(change);
    const bulk = parseApproveBody(request.body);
    if (bulk !== null) {
      const { answer, wrote } = checkRemainingAndApprove(change.id, bulk);
      if (wrote) signal(change, ['review', 'changes']);
      return answer;
    }
    // Whatever else the request carries, the gate is computed here from the latest snapshot and the stored marks.
    const snapshot = approvableSnapshot(change);
    const unchecked = uncheckedTier1Files(JSON.parse(snapshot.report) as Report, db.review.list(change.id));
    if (unchecked.length > 0) throw uncheckedError(unchecked);
    const { answer, wrote } = approve(change);
    if (wrote) signal(change, ['review', 'changes']);
    return answer;
  });

  http.get<{ Params: IdParams }>('/api/changes/:id/approve/remaining', (request, reply): RemainingAnswer => {
    reply.header('cache-control', 'no-store');
    if (!isSameOrigin(request, deps.port())) throw new HttpError(403, 'cross-site', 'the approval check is for the daemon page only');
    const change = changeOf(request.params.id);
    notArchived(change);
    const snapshot = approvableSnapshot(change);
    return { snapshotId: snapshot.id, head: snapshot.head, files: uncheckedTier1Files(JSON.parse(snapshot.report) as Report, db.review.list(change.id)) };
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
