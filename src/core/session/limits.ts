// The size limits of a Claude Code session digest (ADR-038). Every limit is a
// field of one object so a test can shrink one without generating megabytes;
// the daemon always uses SESSION_LIMITS.

export interface SessionLimits {
  /** Bytes read from the main transcript and from each sidechain file; beyond it the digest is `truncated`. */
  transcriptBytes: number;
  /** Bytes of one transcript line; longer lines are skipped and counted. */
  lineBytes: number;
  /** UTF-8 bytes of one prompt, one question field or one answer. */
  promptBytes: number;
  /** UTF-8 bytes of one agent report, a truncated marker included. */
  reportBytes: number;
  /** Prompts per session; the latest are kept. */
  prompts: number;
  /** Questions per session; the latest are kept. */
  questions: number;
  /** Agent runs per session; the latest are kept. */
  runs: number;
  /** Files listed per session and per run. */
  files: number;
  /** UTF-8 bytes of the serialized digest. */
  digestBytes: number;
}

const MB = 1024 * 1024;
const KB = 1024;

export const SESSION_LIMITS: Readonly<SessionLimits> = Object.freeze({
  transcriptBytes: 64 * MB,
  lineBytes: 1 * MB,
  promptBytes: 4 * KB,
  reportBytes: 16 * KB,
  prompts: 200,
  questions: 100,
  runs: 200,
  files: 500,
  digestBytes: 1 * MB,
});

/** The marker appended to text cut at its limit. */
export const TRUNCATED_MARKER = '\n[truncated]';

/**
 * `text` cut to at most `maxBytes` UTF-8 bytes, the marker included, on a code
 * point boundary. Text within the limit is returned as is.
 */
export function truncateUtf8(text: string, maxBytes: number, marker: string = TRUNCATED_MARKER): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(budget, bytes.length);
  // Step back over continuation bytes so a code point is never split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8') + marker, truncated: true };
}
