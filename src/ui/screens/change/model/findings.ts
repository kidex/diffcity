// What a finding card shows of its sources and of its actions (ADR-036): the
// sources that reported it, and which of "Ask agent to fix", "Queued", "Mark
// as intended" and "Undo" it offers, from the finding's state in the Report
// and what this session did. Presentation only: the state, the verdicts and
// the fix queue are the daemon's; the Report is refetched after every write.
// Pure: no DOM.

import type { Finding } from '../../../../core/report/types.js';

export const ASK_FIX = 'Ask agent to fix';
export const QUEUED = 'Queued';
export const MARK_INTENDED = 'Mark as intended';
export const UNDO = 'Undo';
/** A request that never got an answer (no daemon, a dropped connection); any answer of the daemon shows its own message. */
export const ACTION_FAILED = 'Could not reach the diffcity daemon. Try again.';

/** Every source that reported the finding, `source` first, each once (`[source]` when the Report has no `sources`). */
export function sourcesOf(finding: Pick<Finding, 'source' | 'sources'>): string[] {
  return [...new Set([finding.source, ...(finding.sources ?? [])])];
}

export type FindingAction = 'ask' | 'intend' | 'undo';

/** What this session knows of the findings beyond the Report. */
export interface FindingSession {
  /** Keys the daemon put in (or already had in) the fix queue. The Report does not carry the queue. */
  queued: ReadonlySet<string>;
  /** Keys marked as intended in this session: they offer Undo. */
  marked: ReadonlySet<string>;
  /** Keys with a request in flight. */
  pending: ReadonlyMap<string, FindingAction>;
  /** Keys whose state was written and whose refetched Report has not shown it yet. */
  expected: ReadonlyMap<string, 'open' | 'intended'>;
  /** The line under a key's buttons after an error answer (its message) or a request with no answer. */
  errors: ReadonlyMap<string, string>;
}

export const emptySession = (): FindingSession => ({ queued: new Set(), marked: new Set(), pending: new Map(), expected: new Map(), errors: new Map() });

export interface ActionButton {
  action: FindingAction;
  label: string;
  /** Shown but inert: queued already, or a request in flight. */
  disabled: boolean;
}

export interface ActionsView {
  buttons: ActionButton[];
  error: string | null;
}

/**
 * The buttons of a finding card. An open finding offers "Ask agent to fix"
 * ("Queued", inert, once the daemon queued it) and "Mark as intended"; an
 * intended one marked in this session offers "Undo"; anything else none. While
 * a request is in flight, or a written state has not come back in the Report,
 * the buttons stay but do nothing.
 */
export function actionsView(finding: Pick<Finding, 'id' | 'state'>, session: FindingSession): ActionsView {
  const busy = session.pending.has(finding.id) || session.expected.has(finding.id);
  const error = session.errors.get(finding.id) ?? null;
  if (finding.state === 'open') {
    const queued = session.queued.has(finding.id);
    return {
      buttons: [
        { action: 'ask', label: queued ? QUEUED : ASK_FIX, disabled: queued || busy },
        { action: 'intend', label: MARK_INTENDED, disabled: busy },
      ],
      error,
    };
  }
  if (finding.state === 'intended' && session.marked.has(finding.id)) return { buttons: [{ action: 'undo', label: UNDO, disabled: busy }], error };
  return { buttons: [], error };
}

/** The accessible name of a button: its label and the finding it acts on (the label is the same on every card). */
export const actionName = (button: ActionButton, title: string): string =>
  button.action === 'undo' ? `Undo mark as intended: ${title}` : `${button.label}: ${title}`;
