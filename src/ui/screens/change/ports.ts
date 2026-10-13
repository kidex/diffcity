// The optional interfaces the change screen takes (ADR-026). Types only: the
// screen works fully without any of them (ADR-002), and the SPA builds the
// ones it has data for in src/ui/app/ from src/ui/data/. The HTML export
// passes none.

import type { AgentRunsResponse, FileDiff, ReviewMark, ReviewMarkValue, ReviewProgress, SessionsResponse } from '../../../core/model/types.js';

/**
 * What the file view reads to show the diff of one file (ADR-027). Structurally
 * the port of src/ui/data/diff-port.ts, which the SPA builds; the screen never
 * imports src/ui/data. Without it the file view shows only the Report's step
 * diffs, with "Full diff is available in the app".
 */
export interface DiffPort {
  /**
   * The diff of file `path` (a `File.id`) of the latest snapshot; with `symbolId`
   * (a `Symbol.id` of that file) the answer also carries `focus`.
   */
  fileDiff(path: string, symbolId?: string, signal?: AbortSignal): Promise<FileDiff>;
}

/** The marks, general note and progress of a change (ADR-028). */
export interface ReviewState {
  snapshotId: number;
  marks: ReviewMark[];
  note: string | null;
  progress: ReviewProgress;
}

/** A mark to make: the snapshot is the one the reviewer is looking at. */
export interface MarkRequest {
  snapshotId: number;
  target: { kind: 'file' | 'symbol'; id: string };
  mark: ReviewMarkValue;
  note?: string;
  lines?: { side: 'old' | 'new'; start: number; end: number };
}

/**
 * What the screen reads and writes of the review marks (ADR-028). Structurally
 * the port of src/ui/data/review-port.ts. Without it there are no mark buttons,
 * no progress and no "hide checked".
 */
export interface ReviewPort {
  /** The marks, note and progress now; null while the change has no snapshot. */
  load(signal?: AbortSignal): Promise<ReviewState | null>;
  setMark(request: MarkRequest): Promise<{ mark: ReviewMark; progress: ReviewProgress }>;
  clearMark(target: MarkRequest['target']): Promise<void>;
  setNote(note: string): Promise<{ note: string | null }>;
  /** The markdown summary of the "Needs rewrite" marks; null while there is no snapshot. */
  summary(signal?: AbortSignal): Promise<string | null>;
  /** Calls `listener` when the marks of this change moved; returns the function that stops it. */
  onChange(listener: () => void): () => void;
}

/** One repo in the Fleet card: the mockup's `name  age  bar` row. */
export interface FleetCardRow {
  name: string;
  /** What the row says about the audit, as shown: `3 days`, `47 days, 3 new CVEs`. */
  age: string;
  /** Red above 30 days or with new CVEs, amber in between, green when fresh. */
  level: 'fresh' | 'aging' | 'stale';
  /** Bar fill, 0 to 1 (age against the 30-day limit). */
  fill: number;
}

/** The last audit of the other repos (SPEC.md section 6, "Fleet (card)"). */
export interface FleetCard {
  rows: FleetCardRow[];
  /** All projects, for "all N projects". */
  total: number;
}

/** Without a FleetPort the card is hidden. */
export interface FleetPort {
  /** The card now; null hides it (nothing to show). */
  card(): FleetCard | null;
  /** Calls `listener` when the card changes; returns the function that stops it. */
  onChange(listener: () => void): () => void;
  /** "all N projects": goes to the Fleet screen. */
  open(): void;
}

/** A finding action the daemon answered with an error (a 409 refusal, 404, 403, ...): its code and the message to show. */
export interface FindingRefusal {
  code: string;
  message: string;
}

/** The daemon's answer to a finding action (`at`: when it arrived, `performance.now()`), or its error. */
export type FindingAnswer<T> = { ok: true; value: T; at: number } | { ok: false; refusal: FindingRefusal };

/**
 * "Ask agent to fix" and "Mark as intended" (ADR-036). Structurally the port of
 * src/ui/data/findings-port.ts. Only a request that got no answer (no daemon,
 * a dropped connection) rejects. Without it the finding cards have no action buttons: the HTML
 * export shows the findings and their state only.
 */
export interface FindingsPort {
  /** Writes finding `key` (a `Finding.id`) to the fix queue; `queued` is false when it was already there. */
  ask(key: string): Promise<FindingAnswer<{ key: string; queued: boolean; count: number }>>;
  /** Sets the state of finding `key`: `intended`, or back to `open` (the undo). */
  setState(key: string, state: 'open' | 'intended'): Promise<FindingAnswer<{ key: string; state: 'open' | 'intended'; keys: string[] }>>;
}

