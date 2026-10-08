// Approve in the top bar (SPEC.md section 6, ADR-036), pure: no DOM, unit-tested
// in Node. The gate is the daemon's: the review progress it computes says how
// many touched tier 1 files have a current mark (`progress.tier1`), and the
// daemon checks the same rule again when Approve is sent. This only maps those
// answers, the review state and what the reviewer is doing (confirming, a
// request in flight, a refusal) to what the bar draws.

import type { ReviewProgress } from '../../../../core/model/types.js';
import { shortDate, shortSha } from '../../../shared/format.js';
import type { ApprovalStatus } from '../ports.js';

export const APPROVE_WAITING = 'Approve when tier 1 is read';
export const APPROVE = 'Approve';
export const CONFIRM_APPROVE = 'Confirm approve';
export const CANCEL = 'Cancel';
export const UNDO_APPROVE = 'Undo approve';
/** A request that got no answer: no daemon, a dropped connection. */
export const APPROVE_FAILED = 'The daemon did not answer. Try again once it is back.';
export const NO_REVIEW_STATE = 'The review marks of this change have not loaded yet';

/** Whether Approve may be offered, and why, from the daemon's progress. Null progress (not loaded, no snapshot): closed. */
export function approveGate(progress: Pick<ReviewProgress, 'tier1'> | null): { open: boolean; reason: string } {
  if (progress === null) return { open: false, reason: NO_REVIEW_STATE };
  const { done, total } = progress.tier1;
  if (total === 0) return { open: true, reason: 'No tier 1 file is touched in this change' };
  if (done >= total) return { open: true, reason: `All ${String(total)} touched tier 1 ${total === 1 ? 'file has' : 'files have'} a current review mark` };
  return { open: false, reason: `${String(done)} of ${String(total)} touched tier 1 files have a current review mark` };
}

export interface ApproveInput {
  status: ApprovalStatus | null;
  progress: Pick<ReviewProgress, 'tier1'> | null;
  /** The reviewer clicked Approve and is asked to confirm. */
  confirming: boolean;
  /** A request in flight. */
  pending: 'approve' | 'undo' | null;
  /** The reason of the last refusal, shown until the next action. */
  error: string | null;
}

export type ApproveView =
  | { kind: 'hidden' }
  | { kind: 'gate'; open: boolean; label: string; title: string; error: string | null }
  | { kind: 'confirm'; prompt: string; title: string; pending: boolean }
  | { kind: 'approved'; head: string; title: string; pending: boolean; error: string | null };

export function approveView(input: ApproveInput): ApproveView {
  const { status, error } = input;
  if (status === null) return { kind: 'hidden' };
  if (status.reviewState === 'approved' && input.pending !== 'approve') {
    const approvedHead = status.approvedHead ?? status.head;
    const when = status.approvedAt === null ? '' : ` on ${shortDate(status.approvedAt)}`;
    return { kind: 'approved', head: shortSha(approvedHead), title: `Approved at ${approvedHead}${when}`, pending: input.pending === 'undo', error };
  }
  const gate = approveGate(input.progress);
  if (input.pending === 'approve' || (input.confirming && gate.open)) {
    return { kind: 'confirm', prompt: `Approve ${shortSha(status.head)}?`, title: `Approve the change at ${status.head}`, pending: input.pending === 'approve' };
  }
  return { kind: 'gate', open: gate.open, label: gate.open ? APPROVE : APPROVE_WAITING, title: gate.reason, error };
}
