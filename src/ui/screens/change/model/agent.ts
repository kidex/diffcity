// "Send review to agent" (ADR-029), pure: no DOM, unit-tested in Node. The
// daemon decides everything (the argv, the working tree, the session, every
// refusal, the run's state); this only maps its answers to what the dialog and
// the run status draw, and holds the one rule of the UI's own: Send is offered
// only once the whole summary has been scrolled into view.

import type { AgentRunsResponse, AgentRunState } from '../../../../core/model/types.js';
import { plural, shortDate } from '../../../shared/format.js';
import type { AgentPreview, FindingRefusal } from '../ports.js';

export const SEND_TITLE = 'Send review to agent';
export const SEND = 'Send to agent';
export const SENDING = 'Sending…';
export const ADD_TO_QUEUE = 'Add to fix queue';
export const PERMISSION_DEFAULT = 'The agent runs with your Claude Code permission settings for this project';
export const SCROLL_TO_SEND = 'Read the summary to its end to send it';
export const REFUSED = 'The agent cannot be sent this review:';
export const PREVIEW_FAILED = 'The daemon did not answer. Try again once it is back.';
export const RUN_FAILED = 'The daemon did not answer, so the agent may not have started. Check the run status before sending again.';

/** Why the agent starts a new session instead of resuming one (the daemon's `newSessionReason`). */
export const NEW_SESSION_REASON: Readonly<Record<string, string>> = {
  'no-session-linked': 'No Claude Code session of this working tree is linked to the change',
  'session-other-directory': 'The latest linked session ran in another directory',
  'session-id-unsupported': 'The latest linked session has an id that cannot be resumed',
  'transcript-gone': 'The transcript of the latest linked session is gone',
};

/** The permission line: the project's own settings, or the mode settings.json names. */
export function permissionNote(mode: string | null): string {
  return mode === null ? PERMISSION_DEFAULT : `Permission mode: ${mode}`;
}

const hhmm = (at: Date, timeZone?: string): string =>
  at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) });

/** `2 May 2026, 10:14–11:02`, or with two dates when the session spans days; null when neither end is known. */
export function sessionRange(firstAt: string | null, lastAt: string | null, timeZone?: string): string | null {
  const first = firstAt === null ? null : new Date(firstAt);
  const last = lastAt === null ? null : new Date(lastAt);
  const valid = (at: Date | null): at is Date => at !== null && !Number.isNaN(at.getTime());
  if (!valid(first) && !valid(last)) return null;
  if (!valid(first) || !valid(last)) {
    const only = valid(first) ? first : (last as Date);
    return `${shortDate(only.toISOString(), timeZone)}, ${hhmm(only, timeZone)}`;
  }
  const day = shortDate(first.toISOString(), timeZone);
  const lastDay = shortDate(last.toISOString(), timeZone);
  if (day === lastDay) return `${day}, ${hhmm(first, timeZone)}–${hhmm(last, timeZone)}`;
  return `${day}, ${hhmm(first, timeZone)} – ${lastDay}, ${hhmm(last, timeZone)}`;
}

export type SessionLine = { kind: 'resume'; title: string; range: string | null } | { kind: 'new'; reason: string };

export interface SendDialogView {
  /** One argv item per line, as the daemon would run it; empty when it cannot be built. */
  argv: string[];
  cwd: string | null;
  session: SessionLine | null;
  permission: string;
  /** `Stopped after 30 minutes`; null when the launch is off (no limit to show). */
  timeout: string | null;
  summary: string;
  refusals: FindingRefusal[];
  /** Nothing refused and the daemon issued a token: Send may be offered once the summary was read. */
  sendable: boolean;
}

export function sendDialogView(preview: AgentPreview, timeZone?: string): SendDialogView {
  let session: SessionLine | null = null;
  if (preview.mode === 'resume' && preview.session !== null) {
    session = { kind: 'resume', title: preview.session.title ?? 'Untitled session', range: sessionRange(preview.session.firstAt, preview.session.lastAt, timeZone) };
  } else if (preview.mode === 'new') {
    const reason = preview.newSessionReason ?? 'no-session-linked';
    session = { kind: 'new', reason: NEW_SESSION_REASON[reason] ?? reason };
  }
  return {
    argv: preview.argv ?? [],
    cwd: preview.cwd,
    session,
    permission: permissionNote(preview.permissionMode),
    timeout: preview.timeoutMinutes > 0 ? `Stopped after ${plural(preview.timeoutMinutes, 'minute')}` : null,
    summary: preview.summary,
    refusals: preview.refusals,
    sendable: preview.refusals.length === 0 && preview.token !== null && preview.argv !== null && preview.argv.length > 0,
  };
}

/** Send is enabled only for a sendable preview whose summary end has been in view, and while no request is in flight. */
export function sendEnabled(view: SendDialogView, summaryRead: boolean, pending: boolean): boolean {
  return view.sendable && summaryRead && !pending;
}

/** What "Add to fix queue" says once the daemon answered. */
export function queuedText(answer: { queued: boolean; count: number }): string {
  const items = plural(answer.count, 'item');
  return answer.queued ? `Added to the fix queue (${items} waiting for /diffcity-review)` : `Already in the fix queue (${items} waiting for /diffcity-review)`;
}

/** The notes an agent works on: the current "Needs rewrite" marks (the daemon's count) and the general note. */
export function notesCount(state: { progress: { rewrite: number }; note: string | null } | null): number | null {
  if (state === null) return null;
  return state.progress.rewrite + ((state.note ?? '').trim() === '' ? 0 : 1);
}

export const RUN_STATE_LABEL: Readonly<Record<AgentRunState, string>> = {
  running: 'Agent is working',
  done: 'Agent finished',
  failed: 'Agent run failed',
  timeout: 'Agent run timed out',
  stopped: 'Agent run stopped',
};

export type RunStatusView =
  | { kind: 'hidden' }
  | { kind: 'running'; text: string; log: string | null }
  | { kind: 'ended'; state: Exclude<AgentRunState, 'running'>; text: string; exit: string; log: string | null; title: string | null };

/** The status line of the change's agent run, from GET /api/changes/:id/agent/runs; hidden when the change never had one. */
export function runStatusView(runs: AgentRunsResponse | null, notes: number | null): RunStatusView {
  const latest = runs?.latest ?? null;
  if (latest === null) return { kind: 'hidden' };
  if (runs?.running === true || latest.state === 'running') {
    const text = notes === null || notes === 0 ? 'Agent is working on the review' : `Agent is working on ${plural(notes, 'note')}`;
    return { kind: 'running', text, log: latest.log };
  }
  const exit = latest.exitCode === null ? 'no exit code' : `exit ${String(latest.exitCode)}`;
  return { kind: 'ended', state: latest.state, text: RUN_STATE_LABEL[latest.state], exit, log: latest.log, title: latest.message };
}
