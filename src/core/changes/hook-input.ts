// The Claude Code Stop or SessionEnd hook JSON that `track --agent` reads from
// stdin when stdin is not a TTY (SPEC.md section 3, ADR-001, DC-128). It
// carries the session (`session_id`, `transcript_path`), the `cwd` that
// replaces the default directory and `hook_event_name`; it is at most 64 KB.
// Other fields of the hook payload (SessionEnd's `reason` among them) are
// ignored. `track` forwards these four to the daemon, which
// validates them again before it reads anything (ADR-038).

import { isAbsolute } from 'node:path';

/** Longest hook input accepted, in bytes. */
export const MAX_HOOK_INPUT_BYTES = 64 * 1024;

export interface AgentHookInput {
  sessionId: string;
  /** Absolute path of the session transcript (JSON lines). */
  transcriptPath: string;
  /** Absolute directory the agent worked in. */
  cwd: string;
  /** `hook_event_name`; DEFAULT_HOOK_EVENT when absent or not a plain name. */
  event: string;
}

/** The event of a hook input that names none. */
export const DEFAULT_HOOK_EVENT = 'Stop';

/** The event of a session that ended: it only ends the session (DC-128). */
export const SESSION_END_EVENT = 'SessionEnd';

/**
 * True for a hook that only ends its session: the session reads as no longer
 * active, and nothing else happens (no agent mark, no collection, the repo is
 * not seen). Every other event (`Stop`, `SubagentStop`) is a finished task.
 */
export function endsSession(event: string): boolean {
  return event === SESSION_END_EVENT;
}

/** A hook event name as Claude Code writes them (`Stop`, `SubagentStop`, `SessionEnd`). */
const HOOK_EVENT = /^[A-Za-z]{1,64}$/;

/** `input` is null when stdin carried nothing but whitespace. */
export type AgentHookInputResult = { ok: true; input: AgentHookInput | null } | { ok: false; error: string };

const fail = (error: string): AgentHookInputResult => ({ ok: false, error });

export function parseAgentHookInput(text: string): AgentHookInputResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_HOOK_INPUT_BYTES) {
    return fail(`hook input exceeds ${String(MAX_HOOK_INPUT_BYTES)} bytes`);
  }
  if (text.trim() === '') return { ok: true, input: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('hook input is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('hook input must be a JSON object');
  const fields = value as Record<string, unknown>;

  const { session_id: sessionId, transcript_path: transcriptPath, cwd, hook_event_name: eventName } = fields;
  if (typeof sessionId !== 'string' || sessionId === '') return fail('hook input: session_id must be a non-empty string');
  if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath)) {
    return fail('hook input: transcript_path must be an absolute path');
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return fail('hook input: cwd must be an absolute path');
  const event = typeof eventName === 'string' && HOOK_EVENT.test(eventName) ? eventName : DEFAULT_HOOK_EVENT;
  return { ok: true, input: { sessionId, transcriptPath, cwd, event } };
}
