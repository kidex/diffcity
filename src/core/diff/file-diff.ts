// The diff of one file for the file view (ADR-027): rows with line numbers,
// hunks, folds, symbol spans and highlights, computed on request against the
// snapshot's own merge-base (and head, for a clean change). Pure apart from
// the injected git (diff-git.ts): every byte comes through it, never through
// the filesystem. Runs in a worker thread of the daemon.

import { createHash } from 'node:crypto';
import { GitError } from '../git/exec.js';
import { looksBinary } from '../git/files.js';
import type { DiffRow, FileDiff, FileFingerprint, HighlightClass } from '../model/types.js';
import type { Status } from '../report/types.js';
import type { DiffGit } from './diff-git.js';
import { highlightLanguage, highlightLines, type LineSpans } from './highlight.js';

/** Either side above this many bytes: `too-large`. */
export const MAX_SIDE_BYTES = 2 * 1024 * 1024;
/** Either side above this many lines: `too-large`. */
export const MAX_SIDE_LINES = 50_000;
/** More rows than this: `too-large`. */
export const MAX_ROWS = 60_000;
/** A response of more JSON than this: `too-large`. */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Highlighting runs only when each side is at most this many bytes. */
export const MAX_HIGHLIGHT_BYTES = 512 * 1024;
/** Longest row text, in characters. */
export const MAX_ROW_TEXT = 4000;
/** A run of unchanged rows longer than this is folded... */
export const FOLD_AFTER_ROWS = 8;
/** ...leaving this many rows visible on each side. */
export const FOLD_CONTEXT_ROWS = 3;

/** git diff output past this is not read: the file is too large for the view (two full sides, plus headers). */
const MAX_DIFF_OUTPUT_BYTES = 2 * MAX_SIDE_BYTES + 4 * 1024 * 1024;

/** A symbol of the file as the Report has it; only what the spans need. */
export interface DiffSymbol {
  id: string;
  status: Status;
  /** After-range, or before-range for `del` (SPEC.md section 4.1). */
  range: { start: number; end: number };
}

/** Plain data, so it crosses postMessage into the worker. */
export interface FileDiffRequest {
  snapshotId: number;
  head: string;
  /** Null on a snapshot written before schema v2. */
  mergeBase: string | null;
  /** The after side is the working tree (a dirty change), not `head`. */
  worktree: boolean;
  path: string;
  language: string;
  /** The stored fingerprint of the file in the snapshot. */
  fingerprint: FileFingerprint;
  symbols: DiffSymbol[];
  /** A symbol id of this file to focus. */
  focus?: string | undefined;
}

interface RawRow {
  kind: DiffRow['kind'];
  old: number | null;
  new: number | null;
  bytes: Buffer;
}

