// What "send review to the agent" would run for a change (ADR-029), computed
// from scratch at preview and again at run: the settings (read from disk on
// every call), the summary, the working tree, the session to resume, the
// claude binary and every refusal. The rules are src/core/agent's; this file
// gathers their inputs from the database and the disk.

import { CLAUDE_PROFILE, resolveTool, type ToolArgs, type ToolContext } from '../../core/exec/index.js';
import {
  agentLaunchSettings,
  agentRefusals,
  chooseSession,
  claudeArgs,
  displayArgv,
  isDirectory,
  realOrNull,
  repoListed,
  sessionCandidates,
  summaryHash,
  type AgentLaunchParse,
  type AgentMode,
  type AgentPermissionMode,
  type AgentRefusal,
  type ClaudeResolution,
  type NewSessionReason,
} from '../../core/agent/index.js';
import type { Db } from '../../core/db/index.js';
import type { ChangeRecord } from '../../core/model/types.js';
import type { Report } from '../../core/report/types.js';
import { renderSummary } from '../../core/review/index.js';
import { readSettings, readToolSetting, toolPathProblem, type ToolSetting } from '../../core/settings/index.js';
import { HttpError } from '../http/errors.js';

/** Linked sessions looked at, newest first. */
const SESSIONS_LOOKED_AT = 50;

export interface PlanDeps {
  db: Db;
  /** `<home>/settings.json`. */
  settingsPath: string;
  /** The daemon's environment: the PATH claude is looked up on, and what the runner's allow-list keeps. */
  env: Readonly<Record<string, string | undefined>>;
  /** `<claude config dir>/projects`; null when unknown (no transcript is then valid, no session resumed). */
  projectsDir: string | null;
  /** Runs in progress: of this change, or the daemon is full. */
  busy(changeId: number): 'change' | 'daemon' | null;
}

/** The session the plan resumes, as the dialog shows it. */
export interface PlannedSession {
  sessionId: string;
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
}

export interface AgentPlan {
  change: ChangeRecord;
  mode: AgentMode | null;
  /** The argv as shown and bound, the resolved binary first; null when it cannot be built. */
  argv: string[] | null;
  args: ToolArgs | null;
  binary: string | null;
  /** The working tree (its realpath). */
  cwd: string | null;
  session: PlannedSession | null;
  newSessionReason: NewSessionReason | null;
  permissionMode: AgentPermissionMode | null;
  timeoutMinutes: number;
  summary: string;
  summaryHash: string;
  refusals: AgentRefusal[];
  /** The resolver's context the run must use too. */
  toolContext: ToolContext;
}

/** agentLaunch from settings.json; an unreadable or invalid file turns the launch off. */
export async function readAgentLaunch(settingsPath: string): Promise<AgentLaunchParse> {
  const read = await readSettings(settingsPath);
  if (!read.ok) return { ok: false, error: read.error };
  return agentLaunchSettings(read.settings);
}

/** The claude binary setting: agentLaunch.claudePath, else tools.claude, else the PATH (ADR-029 decision 5). */
async function claudeSetting(settingsPath: string, launch: AgentLaunchParse): Promise<ToolSetting> {
  if (launch.ok && launch.settings.claudePath !== null) {
    const problem = await toolPathProblem(launch.settings.claudePath);
    return problem === null ? { kind: 'path', path: launch.settings.claudePath } : { kind: 'invalid', message: `field "agentLaunch.claudePath": ${problem}` };
  }
  return readToolSetting(settingsPath, 'claude');
}

/** Every registered repo and every working tree a live change is checked out in: no binary may come from one. */
function repoRoots(db: Db): string[] {
  const roots = new Set<string>();
  for (const repo of db.repos.list()) {
    roots.add(repo.path);
    for (const change of db.changes.listLive(repo.id)) if (change.worktreePath !== null) roots.add(change.worktreePath);
  }
  return [...roots];
}

/** The summary of the change's latest snapshot (as GET /api/changes/:id/review/summary renders it) and what it is made of. */
export function summaryOf(db: Db, change: ChangeRecord): { summary: string; rewriteMarks: number; note: string | null } {
  const snapshot = db.snapshots.latest(change.id);
  if (snapshot === null) throw new HttpError(409, 'no-snapshot', `change ${String(change.id)} has no snapshot yet`);
  const marks = db.review.list(change.id);
  const note = db.review.note(change.id);
  const summary = renderSummary({
    ref: change.ref,
    repoName: db.repos.get(change.repoId)?.name ?? '',
    head: snapshot.head,
    note,
    report: JSON.parse(snapshot.report) as Report,
    marks,
  });
  return { summary, rewriteMarks: marks.filter((mark) => mark.state === 'current' && mark.mark === 'rewrite').length, note };
}

export async function planAgentRun(deps: PlanDeps, change: ChangeRecord): Promise<AgentPlan> {
  const { db } = deps;
  const launch = await readAgentLaunch(deps.settingsPath);
  const repo = db.repos.get(change.repoId);
  const listed = launch.ok && repo !== null && (await repoListed(repo.path, launch.settings.repos));
  const { summary, rewriteMarks, note } = summaryOf(db, change);
  const permissionMode = launch.ok ? launch.settings.permissionMode : null;
  const timeoutMinutes = launch.ok ? launch.settings.timeoutMinutes : 0;

  const workingTree = change.worktreePath;
  const cwd = workingTree === null ? null : await realOrNull(workingTree);
  const treeExists = cwd !== null && (await isDirectory(cwd));
  const toolContext: ToolContext = {
    env: deps.env,
    toolSetting: () => claudeSetting(deps.settingsPath, launch),
    repoRoots: () => repoRoots(db),
  };

  let claude: ClaudeResolution | null = null;
  let mode: AgentMode | null = null;
  let session: PlannedSession | null = null;
  let newSessionReason: NewSessionReason | null = null;
  let args: ToolArgs | null = null;
  if (cwd !== null && treeExists) {
    const resolved = await resolveTool(CLAUDE_PROFILE, cwd, toolContext);
    claude = resolved.ok ? { ok: true, path: resolved.binary } : { ok: false, why: resolved.why === 'in-repo' ? 'in-repo' : 'missing', message: resolved.message };
    const linked = db.sessions.forChange(change.id, SESSIONS_LOOKED_AT).map(({ session: row }) => row);
    const candidates = deps.projectsDir === null ? [] : await sessionCandidates(linked, deps.projectsDir);
    const choice = chooseSession(candidates, cwd);
    mode = choice.mode;
    if (choice.mode === 'resume') {
      const { sessionId, title, firstAt, lastAt } = choice.session;
      session = { sessionId, title, firstAt, lastAt };
    } else {
      newSessionReason = choice.reason;
    }
    args = claudeArgs({ mode: choice.mode, sessionId: session?.sessionId ?? null, permissionMode });
  }

  const refusals = agentRefusals({
    settings: launch,
    repoListed: listed,
    archived: change.archivedAt !== null,
    rewriteMarks,
    note,
    workingTree,
    workingTreeExists: treeExists,
    claude,
    runInProgress: deps.busy(change.id),
  });
  const binary = claude?.ok === true ? claude.path : null;
  return {
    change,
    mode,
    argv: args !== null && binary !== null ? displayArgv(binary, args) : null,
    args,
    binary,
    cwd: treeExists ? cwd : null,
    session,
    newSessionReason,
    permissionMode,
    timeoutMinutes,
    summary,
    summaryHash: summaryHash(summary),
    refusals,
    toolContext,
  };
}
