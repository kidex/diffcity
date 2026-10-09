// The facts "send review to the agent" checks on disk (ADR-029): realpaths,
// whether the working tree still exists, the transcript of each linked
// session, and whether the repo is listed in agentLaunch.repos. Metadata only:
// no byte of a transcript is read.

import { realpath, stat } from 'node:fs/promises';
import { checkTranscriptPath } from '../session/validate.js';
import type { SessionCandidate } from './launch.js';

/** The realpath of `path`, or null when it cannot be resolved. */
export async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Whether `path` is an existing directory (following links). */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether the repo at `repoPath` is one of `listed`, both compared after realpath. An unresolvable path matches nothing. */
export async function repoListed(repoPath: string, listed: readonly string[]): Promise<boolean> {
  const repo = await realOrNull(repoPath);
  if (repo === null) return false;
  const reals = await Promise.all(listed.map(realOrNull));
  return reals.includes(repo);
}

/** A linked session as stored (src/core/db sessions). */
export interface LinkedSession {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
}

/** The candidates of chooseSession: each session's cwd realpath and transcript check, against `projectsDir`. */
export async function sessionCandidates(sessions: readonly LinkedSession[], projectsDir: string): Promise<SessionCandidate[]> {
  return Promise.all(
    sessions.map(async (session) => ({
      sessionId: session.sessionId,
      cwdReal: await realOrNull(session.cwd),
      transcriptOk: (await checkTranscriptPath(session.transcriptPath, session.sessionId, projectsDir)).ok,
      title: session.title,
      firstAt: session.firstAt,
      lastAt: session.lastAt,
    })),
  );
}
