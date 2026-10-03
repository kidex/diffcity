// Validation of a review write body (ADR-028), pure. Returns the clean input or
// the first problem as a message; the route turns a message into a 400.

import type { ReviewMarkValue } from '../model/types.js';
import type { TargetRef } from './types.js';

export const MARK_NOTE_MAX = 2000;
export const GENERAL_NOTE_MAX = 4000;
export const TARGET_ID_MAX = 512;

export interface MarkInput {
  snapshotId: number;
  target: TargetRef;
  mark: ReviewMarkValue;
  note: string | null;
  lines: { side: 'old' | 'new'; start: number; end: number } | null;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MARKS: readonly string[] = ['checked', 'good', 'rewrite'];

export function parseTargetKind(value: unknown): 'file' | 'symbol' | null {
  return value === 'file' || value === 'symbol' ? value : null;
}

export function parseTargetId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= TARGET_ID_MAX ? value : null;
}

export function validateMarkInput(body: unknown): Validated<MarkInput> {
  if (!isRecord(body)) return fail('the body must be a JSON object');
  const { snapshotId, target, mark, note, lines } = body;
  if (typeof snapshotId !== 'number' || !Number.isSafeInteger(snapshotId) || snapshotId < 1) {
    return fail('snapshotId must be a positive integer');
  }
  if (!isRecord(target)) return fail('target must be an object { kind, id }');
  const kind = parseTargetKind(target['kind']);
  if (kind === null) return fail("target.kind must be 'file' or 'symbol'");
  const id = parseTargetId(target['id']);
  if (id === null) return fail(`target.id must be a string of 1 to ${String(TARGET_ID_MAX)} characters`);
  if (typeof mark !== 'string' || !MARKS.includes(mark)) return fail("mark must be 'checked', 'good' or 'rewrite'");
  const markValue = mark as ReviewMarkValue;

  let cleanNote: string | null = null;
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') return fail('note must be a string');
    if (note.length > MARK_NOTE_MAX) return fail(`note must be at most ${String(MARK_NOTE_MAX)} characters`);
    cleanNote = note.trim() === '' ? null : note;
  }
  if (markValue === 'rewrite' && cleanNote === null) return fail('a rewrite mark needs a note of 1 to 2000 characters');

  let cleanLines: MarkInput['lines'] = null;
  if (lines !== undefined && lines !== null) {
    if (!isRecord(lines)) return fail('lines must be an object { side, start, end }');
    const { side, start, end } = lines;
    if (side !== 'old' && side !== 'new') return fail("lines.side must be 'old' or 'new'");
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1) return fail('lines.start must be an integer of at least 1');
    if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < start) return fail('lines.end must be an integer of at least lines.start');
    cleanLines = { side, start, end };
  }
  return { ok: true, value: { snapshotId, target: { kind, id }, mark: markValue, note: cleanNote, lines: cleanLines } };
}

/** `{ note }`: a string of at most 4000 characters; the empty string clears the note. */
export function validateGeneralNote(body: unknown): Validated<string> {
  if (!isRecord(body) || typeof body['note'] !== 'string') return fail('the body must be { note: string }');
  if (body['note'].length > GENERAL_NOTE_MAX) return fail(`note must be at most ${String(GENERAL_NOTE_MAX)} characters`);
  return { ok: true, value: body['note'] };
}
