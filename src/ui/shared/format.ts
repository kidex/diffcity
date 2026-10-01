// Display labels and times. Formatting only: every value shown comes from the
// API or the Report as it is (ADR-022).

import type { ChangeKind, ChangeSummary } from '../../core/model/types.js';

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
