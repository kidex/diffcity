// What the Session tab shows (ADR-038), as plain data from the daemon's
// SessionsResponse and the Report: one card per session in the order served
// (newest first), its prompts, questions, the agents that ran (nested under
// their parent when the parent is shown), the activity chips and the edited
// files, with the building each one is in when the Report has it.
// Presentation only: which runs are shown, `here`, `stale`, `unreadable` and
// every count come from the daemon; nothing here reads transcript content.
// Pure: no DOM.

import type { SessionRunView, SessionsResponse, SessionView } from '../../../../core/model/types.js';
import type { Report } from '../../../../core/report/types.js';
import type { Activity, ActivityKind, RunStatus, SessionPrompt, SessionQuestion } from '../../../../core/session/types.js';
import { plural } from '../../../shared/format.js';

export const UNTITLED_SESSION = 'Untitled session';
export const UNREADABLE_SESSION = 'Session data could not be read';
export const NOT_READ_SESSION = 'Session data has not been read yet';
export const STALE_SESSION = 'Out of date — the latest update could not be read; showing the last good copy.';
export const CLIPPED_SESSION = 'Part of this session was too large to keep';
export const NO_DESCRIPTION = 'No description';
export const NO_ANSWER = 'Not answered';

/** The activity kinds in the order the chips are shown. */
const KIND_ORDER: readonly ActivityKind[] = ['edit', 'read-search', 'shell', 'web', 'subagents', 'mcp', 'other'];

export const ACTIVITY_LABEL: Readonly<Record<ActivityKind, string>> = {
  edit: 'Edits',
  'read-search': 'Reads and searches',
  shell: 'Shell',
  web: 'Web',
  subagents: 'Subagents',
  mcp: 'MCP',
  other: 'Other tools',
};

export const RUN_STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'stopped',
  unknown: 'unknown',
};

const STATUS_SOURCE_TEXT: Readonly<Record<NonNullable<SessionRunView['statusSource']>, string>> = {
  notification: 'Status from the task notification',
  'tool-result': 'Status from the tool result',
  handback: 'Status from the agent’s handback',
};

/** One chip of an activity summary: `Edits 4`, `MCP tracker 2`. */
export interface ActivityChip {
  kind: ActivityKind;
  label: string;
  count: number;
}

/** An edited file; `fileId` is the building it is in, null when the Report has no file at that path. */
export interface EditedFile {
  path: string;
  fileId: string | null;
}

export interface ActivityView {
  chips: ActivityChip[];
  files: EditedFile[];
  /** "and N more files", or null. */
  more: string | null;
  /** "N files outside the repo", or null. */
  outside: string | null;
}

export interface RunRow {
  /** Stable within the session: the agent id, else the tool call, else the order. */
  key: string;
  run: SessionRunView;
  /** 0 for a run of the main agent (or one whose parent is not shown), 1 under it, and so on. */
  depth: number;
  type: string;
  description: string;
  /** `42 s`, `≈ 3 min 12 s`; null when unknown. */
  duration: string | null;
  status: string;
  /** Where the status came from, in words. */
  statusSource: string;
  activity: ActivityView;
}

export type SessionState = 'ok' | 'stale' | 'unread' | 'unreadable';

export interface SessionCard {
  key: string;
  title: string;
  untitled: boolean;
  /** `9 Oct 2026, 14:02 – 15:40`; '' when the session has no times. */
  range: string;
  here: boolean;
  active: boolean;
  state: SessionState;
  /** Notes under the head: out of date, clipped. */
  notes: string[];
  prompts: SessionPrompt[];
  /** "and N earlier prompts", or null. */
  promptsMore: string | null;
  questions: SessionQuestion[];
  questionsMore: string | null;
  runs: RunRow[];
  runsMore: string | null;
  /** "N runs in other working trees", or null. */
  elsewhere: string | null;
  /** The main agent's activity, when the session ran in this change's working tree. */
  main: ActivityView | null;
  /** Every agent's edits over the whole session. */
  wide: ActivityView | null;
}

