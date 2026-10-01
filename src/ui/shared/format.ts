// Display labels and times. Formatting only: every value shown comes from the
// API or the Report as it is (ADR-022).

import type { ArchiveReason, ChangeKind, ChangeSummary, EventType, ReviewState } from '../../core/model/types.js';
import type { Status, Verdict } from '../../core/report/types.js';

/** The label of a change in the list (SPEC.md section 3a): Draft, Branch or PR #N. */
export function kindLabel(change: Pick<ChangeSummary, 'kind' | 'prNumber'>): string {
  switch (change.kind) {
    case 'draft':
      return 'Draft';
    case 'branch':
      return 'Branch';
    case 'pr':
      return change.prNumber === null ? 'PR' : `PR #${String(change.prNumber)}`;
  }
}

const REF_PREFIX: Record<ChangeKind, string> = { draft: 'draft:', branch: 'branch:', pr: 'pr:' };

/**
 * The short name of a change: the branch name for a Branch, the title for a
 * Draft or a PR (their ref is a worktree path or a number, ADR-019).
 */
export function changeName(change: Pick<ChangeSummary, 'kind' | 'ref' | 'title'>): string {
  const prefix = REF_PREFIX[change.kind];
  if (change.kind === 'branch' && change.ref.startsWith(prefix)) return change.ref.slice(prefix.length);
  return change.title;
}

/** `1 commit`, `4 commits`. */
export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : pluralNoun}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Relative time in the mockup's style: `just now`, `41 min ago`, `3 h ago`,
 * `1 day ago`, `19 days ago`. A time in the future (clock skew) reads `just
 * now`; an unparseable one returns the input unchanged.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const elapsed = now - at;
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))} min ago`;
  if (elapsed < DAY) return `${String(Math.floor(elapsed / HOUR))} h ago`;
  return `${plural(Math.floor(elapsed / DAY), 'day')} ago`;
}

/** The Fleet "last audit" cell: `never audited` until phase 5 fills `lastAudit`. */
export function lastAuditLabel(lastAudit: { at: string } | null, now: number = Date.now()): string {
  return lastAudit === null ? 'never audited' : relativeTime(lastAudit.at, now);
}

/** `2 ahead, 1 behind`; an empty string when the head is not available locally. */
export function aheadBehind(change: Pick<ChangeSummary, 'ahead' | 'behind'>): string {
  if (change.ahead === null || change.behind === null) return '';
  return `${String(change.ahead)} ahead, ${String(change.behind)} behind`;
}

/** The §5.2 UI label of each verdict, in the table order (SPEC.md section 5.2). */
export const VERDICT_LABEL: Readonly<Record<Verdict, string>> = {
  eyes: 'Needs your eyes',
  risky: 'Risky',
  spec: 'Outside the spec',
  ok: 'Reviewed, fine',
  same: 'Untouched',
};

/** Verdicts in the §5.2 table order. */
export const VERDICTS: readonly Verdict[] = ['eyes', 'risky', 'spec', 'ok', 'same'];

/** Status words as in the mockup's tags and top-bar stats. */
export const STATUS_LABEL: Readonly<Record<Status, string>> = {
  add: 'added',
  mod: 'modified',
  sig: 'signature',
  del: 'removed',
  same: 'untouched',
};

/** The changed statuses, in the mockup's order (added, modified, signature, removed). */
export const CHANGED_STATUSES: readonly Exclude<Status, 'same'>[] = ['add', 'mod', 'sig', 'del'];

export const REVIEW_STATE_LABEL: Readonly<Record<ReviewState, string>> = {
  unreviewed: 'Unreviewed',
  'in-review': 'In review',
  approved: 'Approved',
};

export const REVIEW_STATES: readonly ReviewState[] = ['unreviewed', 'in-review', 'approved'];

export const KINDS: readonly ChangeKind[] = ['draft', 'branch', 'pr'];

/** The kind filter chip: Draft, Branch, PR (no number). */
export const KIND_FILTER_LABEL: Readonly<Record<ChangeKind, string>> = { draft: 'Draft', branch: 'Branch', pr: 'PR' };

/** What the last event of a change was (SPEC.md section 3a: agent, commit, review). */
export const EVENT_LABEL: Readonly<Record<EventType, string>> = {
  collect: 'Collected',
  agent: 'Agent worked',
  commit: 'Commit',
  review: 'Reviewed',
  import: 'Findings imported',
  audit: 'Audited',
};

/** Why a change left the live list (ADR-019). */
export const ARCHIVE_REASON_LABEL: Readonly<Record<ArchiveReason, string>> = {
  merged: 'Merged',
  deleted: 'Branch deleted',
  closed: 'PR closed',
  clean: 'Draft cleaned',
};

/**
 * Where a change lives, from its ref (ADR-019): the branch name, the PR
 * number, or the working tree of a draft (`.` is the main working tree).
 */
export function refName(change: Pick<ChangeSummary, 'kind' | 'ref' | 'prNumber'>): string {
  const rest = change.ref.startsWith(REF_PREFIX[change.kind]) ? change.ref.slice(REF_PREFIX[change.kind].length) : change.ref;
  switch (change.kind) {
    case 'branch':
      return rest;
    case 'pr':
      return change.prNumber === null ? rest : `#${String(change.prNumber)}`;
    case 'draft':
      return rest === '.' || rest === '' ? 'main working tree' : rest;
  }
}

/** `2 May 2026`, in the browser time zone unless one is given. */
export function shortDate(iso: string, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(timeZone ? { timeZone } : {}) });
}

/** The first 7 characters of a commit sha, as git shows it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
