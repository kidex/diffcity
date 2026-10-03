// Review marks as the screen reads them (ADR-028, SPEC.md section 6). Pure: no
// DOM, no three.js, unit-tested in Node. The daemon decides everything that
// matters (outdated, progress, the summary); this only maps its answers to what
// the scene and the HUD draw, validates a note before it is sent, and applies a
// mark to a copy of the state so the screen can answer at once (optimistic
// update) and put the old one back when the write fails.

import type { ReviewMark, ReviewMarkValue } from '../../../../core/model/types.js';
import type { Marks, MarkKind } from './critical.js';
import type { MarkTip } from './hud.js';
import type { Report } from '../../../../core/report/types.js';
import type { MarkRequest, ReviewState } from '../ports.js';

export type ReviewTarget = MarkRequest['target'];

export const MARK_LABEL: Record<ReviewMarkValue, string> = { checked: 'Checked', good: 'Looks good', rewrite: 'Needs rewrite' };
/** The keys of the three marks and of undo, as the buttons show them. */
export const MARK_KEY: Record<ReviewMarkValue, string> = { checked: 'C', good: 'G', rewrite: 'W' };

/** What a tooltip and the file view say about a mark whose target changed after it was made. */
export const OUTDATED_HINT = 'changed since you checked it';

/** A note of a "Needs rewrite" mark: 1 to 2,000 characters (ADR-028). */
export const NOTE_MAX = 2000;

/** Why `note` cannot be sent, or null when it can. A note of spaces is empty. */
export function noteProblem(note: string): string | null {
  if (note.trim() === '') return 'Say what needs to be rewritten: a note is required.';
  if (note.length > NOTE_MAX) return `The note is ${String(note.length - NOTE_MAX)} characters too long (at most ${String(NOTE_MAX)}).`;
  return null;
}

/** What the scene draws for `mark`: an outdated mark looks unchecked. */
export const markKind = (mark: ReviewMark): MarkKind => (mark.state === 'outdated' ? 'outdated' : mark.mark);

/** The marks as the scene takes them, by file id and symbol id; none without a state. */
export function marksOf(state: ReviewState | null): Marks | undefined {
  if (state === null) return undefined;
  const files = new Map<string, MarkKind>();
  const symbols = new Map<string, MarkKind>();
  for (const mark of state.marks) (mark.targetKind === 'file' ? files : symbols).set(mark.targetId, markKind(mark));
  return { files, symbols };
}

export function markOf(state: ReviewState | null, target: ReviewTarget): ReviewMark | undefined {
  return state?.marks.find((mark) => mark.targetKind === target.kind && mark.targetId === target.id);
}

/** "new 3 to 5", "old 7": the range as a person reads it. */
export const linesText = (lines: NonNullable<ReviewMark['lines']>): string =>
  `${lines.side} line${lines.start === lines.end ? ` ${String(lines.start)}` : `s ${String(lines.start)}–${String(lines.end)}`}`;

/** The state with `request` applied as the daemon will: one mark per target, replaced when it exists. Progress is the daemon's, so it stays as it was. */
export function withMark(state: ReviewState, request: MarkRequest, filePath: string, now: string): ReviewState {
  const previous = markOf(state, request.target);
  const mark: ReviewMark = {
    targetKind: request.target.kind,
    targetId: request.target.id,
    filePath,
    mark: request.mark,
    note: request.note ?? null,
    lines: request.lines ?? null,
    state: 'current',
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    outdatedAt: null,
  };
  return { ...state, marks: [...state.marks.filter((other) => other !== previous), mark] };
}

export function withoutMark(state: ReviewState, target: ReviewTarget): ReviewState {
  return { ...state, marks: state.marks.filter((mark) => !(mark.targetKind === target.kind && mark.targetId === target.id)) };
}

/** `previous` put back for `target` (a failed write): the mark it had, or none. */
export function restored(state: ReviewState, target: ReviewTarget, previous: ReviewMark | undefined): ReviewState {
  const without = withoutMark(state, target);
  return previous === undefined ? without : { ...without, marks: [...without.marks, previous] };
}

export interface ProgressView {
  /** "N of M files that need your eyes checked", or the sentence for everything done. */
  headline: string;
  done: boolean;
  /** Touched files checked, "Needs rewrite" marks and (when any) marks that went stale, as short lines. */
  touched: string;
  rewrite: string;
  outdated: string | null;
  /** Attention files done and total, for a bar. */
  attention: { done: number; total: number };
}

export const ALL_CHECKED = 'Everything that needs your eyes is checked';

export function progressView(progress: ReviewState['progress']): ProgressView {
  const { attention, touched, rewrite, outdated } = progress;
  const done = progress.allAttentionDone;
  return {
    headline: done
      ? ALL_CHECKED
      : attention.total === 0
        ? 'No files need your eyes'
        : `${String(attention.done)} of ${String(attention.total)} files that need your eyes checked`,
    done,
    touched: `${String(touched.done)} of ${String(touched.total)} touched files checked`,
    rewrite: `${String(rewrite)} to rewrite`,
    outdated: outdated === 0 ? null : `${String(outdated)} changed since you checked ${outdated === 1 ? 'it' : 'them'}`,
    attention,
  };
}

/** What a mark would be put on: a touched file, or one of its symbols (the focused floor). */
export interface TargetInfo {
  target: ReviewTarget;
  filePath: string;
  /** "this file" or the symbol's name, for the buttons' caption. */
  label: string;
  /** The target is a symbol. */
  symbol: boolean;
  /** The focused floor, when there is one, whichever the target is: the reviewer can switch between the floor and the whole file. */
  floor: { id: string; name: string } | null;
}

/**
 * The target of the review actions for the selected file and focused floor:
 * the focused symbol, else the file; `wholeFile` puts the mark on the file
 * even when a floor is focused. Null for a file that is not in the Report or
 * is untouched (ADR-028: untouched files cannot be marked).
 */
export function targetFor(report: Report, fileId: string, symbolId: string | null, wholeFile = false): TargetInfo | null {
  for (const pkg of report.packages) {
    for (const file of pkg.files) {
      if (file.id !== fileId) continue;
      if (file.status === 'same') return null;
      const symbol = symbolId === null ? undefined : file.symbols.find((candidate) => candidate.id === symbolId);
      const floor = symbol === undefined ? null : { id: symbol.id, name: symbol.name };
      if (symbol !== undefined && !wholeFile) return { target: { kind: 'symbol', id: symbol.id }, filePath: file.path, label: symbol.name, symbol: true, floor };
      return { target: { kind: 'file', id: file.id }, filePath: file.path, label: 'this file', symbol: false, floor };
    }
  }
  return null;
}

/** The tooltip's line for a mark: the mark, "changed since you checked it" when outdated, and its note. Null for none. */
export function markTip(mark: ReviewMark | undefined): MarkTip | null {
  if (mark === undefined) return null;
  return { label: MARK_LABEL[mark.mark], mark: mark.mark, hint: mark.state === 'outdated' ? OUTDATED_HINT : null, note: mark.note === null || mark.note === '' ? null : mark.note };
}

/** The mark under the pointer: the floor's own, else the file's. */
export function tipMark(state: ReviewState | null, fileId: string, symbolId: string | null): MarkTip | null {
  if (state === null) return null;
  const own = symbolId === null ? undefined : markOf(state, { kind: 'symbol', id: symbolId });
  return markTip(own ?? markOf(state, { kind: 'file', id: fileId }));
}
