// The sessions of a change as the API serves them (ADR-038): stored rows
// turned into SessionView, outside the Report (ADR-002). The UI only renders
// what this computes. The parse state (cursors, hashes, the runs' working
// directories) is never served; runs are filtered to the change's working tree:
//
// - a run whose working directory lies in the change's working tree is kept
//   and marked `here`;
// - a run that worked in another working tree of the repo is left out and
//   counted in `runsElsewhere`;
// - a run whose working tree is unknown (no directory recorded, or one in no
//   known working tree) is kept, not `here`.
//
// A run with no directory of its own counts as working in the session's. When
// the change has no working tree, no run is `here` and none is left out.
// The session itself is `here` when it ran in the change's working tree; the
// main agent's activity is shown only then. A kept run whose parent was left
// out gets `parentAgentId: null`. A failed re-read keeps the last good digest
// (`stale`); a session with no good digest after a failure is `unreadable`.

import type { SessionDigestView, SessionRunView, SessionView } from '../model/types.js';
import { isInside } from './validate.js';
import { DIGEST_FORMAT, type SessionDigest } from './types.js';

/** Sessions per change served by the API, newest first. */
export const SESSIONS_PER_CHANGE = 20;

export interface SessionRow {
  sessionId: string;
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
  /** Realpath of the session's working directory (the runs' are realpaths in the digest, job.ts). */
  cwd: string;
  digest: string | null;
  parseError: string | null;
  firstHead: string | null;
  lastHead: string | null;
  linkedAt: string;
}

export interface SessionViewContext {
  /** Realpath of the change's working tree; null when it is checked out nowhere. */
  changeTree: string | null;
  /** Realpaths of the repo's known working trees (the main one included). */
  trees: readonly string[];
}

/** The innermost of `trees` that contains `dir`, or null. */
export function treeContaining(trees: readonly string[], dir: string): string | null {
  let best: string | null = null;
  for (const tree of trees) {
    if ((dir === tree || isInside(tree, dir)) && (best === null || tree.length > best.length)) best = tree;
  }
  return best;
}

function parseDigest(text: string | null): SessionDigest | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<SessionDigest> | null;
    return value !== null && value.format === DIGEST_FORMAT && Array.isArray(value.runs) && typeof value.state === 'object' ? (value as SessionDigest) : null;
  } catch {
    return null;
  }
}

function digestView(digest: SessionDigest, sessionHere: boolean, sessionTree: string | null, context: SessionViewContext): SessionDigestView {
  const { state, runs } = digest;
  const cwds = state.cwds ?? {};
  const kept: SessionRunView[] = [];
  let elsewhere = 0;
  for (const run of runs) {
    const own = run.agentId !== null && Object.hasOwn(cwds, run.agentId) ? cwds[run.agentId] : undefined;
    const tree = own === undefined ? sessionTree : treeContaining(context.trees, own);
    if (context.changeTree === null || tree === null) {
      kept.push({ ...run, here: false });
    } else if (tree === context.changeTree) {
      kept.push({ ...run, here: true });
    } else {
      elsewhere++;
    }
  }
  const shown = new Set(kept.map((run) => run.agentId).filter((id): id is string => id !== null));
  for (const run of kept) {
    if (run.parentAgentId !== null && !shown.has(run.parentAgentId)) run.parentAgentId = null;
  }
  // Listed field by field: a field added to the digest later is not served until it is added here.
  // SessionView carries sessionId, title, firstAt and lastAt; the session totals move to sessionWide.
  return {
    format: digest.format,
    version: digest.version,
    branch: digest.branch,
    prompts: digest.prompts,
    promptsDropped: digest.promptsDropped,
    questions: digest.questions,
    questionsDropped: digest.questionsDropped,
    runs: kept,
    runsDropped: digest.runsDropped,
    runsElsewhere: elsewhere,
    main: sessionHere || context.changeTree === null ? digest.main : null,
    sessionWide: { files: digest.files, filesDropped: digest.filesDropped, outsideFiles: digest.outsideFiles },
    truncated: digest.truncated,
    capped: digest.capped,
    badLines: digest.badLines,
    skippedLines: digest.skippedLines,
  };
}

/** The served view of one linked session. */
export function sessionView(row: SessionRow, context: SessionViewContext): SessionView {
  const sessionTree = treeContaining(context.trees, row.cwd);
  const here = context.changeTree !== null && sessionTree === context.changeTree;
  const digest = parseDigest(row.digest);
  const failed = row.parseError !== null;
  return {
    sessionId: row.sessionId,
    title: row.title,
    firstAt: row.firstAt,
    lastAt: row.lastAt,
    here,
    active: digest?.state.ended !== true,
    unreadable: digest === null && (failed || row.digest !== null),
    stale: digest !== null && failed,
    firstHead: row.firstHead,
    lastHead: row.lastHead,
    linkedAt: row.linkedAt,
    digest: digest === null ? null : digestView(digest, here, sessionTree, context),
  };
}
