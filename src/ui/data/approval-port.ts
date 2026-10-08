// The ApprovalPort (ADR-036): Approve and its undo on one change, without the
// screen knowing about the daemon. The SPA builds it from the API client and
// feeds it each change summary the route loads; the change screen takes it as
// optional and the HTML export passes none (ADR-002). Nothing is decided here:
// the daemon checks the gate and keeps the review state, and reconciles it
// when the head moves (ADR-019).

import type { ChangeSummary } from '../../core/model/types.js';
import type { Api, ApprovalAnswer } from './api.js';
import type { FindingAnswer } from './findings-port.js';
import { answer } from './findings-port.js';

/** Where the change stands on Approve, as the daemon last said. */
export interface ApprovalStatus {
  reviewState: ChangeSummary['reviewState'];
  head: string;
  approvedHead: string | null;
  approvedAt: string | null;
}

export interface ApprovalPort {
  status(): ApprovalStatus | null;
  onChange(listener: () => void): () => void;
  approve(): Promise<FindingAnswer<ApprovalAnswer>>;
  unapprove(): Promise<FindingAnswer<ApprovalAnswer>>;
}

export interface RouteApprovalPort extends ApprovalPort {
  /**
   * The change as the route loaded it; `startedAt` is when that fetch began
   * (`performance.now()`). A summary fetched before the last write was answered
   * is older than what the write said, so it is ignored.
   */
  show(change: ChangeSummary, startedAt: number): void;
}

const same = (a: ApprovalStatus | null, b: ApprovalStatus | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.reviewState === b.reviewState && a.head === b.head && a.approvedHead === b.approvedHead && a.approvedAt === b.approvedAt);

/** The port of one change. `written` runs after every accepted write, so the route refetches without waiting for SSE `changes`. */
export function createApprovalPort(api: Api, changeId: number, written: () => void = () => undefined): RouteApprovalPort {
  let current: ApprovalStatus | null = null;
  let answeredAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<() => void>();

  const set = (next: ApprovalStatus | null): void => {
    if (same(current, next)) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };

  const settle = (result: FindingAnswer<ApprovalAnswer>): FindingAnswer<ApprovalAnswer> => {
    if (!result.ok) return result;
    answeredAt = result.at;
    if (current !== null) set({ ...current, ...result.value });
    written();
    return result;
  };

  return {
    status: () => current,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    approve: async () => settle(await answer(api.approve(changeId))),
    unapprove: async () => settle(await answer(api.unapprove(changeId))),
    show(change, startedAt) {
      if (startedAt < answeredAt) return;
      // An archived change cannot be approved or undone: no button.
      set(
        change.archivedAt !== null
          ? null
          : { reviewState: change.reviewState, head: change.head, approvedHead: change.approvedHead, approvedAt: change.approvedAt },
      );
    },
  };
}
