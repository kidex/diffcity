// "Send review to the agent" (ADR-029), the pure part: the claude argv, the
// session to resume, the refusals, the summary hash and the session id of the
// result. The daemon gathers the facts (settings, realpaths, the transcript
// check, the resolved binary, the runs in progress) and calls these.
//
//   resume: [claude, "--resume", <sessionId>, "-p", "--output-format", "json"(, "--permission-mode", <mode>)]
//   new:    [claude, "-p", "--output-format", "json"(, "--permission-mode", <mode>)]
//   cwd:    the change's working tree
//   stdin:  the summary, then EOF; never in the argv
//
// The argv is built from a mode, a session id that matches
// AGENT_SESSION_ID and a permission mode from AGENT_PERMISSION_MODES only;
// no input can add a flag, and a permission bypass can never be produced.

import { createHash } from 'node:crypto';
import { CLAUDE_PROFILE } from '../exec/profiles.js';
import { toolArgs, type ToolArgs } from '../exec/tool.js';
import { isAgentPermissionMode, type AgentLaunchParse, type AgentPermissionMode } from './settings.js';

export type AgentMode = 'resume' | 'new';

/** A Claude Code session id that may be resumed: a lowercase UUID. */
export const AGENT_SESSION_ID = /^[0-9a-f-]{36}$/;

/** Anything that would loosen the permissions; the builder refuses an argv holding one. */
const BYPASS = /bypass|dangerously|skip-permissions/i;

export interface AgentCommand {
  mode: AgentMode;
  /** Required in resume mode, null in new mode. */
  sessionId: string | null;
  permissionMode: AgentPermissionMode | null;
}

/**
 * The claude arguments (after the binary) for `command`. Throws on a session
 * id that does not match AGENT_SESSION_ID, a session id in new mode, or a
 * permission mode outside the allow-list.
 */
export function claudeArgs(command: AgentCommand): ToolArgs {
  const argv: string[] = [];
  // Widened: the command may come from untyped JSON (a token binding), so the mode is checked at run time too.
  const mode: string = command.mode;
  if (mode === 'resume') {
    if (command.sessionId === null || !AGENT_SESSION_ID.test(command.sessionId)) throw new RangeError('resume needs a session id that is a lowercase UUID');
    argv.push('--resume', command.sessionId);
  } else if (mode === 'new') {
    if (command.sessionId !== null) throw new RangeError('a new session takes no session id');
  } else {
    throw new RangeError(`unknown agent mode: ${mode}`);
  }
  argv.push('-p', '--output-format', 'json');
  if (command.permissionMode !== null) {
    if (!isAgentPermissionMode(command.permissionMode)) throw new RangeError(`permission mode not allowed: ${String(command.permissionMode)}`);
    argv.push('--permission-mode', command.permissionMode);
  }
  if (argv.some((arg) => BYPASS.test(arg))) throw new RangeError('a permission bypass can never be passed to claude');
  return toolArgs(CLAUDE_PROFILE, argv);
}

/** The argv as the dialog shows it and the token binds it: the resolved binary first. */
export function displayArgv(binary: string, args: ToolArgs): string[] {
  return [binary, ...args.argv];
}

