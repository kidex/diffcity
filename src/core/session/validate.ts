// Validation of the session a `track` request carries (ADR-038), before any
// file is read. The message comes over the socket and is trusted for nothing:
//
// - `sessionId` matches SESSION_ID_PATTERN;
// - `transcriptPath` is absolute and normalized, ends in `.jsonl`, and its
//   basename is `<sessionId>.jsonl`;
// - it is a regular file (lstat: not a symbolic link), and its realpath lies
//   under the realpath of the Claude Code projects directory and still has
//   that basename;
// - `cwd` is absolute.
//
// Only metadata is looked at here (lstat, realpath): no byte of a file is read.
// A refusal is a code; neither the code nor its message carries the path.
// Subagent files are never named by the message: the reader derives them from
// the validated transcript path and checks each one itself (read.ts).

import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';

/** Claude Code session ids are UUIDs; a little looser, never a path. */
export const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

/** A hook event name as Claude Code writes them. */
const EVENT_PATTERN = /^[A-Za-z]{1,64}$/;

/** Longest path accepted in a message. */
const MAX_PATH = 4096;

export type SessionRefusal =
  | 'malformed'
  | 'bad-session-id'
  | 'bad-event'
  | 'bad-transcript-path'
  | 'basename-mismatch'
  | 'bad-cwd'
  | 'no-projects-dir'
  | 'transcript-missing'
  | 'symlink'
  | 'not-a-file'
  | 'outside-projects';

/** A session whose transcript may be read. */
export interface ValidatedSession {
  sessionId: string;
  /** The transcript's realpath, under the projects directory. */
  transcriptPath: string;
  cwd: string;
  event: string;
}

export type SessionValidation = { ok: true; session: ValidatedSession } | { ok: false; code: SessionRefusal };

/** `<claude config dir>/projects`, where Claude Code writes its transcripts. */
export function claudeProjectsDir(claudeConfigDir: string): string {
  return join(claudeConfigDir, 'projects');
}

const refuse = (code: SessionRefusal): SessionValidation => ({ ok: false, code });

const isPath = (value: string): boolean => value.length > 0 && value.length <= MAX_PATH && !value.includes('\0') && isAbsolute(value);

/** Whether `path` is strictly inside `dir` (both realpaths). */
export function isInside(dir: string, path: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return path.startsWith(prefix) && path.length > prefix.length;
}

/**
 * The realpath of a transcript file that may be read: a regular file, not a
 * symbolic link, under the projects directory, named `<sessionId>.jsonl`.
 * The reader calls it again before every read, since the file may have been
 * replaced since the hook.
 */
export async function checkTranscriptPath(path: string, sessionId: string, projectsDir: string): Promise<{ ok: true; path: string } | { ok: false; code: SessionRefusal }> {
  if (!isPath(path) || normalize(path) !== path || !path.endsWith('.jsonl')) return { ok: false, code: 'bad-transcript-path' };
  const name = `${sessionId}.jsonl`;
  if (basename(path) !== name) return { ok: false, code: 'basename-mismatch' };
  let projects: string;
  try {
    projects = await realpath(projectsDir);
  } catch {
    return { ok: false, code: 'no-projects-dir' };
  }
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { ok: false, code: 'transcript-missing' };
  }
  if (info.isSymbolicLink()) return { ok: false, code: 'symlink' };
  if (!info.isFile()) return { ok: false, code: 'not-a-file' };
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return { ok: false, code: 'transcript-missing' };
  }
  if (!isInside(projects, real)) return { ok: false, code: 'outside-projects' };
  if (basename(real) !== name) return { ok: false, code: 'basename-mismatch' };
  return { ok: true, path: real };
}

/** Validates the `session` of a track request against the projects directory; reads no file. */
export async function validateSession(message: unknown, projectsDir: string): Promise<SessionValidation> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return refuse('malformed');
  const { sessionId, transcriptPath, cwd, event } = message as Record<string, unknown>;
  if (typeof sessionId !== 'string' || typeof transcriptPath !== 'string' || typeof cwd !== 'string' || typeof event !== 'string') return refuse('malformed');
  if (!SESSION_ID_PATTERN.test(sessionId)) return refuse('bad-session-id');
  if (!EVENT_PATTERN.test(event)) return refuse('bad-event');
  if (!isPath(cwd)) return refuse('bad-cwd');
  const checked = await checkTranscriptPath(transcriptPath, sessionId, projectsDir);
  if (!checked.ok) return refuse(checked.code);
  return { ok: true, session: { sessionId, transcriptPath: checked.path, cwd: normalize(cwd), event } };
}