export interface SessionTab {
  cards: SessionCard[];
  /** "20 of 34 sessions" when the daemon linked more than it served; null otherwise. */
  shown: string | null;
}

/** The Session tab is shown only with sessions to show. */
export const hasSessions = (response: SessionsResponse | null): response is SessionsResponse => response !== null && response.sessions.length > 0;

/** `42 s`, `3 min 12 s`, `1 h 4 min`; `≈ ` before an approximate one. */
export function durationText(ms: number | null, approximate: boolean): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  let text: string;
  if (seconds < 60) text = `${String(seconds)} s`;
  else if (seconds < 3600) {
    const rest = seconds % 60;
    text = `${String(Math.floor(seconds / 60))} min${rest === 0 ? '' : ` ${String(rest)} s`}`;
  } else {
    const minutes = Math.floor((seconds % 3600) / 60);
    text = `${String(Math.floor(seconds / 3600))} h${minutes === 0 ? '' : ` ${String(minutes)} min`}`;
  }
  return approximate ? `≈ ${text}` : text;
}

const dateParts = (at: Date, timeZone: string | undefined): { day: string; time: string } => {
  const zone = timeZone === undefined ? {} : { timeZone };
  return {
    day: at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...zone }),
    time: at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...zone }),
  };
};

/** `9 Oct 2026, 14:02 – 15:40`, `9 Oct 2026, 23:50 – 10 Oct 2026, 00:20`; one end alone when the other is unknown. */
export function rangeText(firstAt: string | null, lastAt: string | null, timeZone?: string): string {
  const parse = (iso: string | null): Date | null => {
    if (iso === null) return null;
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? null : at;
  };
  const first = parse(firstAt);
  const last = parse(lastAt);
  if (first === null && last === null) return '';
  if (first === null || last === null) {
    const one = dateParts((first ?? last) as Date, timeZone);
    return `${one.day}, ${one.time}`;
  }
  const a = dateParts(first, timeZone);
  const b = dateParts(last, timeZone);
  if (a.day === b.day) return a.time === b.time ? `${a.day}, ${a.time}` : `${a.day}, ${a.time} – ${b.time}`;
  return `${a.day}, ${a.time} – ${b.day}, ${b.time}`;
}

/** The Report's file ids by path. */
export function filesByPath(report: Report): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const file of report.packages.flatMap((pkg) => pkg.files)) if (!byPath.has(file.path)) byPath.set(file.path, file.id);
  return byPath;
}

const moreText = (count: number, noun: string, nouns?: string): string | null => (count > 0 ? `and ${plural(count, noun, nouns)} more` : null);

export function activityView(
  activity: Pick<Activity, 'files' | 'filesDropped' | 'outsideFiles'> & Partial<Pick<Activity, 'counts' | 'mcp'>>,
  files: ReadonlyMap<string, string>,
): ActivityView {
  const chips: ActivityChip[] = [];
  const counts = activity.counts;
  if (counts !== undefined) {
    const servers = Object.entries(activity.mcp ?? {}).filter(([, count]) => count > 0);
    for (const kind of KIND_ORDER) {
      const count = counts[kind];
      if (kind === 'mcp' && servers.length > 0) {
        for (const [server, n] of servers) chips.push({ kind, label: `MCP ${server}`, count: n });
        continue;
      }
      if (count > 0) chips.push({ kind, label: ACTIVITY_LABEL[kind], count });
    }
  }
  return {
    chips,
    files: activity.files.map((path) => ({ path, fileId: files.get(path) ?? null })),
    more: moreText(activity.filesDropped, 'file'),
    outside: activity.outsideFiles > 0 ? `${plural(activity.outsideFiles, 'file')} outside the repo` : null,
  };
}