export interface ParsedUnifiedDiff {
  rows: RawRow[];
  binary: boolean;
  /** git said `new file` / `deleted file` for some part of the output. */
  sawAdded: boolean;
  sawDeleted: boolean;
  /** The last line of that side has no trailing newline. */
  noEolBefore: boolean;
  noEolAfter: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses `git diff --unified=<huge>` output of one file (more than one section
 * for a type change) into rows. Hunk lines are counted from the `@@` header,
 * so a content line that looks like a header is never taken for one.
 */
export function parseUnifiedDiff(output: Buffer): ParsedUnifiedDiff {
  const parsed: ParsedUnifiedDiff = { rows: [], binary: false, sawAdded: false, sawDeleted: false, noEolBefore: false, noEolAfter: false };
  let oldLeft = 0;
  let newLeft = 0;
  let oldLine = 0;
  let newLine = 0;
  let offset = 0;
  while (offset < output.length) {
    let end = output.indexOf(0x0a, offset);
    if (end === -1) end = output.length;
    const line = output.subarray(offset, end);
    offset = end + 1;
    const first = line[0];

    if (first === 0x5c /* \ No newline at end of file */) {
      const last = parsed.rows.at(-1);
      if (last !== undefined) {
        if (last.kind !== 'add') parsed.noEolBefore = true;
        if (last.kind !== 'del') parsed.noEolAfter = true;
      }
      continue;
    }
    if (oldLeft > 0 || newLeft > 0) {
      const text = line.subarray(1);
      if (first === 0x2b /* + */) {
        parsed.rows.push({ kind: 'add', old: null, new: newLine++, bytes: text });
        newLeft--;
      } else if (first === 0x2d /* - */) {
        parsed.rows.push({ kind: 'del', old: oldLine++, new: null, bytes: text });
        oldLeft--;
      } else {
        // A context line starts with a space; some tools strip the space of an empty one.
        parsed.rows.push({ kind: 'ctx', old: oldLine++, new: newLine++, bytes: first === 0x20 ? text : line });
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const header = line.toString('latin1');
    const hunk = HUNK.exec(header);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
    } else if (header.startsWith('Binary files ') || header.startsWith('GIT binary patch')) {
      parsed.binary = true;
    } else if (header.startsWith('new file mode')) {
      parsed.sawAdded = true;
    } else if (header.startsWith('deleted file mode')) {
      parsed.sawDeleted = true;
    }
  }
  return parsed;
}

/** `\n`-terminated lines of `bytes`, and whether the last one lacks its newline. */
function splitLines(bytes: Buffer): { lines: Buffer[]; noEol: boolean } {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0x0a, offset);
    if (end === -1) {
      lines.push(bytes.subarray(offset));
      return { lines, noEol: true };
    }
    lines.push(bytes.subarray(offset, end));
    offset = end + 1;
  }
  return { lines, noEol: false };
}

