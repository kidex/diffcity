// One read of a session for a worker of the ADR-021 pool (ADR-038): the stored
// digest in, the next digest out, both serialized. The transcript path is
// checked again right before the read, since the file may have been replaced
// since the hook. A failure is a code, never a message that could carry a
// path or transcript content.

import { realpath } from 'node:fs/promises';
import { readSessionDigest, transcriptGrew } from './read.js';
import { DIGEST_FORMAT, type SessionDigest } from './types.js';
import { checkTranscriptPath } from './validate.js';

export interface SessionJob {
  sessionId: string;
  /** The stored realpath of the transcript. */
  transcriptPath: string;
  /** `<claude config dir>/projects`. */
  projectsDir: string;
  /** The stored digest; null for the first read. */
  previous: string | null;
  /** The working tree the session ran in: edited files are listed relative to it. */
  repoRoot: string | null;
  /** False once the session ended (`SessionEnd`): runs with no outcome are `unknown`, not `running`. */
  active: boolean;
  /** The home directory the redactor replaces by `~`; os.homedir() when omitted. */
  home?: string | null;
}

export type SessionJobResult =
  | {
      ok: true;
      /** The serialized SessionDigest. */
      digest: string;
      /** The main transcript's cursor, mirrored into `sessions.parsedBytes`. */
      parsedBytes: number;
      title: string | null;
      firstAt: string | null;
      lastAt: string | null;
      /** The transcript is already larger than what was read. */
      grew: boolean;
      /** The distinct working directories of the runs (realpaths when they exist), for linking changes. */
      runDirs: string[];
    }
  | { ok: false; code: string };

/** A stored digest of this format, or null to start over. */
function previousDigest(text: string | null): SessionDigest | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<SessionDigest> | null;
    return value !== null && value.format === DIGEST_FORMAT && typeof value.state === 'object' ? (value as SessionDigest) : null;
  } catch {
    return null;
  }
}

/** Replaces each run's working directory by its realpath, so it compares with the working trees; a missing one stays as written. */
async function resolveRunDirs(digest: SessionDigest): Promise<void> {
  const cwds = digest.state.cwds;
  if (cwds === undefined) return;
  const resolved = new Map<string, string>();
  for (const [agentId, dir] of Object.entries(cwds)) {
    let real = resolved.get(dir);
    if (real === undefined) {
      real = await realpath(dir).catch(() => dir);
      resolved.set(dir, real);
    }
    cwds[agentId] = real;
  }
}

export async function runSessionJob(job: SessionJob): Promise<SessionJobResult> {
  const checked = await checkTranscriptPath(job.transcriptPath, job.sessionId, job.projectsDir);
  if (!checked.ok) return { ok: false, code: checked.code };
  try {
    const previous = previousDigest(job.previous);
    const digest = await readSessionDigest({
      transcriptPath: checked.path,
      active: job.active,
      repoRoot: job.repoRoot,
      ...(job.home === undefined ? {} : { home: job.home }),
      ...(previous === null ? {} : { previous }),
    });
    await resolveRunDirs(digest);
    return {
      ok: true,
      runDirs: [...new Set(Object.values(digest.state.cwds ?? {}))],
      digest: JSON.stringify(digest),
      parsedBytes: digest.state.main.parsedBytes,
      title: digest.title,
      firstAt: digest.firstAt,
      lastAt: digest.lastAt,
      grew: await transcriptGrew(checked.path, digest),
    };
  } catch {
    return { ok: false, code: 'read-failed' };
  }
}