const runKey = (run: SessionRunView): string => run.agentId ?? run.toolUseId ?? `#${String(run.order)}`;

/**
 * The runs in reading order: by `order`, each followed by the runs it
 * launched (when the daemon shows the parent, `parentAgentId` names it).
 * A run whose parent is not among them is listed at the top level.
 */
export function runRows(runs: readonly SessionRunView[], files: ReadonlyMap<string, string>): RunRow[] {
  const sorted = [...runs].sort((a, b) => a.order - b.order);
  const ids = new Set(sorted.map((run) => run.agentId).filter((id): id is string => id !== null));
  const children = new Map<string, SessionRunView[]>();
  const roots: SessionRunView[] = [];
  for (const run of sorted) {
    const parent = run.parentAgentId;
    if (parent !== null && parent !== run.agentId && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), run]);
    else roots.push(run);
  }
  const rows: RunRow[] = [];
  const seen = new Set<SessionRunView>();
  const visit = (run: SessionRunView, depth: number): void => {
    if (seen.has(run)) return;
    seen.add(run);
    rows.push({
      key: runKey(run),
      run,
      depth,
      type: run.type ?? 'agent',
      description: run.description ?? NO_DESCRIPTION,
      duration: durationText(run.durationMs, run.durationApproximate),
      status: RUN_STATUS_LABEL[run.status],
      statusSource: run.statusSource === null ? 'No status reported yet' : STATUS_SOURCE_TEXT[run.statusSource],
      activity: activityView(run.activity, files),
    });
    if (run.agentId !== null) for (const child of children.get(run.agentId) ?? []) visit(child, depth + 1);
  };
  for (const run of roots) visit(run, 0);
  // Parents that point at each other have no root: list them anyway, at the top level.
  for (const run of sorted) visit(run, 0);
  return rows;
}

function stateOf(session: SessionView): SessionState {
  if (session.unreadable) return 'unreadable';
  if (session.digest === null) return 'unread';
  return session.stale ? 'stale' : 'ok';
}

export function sessionCard(session: SessionView, files: ReadonlyMap<string, string>, timeZone?: string): SessionCard {
  const state = stateOf(session);
  const digest = state === 'unreadable' ? null : session.digest;
  const title = session.title !== null && session.title.trim() !== '' ? session.title : null;
  const notes: string[] = [];
  if (state === 'stale') notes.push(STALE_SESSION);
  if (digest !== null && (digest.truncated || digest.capped)) notes.push(CLIPPED_SESSION);
  return {
    key: session.sessionId,
    title: title ?? UNTITLED_SESSION,
    untitled: title === null,
    range: rangeText(session.firstAt, session.lastAt, timeZone),
    here: session.here,
    active: session.active,
    state,
    notes,
    prompts: digest?.prompts ?? [],
    promptsMore: moreText(digest?.promptsDropped ?? 0, 'prompt'),
    questions: digest?.questions ?? [],
    questionsMore: moreText(digest?.questionsDropped ?? 0, 'question'),
    runs: digest === null ? [] : runRows(digest.runs, files),
    runsMore: moreText(digest?.runsDropped ?? 0, 'run'),
    elsewhere: digest !== null && digest.runsElsewhere > 0 ? `${plural(digest.runsElsewhere, 'run')} in other working trees` : null,
    main: digest === null || digest.main === null ? null : activityView(digest.main, files),
    wide: digest === null ? null : activityView(digest.sessionWide, files),
  };
}

/** The cards in the order the daemon serves them (newest first), and "20 of N sessions" when it holds more. */
export function sessionTab(response: SessionsResponse, report: Report, timeZone?: string): SessionTab {
  const files = filesByPath(report);
  const count = response.sessions.length;
  return {
    cards: response.sessions.map((session) => sessionCard(session, files, timeZone)),
    shown: response.total > count ? `${String(count)} of ${plural(response.total, 'session')}` : null,
  };
}
