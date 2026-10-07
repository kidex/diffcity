import { diffLines, type LineOp } from '../diff/lines.js';
import { rowText } from '../diff/row-text.js';
import type { DiffLine, Status } from '../report/types.js';

// Step.diff (ADR-034): the lines between a symbol's before and after slices,
// three lines of context around each change, at most STEP_MAX_LINES lines,
// each at most MAX_ROW_TEXT characters (the file view's rule, row-text.ts).

/** Unchanged lines kept on each side of a change. */
export const STEP_CONTEXT = 3;
/** Most lines in one step's diff, the closing `... N more lines` included. */
export const STEP_MAX_LINES = 120;
/** The `ctx` line that stands for unchanged lines left out between two changes. */
export const STEP_GAP = '...';

/** Lines `range.start`..`range.end` (1-based, inclusive) of `source`, without a trailing CR. */
export function sliceLines(source: string | null, range: { start: number; end: number } | undefined): string[] | null {
  if (source === null || range === undefined) return null;
  return source
    .split('\n')
    .slice(Math.max(range.start, 1) - 1, Math.max(range.end, 0))
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Changes with STEP_CONTEXT lines around them; a longer unchanged run between two changes becomes one STEP_GAP line. */
function withContext(ops: readonly LineOp[]): DiffLine[] {
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, index) => {
    if (op.kind === 'ctx') return;
    for (let i = Math.max(0, index - STEP_CONTEXT); i <= Math.min(ops.length - 1, index + STEP_CONTEXT); i++) keep[i] = 1;
  });
  const out: DiffLine[] = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (keep[index] === 1) {
      if (skipped && out.length > 0) out.push({ kind: 'ctx', text: STEP_GAP });
      skipped = false;
      out.push({ kind: op.kind, text: op.text });
    } else {
      skipped = true;
    }
  });
  return out;
}

/**
 * At most STEP_MAX_LINES lines, each cut to MAX_ROW_TEXT characters; a longer
 * list ends with a `ctx` line `... N more lines`.
 */
export function capStepDiff(lines: DiffLine[]): DiffLine[] {
  const cut = (line: DiffLine): DiffLine => ({ kind: line.kind, text: rowText(line.text).text });
  if (lines.length <= STEP_MAX_LINES) return lines.map(cut);
  const shown = lines.slice(0, STEP_MAX_LINES - 1).map(cut);
  const more = lines.length - shown.length;
  shown.push({ kind: 'ctx', text: `... ${String(more)} more ${more === 1 ? 'line' : 'lines'}` });
  return shown;
}

/**
 * The diff of one step. A new symbol shows all its lines as `add`, a removed
 * one all as `del`; otherwise the slices are diffed line by line. `same`
 * symbols are not steps: their diff is empty.
 */
export function stepDiff(status: Status, before: readonly string[] | null, after: readonly string[] | null): DiffLine[] {
  if (status === 'same') return [];
  if (status === 'add' || before === null) return capStepDiff((after ?? []).map((text) => ({ kind: 'add', text })));
  if (status === 'del' || after === null) return capStepDiff(before.map((text) => ({ kind: 'del', text })));
  return capStepDiff(withContext(diffLines(before, after)));
}
