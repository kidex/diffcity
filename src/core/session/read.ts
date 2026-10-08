// Reading a session from disk for the digest (ADR-038), for a worker of the
// ADR-021 pool. The caller has already checked that the transcript lies under
// the Claude Code projects directory and is named after the session id (T16);
// this only reads. Each file is read from its cursor up to the read limit,
// never more. Sidechains live next to the transcript:
// `<dir>/<session>/subagents/agent-<agentId>.jsonl` and `.meta.json`.

import { open, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { applyAgentMeta, applyMainChunk, applySidechainChunk, emptyDigest, finalizeDigest, type DigestContext } from './digest.js';
import { SESSION_LIMITS, type SessionLimits } from './limits.js';
import type { TranscriptChunk } from './parse.js';
import type { SessionDigest } from './types.js';

/** The bytes of `path` from `offset` up to the read limit; null when the file does not exist. */
export async function readTranscriptChunk(path: string, offset: number, limits: Pick<SessionLimits, 'transcriptBytes'> = SESSION_LIMITS): Promise<TranscriptChunk | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.max(0, Math.min(size, limits.transcriptBytes) - offset);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { bytes: bytes.subarray(0, read), offset, fileSize: size };
  } finally {
    await handle.close();
  }
}

/** `<dir>/<session>/subagents` for the transcript `<dir>/<session>.jsonl`. */
export function subagentsDir(transcriptPath: string): string {
  return join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
}

export interface ReadSessionInput extends DigestContext {
  transcriptPath: string;
  /** The stored digest to continue from; a new one when omitted. */
  previous?: SessionDigest;
  /** The session is still running (the Stop hook fired, the session may go on). */
  active: boolean;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * The digest of the session at `transcriptPath`: the main transcript, then the
 * meta and sidechain file of every run it names, nested runs included, each
 * from its own cursor. A file rewritten shorter than its cursor starts over.
 */
export async function readSessionDigest(input: ReadSessionInput): Promise<SessionDigest> {
  const limits = input.limits ?? SESSION_LIMITS;
  const context: DigestContext = { repoRoot: input.repoRoot, limits, ...(input.home !== undefined ? { home: input.home } : {}) };
  const digest = input.previous ?? emptyDigest();
  const main = await readTranscriptChunk(input.transcriptPath, digest.state.main.parsedBytes, limits);
  if (main !== null && main.fileSize < digest.state.main.parsedBytes) {
    return readSessionDigest({ ...input, previous: emptyDigest() });
  }
  if (main !== null) applyMainChunk(digest, main, context);

  const dir = subagentsDir(input.transcriptPath);
  const done = new Set<string>();
  // Sidechains name nested runs: read until no new agentId appears.
  for (;;) {
    const pending = digest.runs.map((run) => run.agentId).filter((id): id is string => id !== null && !done.has(id));
    if (pending.length === 0) break;
    for (const agentId of pending) {
      done.add(agentId);
      // Not a path component from the transcript: an agentId is checked before it becomes a file name.
      if (!/^[A-Za-z0-9_-]+$/.test(agentId)) continue;
      const run = digest.runs.find((candidate) => candidate.agentId === agentId);
      // The meta file is written at launch: read once, until it gave a spawn depth.
      if (run?.spawnDepth === null) {
        applyAgentMeta(digest, agentId, await readJson(join(dir, `agent-${agentId}.meta.json`)), context);
      }
      const cursor = digest.state.sidechains[agentId]?.parsedBytes ?? 0;
      const side = await readTranscriptChunk(join(dir, `agent-${agentId}.jsonl`), cursor, limits);
      if (side !== null && side.fileSize >= cursor) applySidechainChunk(digest, agentId, side, context);
    }
  }
  return finalizeDigest(digest, { active: input.active, limits });
}

/** Whether `stat` says the transcript grew past the main cursor (the second read of ADR-038). */
export async function transcriptGrew(transcriptPath: string, digest: SessionDigest): Promise<boolean> {
  try {
    return (await stat(transcriptPath)).size > digest.state.main.parsedBytes;
  } catch {
    return false;
  }
}
