// Approve in the top bar (SPEC.md section 6, ADR-036), pure: no DOM, unit-tested
// in Node. The gate is the daemon's: the review progress it computes says how
// many touched tier 1 files have a current mark (`progress.tier1`), and the
// daemon checks the same rule again when Approve is sent. This only maps those
// answers, the review state and what the reviewer is doing (confirming, a
// request in flight, a refusal) to what the bar draws.
//
// "Check the rest and approve" (ADR-028 amendment, DC-135/DC-136): while some
// touched tier 1 files have no current mark, the button offers it instead of
// waiting. Its confirmation lists the files the daemon named; once confirmed
// the daemon marks them Checked and approves, checking everything itself.

import type { ReviewProgress } from '../../../../core/model/types.js';
import { plural, shortDate, shortSha } from '../../../shared/format.js';
import type { ApprovalStatus } from '../ports.js';

export const APPROVE_WAITING = 'Approve when tier 1 is read';
export const APPROVE = 'Approve';
export const CONFIRM_APPROVE = 'Confirm approve';
export const CANCEL = 'Cancel';
export const UNDO_APPROVE = 'Undo approve';
/** A request that got no answer: no daemon, a dropped connection. */
export const APPROVE_FAILED = 'The daemon did not answer. Try again once it is back.';
export const CHECK_REST = 'Check the rest and approve';
/** The confirmation's list went stale under it: the daemon was asked again. */
export const CHECK_REST_MOVED = 'The change moved since the list was shown. This is the list as it is now: look again before approving.';
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
  /** "Check the rest and approve" can be offered (the port has it). */
  checkRest?: boolean;
}

export type ApproveView =
  | { kind: 'hidden' }
  /** `bulk`: the button is "Check the rest and approve", which opens its confirmation. */
  | { kind: 'gate'; open: boolean; bulk: boolean; label: string; title: string; error: string | null }
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
  // Tier 1 files left unmarked: offered as one confirmed action, never decided here (the daemon checks every mark).
  if (!gate.open && input.checkRest === true && input.progress !== null && input.pending === null) {
    return { kind: 'gate', open: true, bulk: true, label: CHECK_REST, title: `${gate.reason}: check the rest after a confirmation that lists them`, error };
  }
  return { kind: 'gate', open: gate.open, bulk: false, label: gate.open ? APPROVE : APPROVE_WAITING, title: gate.reason, error };
}

export interface CheckRestView {
  title: string;
  /** What confirming does, in one sentence. */
  lede: string;
  files: string[];
  confirm: string;
}

/** The confirmation of "Check the rest and approve" for the daemon's list `files` at `head`. */
export function checkRestView(remaining: { head: string; files: string[] }): CheckRestView {
  const sha = shortSha(remaining.head);
  const count = remaining.files.length;
  if (count === 0) {
    return { title: CHECK_REST, lede: `Every touched tier 1 file has a current mark now. Confirm to approve the change at ${sha}.`, files: [], confirm: `Approve ${sha}` };
  }
  const them = count === 1 ? 'it' : 'them';
  return {
    title: CHECK_REST,
    lede: `${plural(count, 'touched tier 1 file')} ${count === 1 ? 'has' : 'have'} no current mark. Confirming marks ${them} Checked and approves the change at ${sha}.`,
    files: remaining.files,
    confirm: `Check ${plural(count, 'file')} and approve`,
  };
}

/** The refusals of "Check the rest and approve" that mean the list is stale: ask the daemon again and show it again. */
export const isStaleList = (code: string): boolean => code === 'snapshot-moved' || code === 'remaining-changed';
