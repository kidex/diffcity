// Claude Code session digests (ADR-038): a redacted, size-capped summary of a
// session's prompts, questions, agent runs and activity, parsed incrementally
// from the transcript files. Pure parsing plus a reader for a worker; the
// daemon, the database and the API wire it in elsewhere.

export {
  applyAgentMeta,
  applyMainChunk,
  applySidechainChunk,
  emptyActivity,
  emptyDigest,
  finalizeDigest,
  type DigestContext,
  type FinalizeOptions,
} from './digest.js';
export { SESSION_LIMITS, TRUNCATED_MARKER, truncateUtf8, type SessionLimits } from './limits.js';
export { decodeRecord, forEachLine, sliceLines, type LineSlice, type TranscriptChunk } from './parse.js';
export { readSessionDigest, readTranscriptChunk, subagentsDir, transcriptGrew, type ReadSessionInput } from './read.js';
export { createRedactor, redact, type RedactOptions, type RedactionKind, type Redactor } from './redact.js';
export {
  ACTIVITY_KINDS,
  DIGEST_FORMAT,
  type Activity,
  type ActivityKind,
  type AgentRun,
  type DigestState,
  type FileCursor,
  type RunStatus,
  type SessionDigest,
  type SessionPrompt,
  type SessionQuestion,
} from './types.js';