/** sha256 of the summary text, hex. */
export function summaryHash(summary: string): string {
  return createHash('sha256').update(summary, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Session choice.

/** A session linked to the change, with the facts the choice needs. */
export interface SessionCandidate {
  sessionId: string;
  /** realpath of the session's cwd; null when it cannot be resolved. */
  cwdReal: string | null;
  /** The transcript still exists at its validated path. */
  transcriptOk: boolean;
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
}

/** Why no session is resumed; the dialog words it. */
export type NewSessionReason = 'no-session-linked' | 'session-other-directory' | 'session-id-unsupported' | 'transcript-gone';

export type SessionChoice = { mode: 'resume'; session: SessionCandidate } | { mode: 'new'; reason: NewSessionReason };

const newestFirst = (a: SessionCandidate, b: SessionCandidate): number => (b.lastAt ?? '').localeCompare(a.lastAt ?? '');

/** Why a candidate cannot be resumed in `workingTree` (a realpath), or null when it can. */
function unusable(candidate: SessionCandidate, workingTree: string): NewSessionReason | null {
  if (candidate.cwdReal !== workingTree) return 'session-other-directory';
  if (!AGENT_SESSION_ID.test(candidate.sessionId)) return 'session-id-unsupported';
  if (!candidate.transcriptOk) return 'transcript-gone';
  return null;
}

/**
 * The newest linked session (by lastAt) that ran in the working tree, has a
 * resumable id and a transcript, in resume mode; otherwise new mode, with the
 * reason the newest linked session could not be used.
 */
export function chooseSession(candidates: readonly SessionCandidate[], workingTree: string): SessionChoice {
  const sorted = [...candidates].sort(newestFirst);
  const usable = sorted.find((candidate) => unusable(candidate, workingTree) === null);
  if (usable !== undefined) return { mode: 'resume', session: usable };
  const newest = sorted[0];
  if (newest === undefined) return { mode: 'new', reason: 'no-session-linked' };
  return { mode: 'new', reason: unusable(newest, workingTree) ?? 'no-session-linked' };
}

// ---------------------------------------------------------------------------
// Refusals, checked at preview and again at run.

export type AgentRefusalCode =
  | 'agent-launch-disabled'
  | 'nothing-to-send'
  | 'archived'
  | 'no-working-tree'
  | 'working-tree-missing'
  | 'claude-not-found'
  | 'claude-path-in-repo'
  | 'run-in-progress'
  | 'token-invalid'
  | 'summary-changed';

export interface AgentRefusal {
  code: AgentRefusalCode;
  message: string;
}

/** The claude binary as the resolver found it. */
export type ClaudeResolution = { ok: true; path: string } | { ok: false; why: 'missing' | 'in-repo'; message: string };

export interface AgentCheck {
  settings: AgentLaunchParse;
  /** The change's repo (its realpath) is in `agentLaunch.repos` (realpaths). */
  repoListed: boolean;
  archived: boolean;
  /** Current "Needs rewrite" marks of the change. */
  rewriteMarks: number;
  /** The general note, null for none. */
  note: string | null;
  /** The change's checked-out working tree; null when it has none. */
  workingTree: string | null;
  workingTreeExists: boolean;
  /** Null when not looked up (no working tree). */
  claude: ClaudeResolution | null;
  /** A run of this change, or two runs in the daemon, are in progress. */
  runInProgress: 'change' | 'daemon' | null;
}

/** Every refusal that applies, in the ADR-029 order; empty when the launch may go ahead. */
export function agentRefusals(check: AgentCheck): AgentRefusal[] {
  const refusals: AgentRefusal[] = [];
  const add = (code: AgentRefusalCode, message: string): void => {
    refusals.push({ code, message });
  };
  if (!check.settings.ok) add('agent-launch-disabled', `settings.json: ${check.settings.error}; agent launch is off until it is fixed`);
  else if (!check.settings.settings.enabled) add('agent-launch-disabled', 'agent launch is off (agentLaunch.enabled in settings.json)');
  else if (!check.repoListed) add('agent-launch-disabled', 'this repo is not listed in agentLaunch.repos in settings.json');
  if (check.rewriteMarks === 0 && (check.note ?? '').trim() === '') add('nothing-to-send', 'no "Needs rewrite" mark and no general note to send');
  if (check.archived) add('archived', 'the change is archived');
  if (check.workingTree === null) add('no-working-tree', 'the change is not checked out in any working tree; diffcity never creates one or switches branches');
  else if (!check.workingTreeExists) add('working-tree-missing', 'the working tree of the change no longer exists');
  if (check.claude !== null && !check.claude.ok) add(check.claude.why === 'in-repo' ? 'claude-path-in-repo' : 'claude-not-found', check.claude.message);
  if (check.runInProgress === 'change') add('run-in-progress', 'an agent is already running for this change');
  else if (check.runInProgress === 'daemon') add('run-in-progress', 'two agents are already running; wait for one to finish');
  return refusals;
}

// ---------------------------------------------------------------------------
// The result of `--output-format json`.

/** The last line of `text` that parses as a JSON object, or undefined. */
export function lastJsonObject(text: string): Record<string, unknown> | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Not a whole JSON object: keep looking.
    }
  }
  return undefined;
}

/** `session_id` of a claude JSON result when it is a resumable id; null otherwise. */
export function resultSessionId(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const id = (result as Record<string, unknown>)['session_id'];
  return typeof id === 'string' && AGENT_SESSION_ID.test(id) ? id : null;
}
