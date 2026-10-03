// Fixture FileDiffs and helpers for the full diff's specs (T9, ADR-027). The
// diffs are written here, never computed by a real repo: the daemon's route is
// served by the mock API's `diff` handler. The builder below only lays out
// what the daemon would send (rows, hunks, folds), so a spec can say what a
// file looks like in a few lines.

import type { Locator, Page } from '@playwright/test';
import type { DiffRow, FileDiff, HighlightClass } from '../../../src/core/model/types.js';
import { GUARD } from './hud.js';
import type { ApiData, DiffReply, DiffRequest } from './mock-api.js';
import { CAN_PLACE, openPanel } from './panel.js';
import { project, sceneExpect as expect, waitForCityAttribute } from './scene.js';

export type { DiffReply, DiffRequest };

/** One line of a script: kind, text and optional highlights. */
export type Line = ['ctx' | 'add' | 'del', string, ([number, number, HighlightClass][] | undefined)?];

export const SNAPSHOT_HEAD = 'aaaaaaa';

/** Rows with their line numbers from a script. */
export function rowsOf(script: readonly Line[]): DiffRow[] {
  let old = 0;
  let now = 0;
  return script.map(([kind, text, hl]) => {
    if (kind !== 'add') old += 1;
    if (kind !== 'del') now += 1;
    return { kind, old: kind === 'add' ? null : old, new: kind === 'del' ? null : now, text, ...(hl === undefined ? {} : { hl }) };
  });
}

/** The changed runs, as the daemon reports them. */
export function hunksOf(rows: readonly DiffRow[]): { first: number; last: number }[] {
  const hunks: { first: number; last: number }[] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'ctx') return;
    const last = hunks[hunks.length - 1];
    if (last !== undefined && last.last === index - 1) last.last = index;
    else hunks.push({ first: index, last: index });
  });
  return hunks;
}

/** Unchanged runs longer than 8 rows, minus 3 rows of context on each side that touches a change. */
export function foldsOf(rows: readonly DiffRow[]): { first: number; last: number }[] {
  const folds: { first: number; last: number }[] = [];
  let start = -1;
  const close = (end: number): void => {
    if (start < 0) return;
    if (end - start + 1 > 8) folds.push({ first: start === 0 ? 0 : start + 3, last: end === rows.length - 1 ? end : end - 3 });
    start = -1;
  };
  rows.forEach((row, index) => {
    if (row.kind === 'ctx') {
      if (start < 0) start = index;
    } else close(index - 1);
  });
  close(rows.length - 1);
  return folds;
}

export interface DiffSpec {
  path: string;
  rows: DiffRow[];
  symbols?: FileDiff['symbols'];
  focus?: FileDiff['focus'];
  stale?: boolean;
  kind?: FileDiff['kind'];
}

/** A FileDiff of a text file. */
export function fileDiff(spec: DiffSpec): FileDiff {
  const added = spec.rows.filter((row) => row.kind === 'add').length;
  const removed = spec.rows.filter((row) => row.kind === 'del').length;
  const hunks = hunksOf(spec.rows);
  return {
    snapshotId: 1,
    head: SNAPSHOT_HEAD,
    path: spec.path,
    language: 'typescript',
    kind: spec.kind ?? 'text',
    stale: spec.stale ?? false,
    stats: { added, removed },
    sizes: { before: 900, after: 1000 },
    rows: spec.rows,
    hunks,
    folds: foldsOf(spec.rows),
    ...(spec.symbols === undefined ? {} : { symbols: spec.symbols }),
    ...(spec.focus === undefined ? {} : { focus: spec.focus }),
  };
}

const ctx = (text: string, hl?: [number, number, HighlightClass][]): Line => ['ctx', text, hl];
const add = (text: string, hl?: [number, number, HighlightClass][]): Line => ['add', text, hl];
const del = (text: string, hl?: [number, number, HighlightClass][]): Line => ['del', text, hl];

export const CAN_READ = `${GUARD}#OrderGuard.canRead`;
export const GUARD_CLASS = `${GUARD}#OrderGuard`;

/**
 * The guard file as the daemon would send it: 61 rows, three hunks (rows
 * 22-24, 47-49, 57-58), two folds (0-18, 28-43), the spans of the class (rows
 * 20-58) and of canPlace (rows 21-24), and a last row that was cut.
 */