/** The file bytes of `lines`: joined with `\n`, ending with one unless `noEol`. */
function joinLines(lines: readonly Buffer[], noEol: boolean): Buffer {
  if (lines.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  lines.forEach((line, index) => {
    parts.push(line);
    if (index < lines.length - 1 || !noEol) parts.push(NEWLINE);
  });
  return Buffer.concat(parts);
}

const NEWLINE = Buffer.from('\n');

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Row text for the screen: no trailing CR, at most MAX_ROW_TEXT characters, never a split surrogate pair. */
function displayText(bytes: Buffer): { text: string; cut: boolean } {
  let text = bytes.toString('utf8');
  if (text.endsWith('\r')) text = text.slice(0, -1);
  if (text.length <= MAX_ROW_TEXT) return { text, cut: false };
  let end = MAX_ROW_TEXT;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

/** First and last row of each run of rows for which `inRun` holds. */
function runsOf(rows: readonly RawRow[], inRun: (row: RawRow) => boolean): { first: number; last: number }[] {
  const runs: { first: number; last: number }[] = [];
  let start = -1;
  rows.forEach((row, index) => {
    if (inRun(row)) {
      if (start === -1) start = index;
    } else if (start !== -1) {
      runs.push({ first: start, last: index - 1 });
      start = -1;
    }
  });
  if (start !== -1) runs.push({ first: start, last: rows.length - 1 });
  return runs;
}

/** Runs of unchanged rows longer than FOLD_AFTER_ROWS, less FOLD_CONTEXT_ROWS rows on each side. */
export function foldsOf(rows: readonly { kind: DiffRow['kind'] }[]): { first: number; last: number }[] {
  return runsOf(rows as RawRow[], (row) => row.kind === 'ctx')
    .filter((run) => run.last - run.first + 1 > FOLD_AFTER_ROWS)
    .map((run) => ({ first: run.first + FOLD_CONTEXT_ROWS, last: run.last - FOLD_CONTEXT_ROWS }));
}

/** Runs of changed rows: what next/previous hunk jumps between. */
export function hunksOf(rows: readonly { kind: DiffRow['kind'] }[]): { first: number; last: number }[] {
  return runsOf(rows as RawRow[], (row) => row.kind !== 'ctx');
}

/**
 * The rows of each symbol: its after-range (before-range for `del`), from the
 * first to the last row that has a line in it. Removed rows between them belong
 * to the span; the ones outside do not.
 */
export function symbolSpans(rows: readonly { old: number | null; new: number | null }[], symbols: readonly DiffSymbol[]): Map<string, { first: number; last: number }> {
  let oldLines = 0;
  let newLines = 0;
  for (const row of rows) {
    if (row.old !== null) oldLines = Math.max(oldLines, row.old);
    if (row.new !== null) newLines = Math.max(newLines, row.new);
  }
  const byOld = new Int32Array(oldLines + 2).fill(-1);
  const byNew = new Int32Array(newLines + 2).fill(-1);
  rows.forEach((row, index) => {
    if (row.old !== null) byOld[row.old] = index;
    if (row.new !== null) byNew[row.new] = index;
  });
  const spans = new Map<string, { first: number; last: number }>();
  for (const symbol of symbols) {
    const index = symbol.status === 'del' ? byOld : byNew;
    const lines = symbol.status === 'del' ? oldLines : newLines;
    // Lines of a range that are not in the rows (a stale snapshot) are skipped.
    let start = Math.max(symbol.range.start, 1);
    let end = Math.min(symbol.range.end, lines);
    while (start <= end && index[start] === -1) start++;
    while (end >= start && index[end] === -1) end--;
    if (start > end) continue;
    spans.set(symbol.id, { first: index[start] as number, last: index[end] as number });
  }
  return spans;
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=dirty', '-M'];

const GONE = 'git cannot read the file: its commits or its working tree are no longer available.';

class Unavailable extends Error {}

/** Sizes in bytes of the sides git can measure up front. */
interface Sides {
  beforePath: string | null;
  afterPath: string | null;
  before: number | null;
  after: number | null;
}

function addStats(rows: readonly RawRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added++;
    else if (row.kind === 'del') removed++;
  }
  return { added, removed };
}

/** A diff with nothing to show: `unavailable`, with the reason. */
export function unavailableFileDiff(snapshot: { snapshotId: number; head: string; path: string; language: string }, reason: string): FileDiff {
  return {
    snapshotId: snapshot.snapshotId,
    head: snapshot.head,
    path: snapshot.path,
    language: snapshot.language,
    kind: 'unavailable',
    reason,
    stale: false,
    stats: { added: 0, removed: 0 },
    sizes: { before: null, after: null },
  };
}

/**
 * The diff of one file of a snapshot. Never throws for a file that git cannot
 * read: that is `unavailable`, with the reason. `request.path` and
 * `request.focus` must already be known to belong to the snapshot.
 */
export async function computeFileDiff(request: FileDiffRequest, git: DiffGit): Promise<FileDiff> {
  const { fingerprint } = request;
  const oldPath = fingerprint.oldPath !== undefined && fingerprint.oldPath !== request.path ? fingerprint.oldPath : undefined;
  const base: FileDiff = {
    snapshotId: request.snapshotId,
    head: request.head,
    path: request.path,
    ...(oldPath === undefined ? {} : { oldPath }),
    language: request.language,
    kind: 'unavailable',
    stale: false,
    stats: { added: 0, removed: 0 },
    sizes: { before: null, after: null },
  };
  const finish = (fields: Partial<FileDiff>): FileDiff => ({ ...base, ...fields });
  const { mergeBase } = request;
  if (mergeBase === null) {
    return finish({ reason: 'This snapshot predates the file view; a new one is being computed.' });
  }

  const sides: Sides = {
    beforePath: fingerprint.before === null ? null : (oldPath ?? request.path),
    afterPath: fingerprint.after === null ? null : request.path,
    before: null,
    after: null,
  };
  const pathspec = [...(oldPath === undefined ? [] : [oldPath]), request.path];
  const revisions = request.worktree ? [mergeBase] : [mergeBase, request.head];

  const sizeOf = async (revision: string, path: string): Promise<number> => {
    const result = await git.run(['cat-file', '-s', `${revision}:${path}`]);
    const size = Number(result.stdout.toString('utf8').trim());
    if (result.exitCode !== 0 || !Number.isSafeInteger(size)) throw new Unavailable(GONE);
    return size;
  };

  const numstat = async (env: Record<string, string> | undefined): Promise<{ added: number; removed: number }> => {
    const result = await git.run(['diff', ...DIFF_FLAGS, '--numstat', '-z', ...revisions, '--', ...pathspec], env === undefined ? {} : { env });
    const tokens = result.stdout.toString('utf8').split('\0');
    let added = 0;
    let removed = 0;
    for (let i = 0; i < tokens.length; i++) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i] ?? '');
      if (match === null) continue;
      added += match[1] === '-' ? 0 : Number(match[1]);
      removed += match[2] === '-' ? 0 : Number(match[2]);
      // A rename is `A\tD\t\0old\0new\0`: skip the two paths.
      if (match[3] === '') i += 2;
    }
    return { added, removed };
  };

  /** `untracked`: the after side of a working tree change is a file git does not track yet. */
  const withIndex = async <T>(untracked: boolean, fn: (env: Record<string, string> | undefined) => Promise<T>): Promise<T> =>
    untracked ? git.withUntrackedIndex([request.path], fn) : fn(undefined);

  const tooLarge = async (reason: string, untracked: boolean): Promise<FileDiff> =>
    finish({ kind: 'too-large', reason, sizes: { before: sides.before, after: sides.after }, stats: await withIndex(untracked, numstat) });

  try {
    if (sides.beforePath !== null) sides.before = await sizeOf(mergeBase, sides.beforePath);
    if (!request.worktree && sides.afterPath !== null) sides.after = await sizeOf(request.head, sides.afterPath);

    let untracked = false;
    if (request.worktree && sides.afterPath !== null && (sides.beforePath === null || oldPath !== undefined)) {
      const listed = await git.run(['ls-files', '-z', '--others', '--exclude-standard', '--full-name', '--', request.path]);
      untracked = listed.exitCode === 0 && listed.stdout.toString('utf8').split('\0').includes(request.path);
    }

    if ((sides.before ?? 0) > MAX_SIDE_BYTES || (sides.after ?? 0) > MAX_SIDE_BYTES) {
      return await tooLarge('A side of this file is larger than 2 MiB.', untracked);
    }

    const output = await withIndex(untracked, (env) => {
      // Without the temporary index git would show nothing for an untracked file.
      if (untracked && env === undefined) throw new Unavailable('git cannot read this untracked file: it is gone or the index is missing.');
      return git.run(['diff', ...DIFF_FLAGS, '--histogram', '--unified=1000000', ...revisions, '--', ...pathspec], {
        maxOutput: MAX_DIFF_OUTPUT_BYTES,
        ...(env === undefined ? {} : { env }),
      });
    }).catch((error: unknown) => {
      if (error instanceof GitError && error.code === 'output-limit') return null;
      throw error;
    });
    if (output === null) return await tooLarge('The diff of this file is larger than the limit.', untracked);
    if (output.exitCode !== 0) throw new Unavailable(GONE);

    const parsed = parseUnifiedDiff(output.stdout);
    if (parsed.binary) return finish({ kind: 'binary', sizes: { before: sides.before, after: sides.after } });

    let rows = parsed.rows;
    let noEolBefore = parsed.noEolBefore;
    let noEolAfter = parsed.noEolAfter;
    let afterExists = !(parsed.sawDeleted && !parsed.sawAdded);
    let beforeBytes: Buffer | null = null;
    let afterBytes: Buffer | null = null;

    if (rows.length === 0 && !parsed.sawAdded && !parsed.sawDeleted && sides.beforePath !== null && sides.afterPath !== null) {
      // The two sides have the same bytes (an untouched file, a pure rename): read them as context.
      const blob = await git.run(['cat-file', 'blob', `${mergeBase}:${sides.beforePath}`]);
      if (blob.exitCode !== 0) throw new Unavailable(GONE);
      if (looksBinary(blob.stdout)) return finish({ kind: 'binary', sizes: { before: blob.stdout.length, after: blob.stdout.length } });
      const split = splitLines(blob.stdout);
      rows = split.lines.map((bytes, index) => ({ kind: 'ctx' as const, old: index + 1, new: index + 1, bytes }));
      noEolBefore = split.noEol;
      noEolAfter = split.noEol;
      beforeBytes = blob.stdout;
      afterBytes = blob.stdout;
      afterExists = true;
    }

    const beforeLines = rows.filter((row) => row.kind !== 'add').map((row) => row.bytes);
    const afterLines = rows.filter((row) => row.kind !== 'del').map((row) => row.bytes);
    beforeBytes ??= sides.beforePath === null ? null : joinLines(beforeLines, noEolBefore);
    afterBytes ??= afterExists ? joinLines(afterLines, noEolAfter) : null;
    const sizes = {
      before: sides.before ?? beforeBytes?.length ?? null,
      after: sides.after ?? afterBytes?.length ?? null,
    };

    const stats = addStats(rows);
    if (rows.length > MAX_ROWS || beforeLines.length > MAX_SIDE_LINES || afterLines.length > MAX_SIDE_LINES || (afterBytes?.length ?? 0) > MAX_SIDE_BYTES) {
      return finish({ kind: 'too-large', reason: 'This file has more lines than the view shows.', sizes, stats: await withIndex(untracked, numstat) });
    }

    const stale = (afterBytes === null ? null : sha256(afterBytes)) !== fingerprint.after;

    let beforeHl: LineSpans[] | null = null;
    let afterHl: LineSpans[] | null = null;
    if (
      highlightLanguage(request.language) !== null &&
      (beforeBytes?.length ?? 0) <= MAX_HIGHLIGHT_BYTES &&
      (afterBytes?.length ?? 0) <= MAX_HIGHLIGHT_BYTES
    ) {
      // A parse failure is no highlighting, never a failed diff.
      beforeHl = await highlightLines(request.language, joinLines(beforeLines, true).toString('utf8')).catch(() => null);
      afterHl = await highlightLines(request.language, joinLines(afterLines, true).toString('utf8')).catch(() => null);
    }

    // Position of each row in its side's text: the before side holds ctx and del rows, the after side ctx and add rows.
    let beforeIndex = 0;
    let afterIndex = 0;
    const outRows: DiffRow[] = rows.map((row) => {
      const { text, cut } = displayText(row.bytes);
      const out: DiffRow = { kind: row.kind, old: row.old, new: row.new, text };
      if (cut) out.cut = true;
      const inBefore = row.kind !== 'add';
      const inAfter = row.kind !== 'del';
      const beforeSpans = inBefore ? beforeHl?.[beforeIndex++] : undefined;
      const afterSpans = inAfter ? afterHl?.[afterIndex++] : undefined;
      const spans = row.kind === 'del' ? beforeSpans : afterSpans;
      const hl = (spans ?? []).filter(([start]) => start < text.length).map(([start, end, cls]): [number, number, HighlightClass] => [start, Math.min(end, text.length), cls]);
      if (hl.length > 0) out.hl = hl;
      return out;
    });

    const changed = rows.some((row) => row.kind !== 'ctx');
    const symbolRows = symbolSpans(rows, request.symbols);
    const focusSpan = request.focus === undefined ? undefined : symbolRows.get(request.focus);
    const kind = changed || oldPath !== undefined || parsed.sawAdded || parsed.sawDeleted ? 'text' : 'unchanged';
    const result = finish({
      kind,
      stale,
      stats,
      sizes,
      rows: outRows,
      ...(kind === 'text' ? { hunks: hunksOf(rows), folds: foldsOf(rows) } : {}),
      symbols: request.symbols.flatMap((symbol) => {
        const span = symbolRows.get(symbol.id);
        return span === undefined ? [] : [{ id: symbol.id, ...span }];
      }),
      ...(request.focus !== undefined && focusSpan !== undefined ? { focus: { id: request.focus, ...focusSpan } } : {}),
    });
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_JSON_BYTES) {
      return finish({ kind: 'too-large', reason: 'The diff of this file is larger than the limit.', sizes, stats });
    }
    return result;
  } catch (error) {
    if (error instanceof Unavailable) return finish({ reason: error.message });
    if (error instanceof GitError) return finish({ reason: GONE });
    throw error;
  }
}