/** Where the change stands on Approve (ADR-036), as the daemon last said. */
export interface ApprovalStatus {
  reviewState: 'unreviewed' | 'in-review' | 'approved';
  /** The change's head commit now. */
  head: string;
  /** The head that was approved; null unless approved. */
  approvedHead: string | null;
  /** When it was approved (ISO); null unless approved. */
  approvedAt: string | null;
}

/** The daemon's answer to Approve and to its undo. */
export interface ApprovalResult {
  reviewState: 'approved' | 'in-review';
  approvedHead: string | null;
  approvedAt: string | null;
}

/**
 * The touched tier 1 files without a current mark, as the daemon listed them
 * for "Check the rest and approve" (ADR-028 amendment, DC-135), with what binds
 * the confirmation to that list: sent back exactly as it came.
 */
export interface RemainingFiles {
  snapshotId: number;
  head: string;
  files: string[];
  token: string;
}

/** The daemon's answer to "Check the rest and approve": the approval and the paths it marked Checked. */
export interface CheckRestResult extends ApprovalResult {
  marked: string[];
}

/**
 * Approve and its undo (ADR-036). Structurally the port of
 * src/ui/data/approval-port.ts. The daemon checks the gate; a refusal
 * (`tier1-unchecked`, `snapshot-pending`, `archived`, ...) comes back as one.
 * Only a request that got no answer rejects. Without it the top bar has no
 * Approve button: the HTML export cannot approve.
 */
export interface ApprovalPort {
  /** What the daemon last said about the change; null while it is not known or the change is archived (no button). */
  status(): ApprovalStatus | null;
  /** Calls `listener` when status() changed; returns the function that stops it. */
  onChange(listener: () => void): () => void;
  approve(): Promise<FindingAnswer<ApprovalResult>>;
  /** The files "Check the rest and approve" would mark, for its confirmation. */
  remaining(): Promise<FindingAnswer<RemainingFiles>>;
  /**
   * "Check the rest and approve", confirmed on `shown` (the answer of remaining(), unchanged): the daemon
   * marks those files Checked and approves in one request, or refuses (`snapshot-moved`, `remaining-changed`, ...).
   */
  checkRest(shown: RemainingFiles): Promise<FindingAnswer<CheckRestResult>>;
  /** Undo: back to `in-review`. */
  unapprove(): Promise<FindingAnswer<ApprovalResult>>;
}

/**
 * The Claude Code sessions linked to the change (ADR-038), for the panel's
 * Session tab. Structurally the port of src/ui/data/sessions-port.ts.
 * Sessions are not part of the Report: without the port (the HTML export, the
 * standalone page) there is no Session tab.
 */
export interface SessionsPort {
  /** The sessions now, newest first; null when the daemon will not give them (no tab). Rejects when it did not answer: the tab keeps what it shows. */
  load(signal?: AbortSignal): Promise<SessionsResponse | null>;
  /** Calls `listener` when the sessions of this change may have moved; returns the function that stops it. */
  onChange(listener: () => void): () => void;
}

/** What "Send review to agent" would run (ADR-029), as the daemon previewed it. Structurally `AgentPreview` of src/ui/data/api.ts. */
export interface AgentPreview {
  mode: 'resume' | 'new' | null;
  /** The argv as it would run, the resolved claude binary first; null when it cannot be built. */
  argv: string[] | null;
  cwd: string | null;
  sessionId: string | null;
  session: { sessionId: string; title: string | null; firstAt: string | null; lastAt: string | null } | null;
  newSessionReason: string | null;
  permissionMode: string | null;
  timeoutMinutes: number;
  summary: string;
  summaryHash: string;
  refusals: FindingRefusal[];
  /** The confirmation token; null while anything is refused. */
  token: string | null;
}

/**
 * "Send review to agent" (ADR-029). Structurally the port of
 * src/ui/data/agent-port.ts. Every decision is the daemon's: the command, the
 * session, the refusals and the run's state. Only a request that got no answer
 * rejects. Without it (the HTML export, the standalone page) there is no
 * Send action and no agent run status.
 */
export interface AgentPort {
  preview(): Promise<FindingAnswer<AgentPreview>>;
  /** Runs what `preview()` showed, bound by its token and summary hash. */
  run(token: string, summaryHash: string): Promise<FindingAnswer<{ runId: string }>>;
  /** The fallback: the previewed summary as one fix-queue item for /diffcity-review; nothing runs. */
  queue(summaryHash: string): Promise<FindingAnswer<{ key: string; queued: boolean; count: number }>>;
  /** The run in progress or the latest one; null when the daemon will not say (no status). Rejects without an answer. */
  runs(signal?: AbortSignal): Promise<AgentRunsResponse | null>;
  /** Calls `listener` when an agent run of this change started or ended, and after a reconnect; returns the function that stops it. */
  onRun(listener: () => void): () => void;
}