export function guardScript(): Line[] {
  const lines: Line[] = [];
  for (let n = 1; n <= 20; n++) lines.push(ctx(n === 1 ? "import { Order, User } from './types';" : `// guard line ${String(n)}`, n === 1 ? [[0, 6, 'kw'], [7, 8, 'punc'], [9, 14, 'type']] : undefined));
  lines.push(
    ctx('export class OrderGuard {'),
    ctx('  canPlace(user: User, order?: Order): boolean {'),
    del('    return user.active;', [[4, 10, 'kw']]),
    add('    const owner = order?.owner === user.id;', [[4, 9, 'kw'], [10, 15, 'var'], [32, 34, 'op']]),
    add('    return user.active && owner;', [[4, 10, 'kw'], [32, 36, 'str'], [18, 20, 'num']]),
  );
  // 22 unchanged rows, then the second hunk.
  for (let n = 1; n <= 22; n++) lines.push(ctx(`  // untouched ${String(n)}`, [[2, 5, 'com']]));
  lines.push(del('  legacy();'), add('  modern();'), add('  modern(true);'));
  for (let n = 1; n <= 7; n++) lines.push(ctx(`  // after ${String(n)}`));
  lines.push(del('}'), add('}'));
  lines.push(ctx('export default OrderGuard;'), ctx(''));
  return lines;
}

/** The guard's FileDiff; `symbolId` is what the panel asked the route for. */
export function guardDiff(options: { symbolId?: string | null; stale?: boolean } = {}): FileDiff {
  const rows = rowsOf(guardScript());
  const last = rows[rows.length - 1];
  if (last !== undefined) last.cut = true;
  const symbols = [
    { id: GUARD_CLASS, first: 20, last: 58 },
    { id: CAN_PLACE, first: 21, last: 24 },
  ];
  const focus = options.symbolId === undefined || options.symbolId === null ? undefined : symbols.find((span) => span.id === options.symbolId);
  return fileDiff({ path: GUARD, rows, symbols, stale: options.stale ?? false, ...(focus === undefined ? {} : { focus }) });
}

/** A handler that serves the guard file and `unavailable` for anything else. */
export const serveGuard =
  (options: { stale?: (call: number) => boolean } = {}) =>
  (request: DiffRequest): DiffReply =>
    request.path === GUARD ? guardDiff({ symbolId: request.symbol, stale: options.stale?.(request.call) ?? false }) : { status: 404, body: { error: { code: 'not-in-snapshot', message: 'no' } } };

export const diffView = (page: Page): Locator => page.getByTestId('diff-view');
export const diffRows = (page: Page): Locator => page.getByTestId('diff-row');
export const viewport = (page: Page): Locator => page.getByTestId('diff-viewport');
export const scrollOf = (page: Page): Promise<number> => page.evaluate<number>(`document.querySelector('[data-testid="diff-viewport"]').scrollTop`);
export const scrollHeightOf = (page: Page): Promise<number> =>
  page.evaluate<number>(`document.querySelector('[data-testid="diff-viewport"]').scrollHeight`);
export const setScroll = (page: Page, top: number): Promise<unknown> =>
  page.evaluate(`document.querySelector('[data-testid="diff-viewport"]').scrollTop = ${String(top)}`);

/** Opens the change with the diff route served by `diff`, clicks a building (and a floor when `floor` is given) and waits for the diff view. */
export async function openDiff(
  page: Page,
  diff: ApiData['diff'],
  options: { file?: string; floor?: string } = {},
): Promise<void> {
  const file = options.file ?? GUARD;
  await openPanel(page, undefined, { diff });
  const point = await project(page, file, options.floor);
  await page.mouse.click(point.x, point.y);
  await waitForCityAttribute(page, 'data-selected', file);
  await expect(page.getByTestId('file-view')).toBeVisible();
}

/** How far below the top of the viewport the row's top edge is, in pixels; null when the row is not in the DOM. */
export const rowTop = (page: Page, row: number): Promise<number | null> =>
  page.evaluate<number | null>(`(() => {
    const node = document.querySelector('[data-row="${String(row)}"]');
    if (!node) return null;
    return node.getBoundingClientRect().top - document.querySelector('[data-testid="diff-viewport"]').getBoundingClientRect().top;
  })()`);
