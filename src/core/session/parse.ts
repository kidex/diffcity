// Transcript lines (ADR-038). A transcript is append-only JSONL: parsing resumes
// at `parsedBytes`, always a line boundary, and a partial last line waits for
// the next read. Only the first `limits.transcriptBytes` of a file are read;
// lines over `limits.lineBytes` are skipped and counted. Pure: the caller
// supplies the bytes read from `offset`.

import type { SessionLimits } from './limits.js';

/** Bytes of a transcript file starting at `offset`. */
export interface TranscriptChunk {
  /** File contents from `offset`; may stop anywhere, even inside a line. */
  bytes: Uint8Array;
  /** File offset of `bytes[0]`; equals the cursor's `parsedBytes`. */
  offset: number;
  /** Size of the whole file when it was read. */
  fileSize: number;
}

export interface LineSlice {
  /** Complete lines within the limits, without their line ends. */
  lines: string[];
  /** The new cursor: just past the last complete line consumed. */
  parsedBytes: number;
  /** Complete lines over the line limit, consumed unread. */
  skippedLines: number;
  /** The file is larger than the read limit. */
  truncated: boolean;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const decoder = new TextDecoder('utf-8');

/**
 * Calls `onLine` with each complete line of `chunk` within the limits, one at
 * a time, so a 64 MB read never holds all its lines at once.
 */
export function forEachLine(
  chunk: TranscriptChunk,
  limits: Pick<SessionLimits, 'transcriptBytes' | 'lineBytes'>,
  onLine: (line: string) => void,
): Omit<LineSlice, 'lines'> {
  const { bytes, offset, fileSize } = chunk;
  const readable = Math.max(0, Math.min(bytes.length, limits.transcriptBytes - offset));
  let skippedLines = 0;
  let pos = 0;
  while (pos < readable) {
    const nl = bytes.indexOf(NEWLINE, pos);
    if (nl === -1 || nl >= readable) break;
    let end = nl;
    if (end > pos && bytes[end - 1] === CARRIAGE_RETURN) end--;
    if (end - pos > limits.lineBytes) skippedLines++;
    else if (end > pos) onLine(decoder.decode(bytes.subarray(pos, end)));
    pos = nl + 1;
  }
  return { parsedBytes: offset + pos, skippedLines, truncated: fileSize > limits.transcriptBytes };
}

/** The complete lines of `chunk` that lie within the read limit. */
export function sliceLines(chunk: TranscriptChunk, limits: Pick<SessionLimits, 'transcriptBytes' | 'lineBytes'>): LineSlice {
  const lines: string[] = [];
  const rest = forEachLine(chunk, limits, (line) => lines.push(line));
  return { lines, ...rest };
}

/** A decoded transcript record: a JSON object, its fields unchecked. */
export type RawRecord = Readonly<Record<string, unknown>>;

/** The JSON object on `line`, or null when the line is not one. */
export function decodeRecord(line: string): RawRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isObject(value) ? value : null;
}

export function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `record.message.content`: a string, an array of blocks, or null. */
export function messageContent(record: RawRecord): string | readonly unknown[] | null {
  const message = record.message;
  if (!isObject(message)) return null;
  const content = message.content;
  if (typeof content === 'string' || Array.isArray(content)) return content;
  return null;
}
