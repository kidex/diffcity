// The full diff of one file in the file view (SPEC.md section 6, ADR-027): rows
// with both line numbers and +/− gutters, highlight classes, collapsed folds,
// next/previous hunk, symbol spans that light the city's floors and back, a
// line-range selection kept for the review marks, and the states of a diff
// that is not text. The daemon computed all of it (a FileDiff); this only
// draws it, a window of rows at a time so a 50,000-row diff stays light.
// Repository text goes in through text nodes only, never as markup.

import './fileview.css';

import type { DiffRow, FileDiff } from '../../../../../core/model/types.js';
import { h } from '../../../../shared/dom.js';
import type { DiffPort } from '../../ports.js';
import { cleanHunks, hunkAtRow, hunkCounter, hunkFrom, stepHunk } from './hunks.js';
import type { Items, Span } from './layout.js';
import { anchorRow, buildItems, foldAt, foldLabel, itemOfRow, itemRows, largestLine, widestRow } from './layout.js';
import type { LineRange, Pick } from './range.js';
import { describeRange, inRange, lineOn, pickLine, sameRange } from './range.js';
import { hlClass, segments } from './segments.js';
import type { SymbolSpan } from './spans.js';
import { cleanSymbols, owners, spanOf } from './spans.js';
import { BINARY, LOAD_FAILED, LOADING, NO_LINES, sizesLine, STALE_BANNER, statsLine, TOO_LARGE, UNAVAILABLE, UNCHANGED } from './text.js';
import { anchoredScroll, scrollToItem, visibleRange } from './window.js';

export type { LineRange } from './range.js';

/** A row's height in pixels; the CSS reads it from `--dv-row`. */
export const ROW_HEIGHT = 19;
/** Rows kept in the DOM above and below the visible ones. */
const OVERSCAN = 24;
/** Rows of context left above a hunk or a symbol it jumps to. */
const LEAD = 2;
/** The viewport's height before it has been measured. */
const FALLBACK_HEIGHT = 400;

export interface DiffViewOptions {
  diffs: DiffPort;
  /** The pointer is over the lines of a symbol (its id), or left them. */
  onHover(symbolId: string | null): void;
  /** The selected line range changed (null: none). */
  onRange(range: LineRange | null): void;
}

export interface DiffView {
  /**
   * Shows the diff of `path` in `mount`. The same file again (a live update
   * rebuilt the file view) keeps the scroll, the open folds and the range,
   * and fetches again only when the diff was stale or `generation` (the
   * Report's `generatedAt`) moved; another file is loaded from scratch.
   */
  show(mount: HTMLElement, path: string, symbolId: string | null, generation: string): void;
  /** The symbol the reading panel focused: the view scrolls to its lines. */
  focus(symbolId: string | null): void;
  /** The city's pointer is over this symbol's floor (null: none): its lines are lit. */
  hoverSymbol(symbolId: string | null): void;
  /** The selected line range, for the review marks. */
  range(): LineRange | null;
  /** The file view closed: stops the request and the keys, forgets the file. */
  hide(): void;
  dispose(): void;
}

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);

type State = 'loading' | 'error' | FileDiff['kind'];

export function createDiffView(options: DiffViewOptions): DiffView {
  // ---------- DOM ----------
  const counter = h('span', { class: 'dv-counter', 'data-testid': 'hunk-counter', 'aria-live': 'polite' });
  const prevButton = h('button', { type: 'button', class: 'dv-step', 'data-testid': 'hunk-prev', 'aria-label': 'Previous hunk', onclick: () => { step('prev'); } }, '▲');
  const nextButton = h('button', { type: 'button', class: 'dv-step', 'data-testid': 'hunk-next', 'aria-label': 'Next hunk', onclick: () => { step('next'); } }, '▼');
  const keys = h('span', { class: 'dv-keys' }, h('span', { class: 'k' }, 'N'), h('span', { class: 'k' }, '⇧N'), ' hunk');
  const stats = h('span', { class: 'dv-stats', 'data-testid': 'diff-stats' });
  const bar = h('div', { class: 'dv-bar', 'data-testid': 'diff-bar' }, prevButton, counter, nextButton, keys, h('span', { class: 'spacer' }), stats);
  const stale = h('p', { class: 'dv-stale', role: 'status', 'data-testid': 'diff-stale' }, STALE_BANNER);
  const note = h('p', { class: 'dv-note', 'data-testid': 'diff-note' });
  const slot = h('div', { class: 'dv-slot' });
  const content = h('div', { class: 'dv-content', 'data-testid': 'diff-content' });
  const viewport = h('div', { class: 'dv-viewport', tabindex: 0, role: 'region', 'data-testid': 'diff-viewport' }, content);
  const root = h('div', { class: 'dv', 'data-testid': 'diff-view' }, bar, stale, note, slot, viewport);
  root.style.setProperty('--dv-row', `${String(ROW_HEIGHT)}px`);

  // ---------- state ----------
  let attached = false;
  let path: string | null = null;
  let focusId: string | null = null;
  let controller: AbortController | null = null;
  let generation = '';
  let loadedGeneration = '';
  let state: State | null = null;
  let diff: FileDiff | null = null;
  let rows: readonly DiffRow[] = [];
  let hunks: Span[] = [];
  let spans: SymbolSpan[] = [];
  let owner: Int32Array = new Int32Array(0);
  let items: Items = { list: new Int32Array(0), folds: [] };
  let foldsOf: readonly Span[] = [];
  const expanded = new Set<number>();
  let hunkIndex = -1;
  let pick: Pick | null = null;
  let hoverId: string | null = null;
  let pointerId: string | null = null;
  let focusSpan: Span | null = null;
  /** The scroll offset the code last set, so its own scroll events are not read as the reader's. */
  let expectedTop = -1;
  let lastTop = 0;
  const mounted = new Map<number, HTMLElement>();
  
  const viewportHeight = (): number => viewport.clientHeight || FALLBACK_HEIGHT;

  // ---------- states ----------
  /** Rows are on screen in these states; the others show a message. */
  const showsRows = (): boolean => state === 'text' || state === 'unchanged';

  function setState(next: State, message: HTMLElement | null = null, withRows = false): void {
    state = next;
    root.dataset['state'] = next;
    viewport.hidden = !withRows;
    bar.hidden = !withRows;
    slot.replaceChildren(...(message === null ? [] : [message]));
    slot.hidden = message === null;
    note.hidden = !(withRows && next === 'unchanged');
    if (next === 'unchanged') note.textContent = UNCHANGED;
  }

  const messageOf = (testId: string, title: string, ...detail: (HTMLElement | string)[]): HTMLElement =>
    h('div', { class: 'dv-msg', role: 'status', 'data-testid': testId }, h('p', { class: 'dv-msg-title' }, title), detail.map((part) => (typeof part === 'string' ? h('p', { class: 'dv-msg-detail' }, part) : part)));

  function load(keep: boolean): void {
    if (path === null) return;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    if (!keep || diff === null) {
      diff = null;
      rows = [];
      setState('loading', messageOf('diff-loading', LOADING));
      stale.hidden = true;
    }
    const wanted = path;
    options.diffs.fileDiff(wanted, focusId ?? undefined, mine.signal).then(
      (result) => {
        if (!mine.signal.aborted) apply(result, keep);
      },
      () => {
        if (mine.signal.aborted || keep) return;
        const retry = h('button', { type: 'button', class: 'dv-retry', 'data-testid': 'diff-retry', onclick: () => {
            load(false);
          },
        }, 'Try again');
        setState('error', messageOf('diff-error', LOAD_FAILED, retry));
      },
    );
  }

  function apply(result: FileDiff, keep: boolean): void {
    const top = keep ? lastTop : 0;
    diff = result;
    loadedGeneration = generation;
    rows = result.rows ?? [];
    hunks = cleanHunks(result.hunks, rows.length);
    spans = cleanSymbols(result.symbols, rows.length);
    owner = owners(spans, rows.length);
    foldsOf = result.folds ?? [];
    if (!keep) {
      expanded.clear();
      commit(null);
    }
    stale.hidden = !result.stale;
    stale.textContent = STALE_BANNER;
    if (result.kind === 'binary') {
      setState('binary', messageOf('diff-binary', BINARY, sizesLine(result.sizes)));
      return;
    }
    if (result.kind === 'too-large') {
      setState('too-large', messageOf('diff-too-large', TOO_LARGE, statsLine(result.stats), ...(result.reason === undefined ? [] : [result.reason])));
      return;
    }
    if (result.kind === 'unavailable') {
      setState('unavailable', messageOf('diff-unavailable', UNAVAILABLE, ...(result.reason === undefined ? [] : [result.reason])));
      return;
    }
    if (rows.length === 0) {
      setState(result.kind, messageOf('diff-empty', result.kind === 'unchanged' ? UNCHANGED : NO_LINES));
      return;
    }
    // Open folds the new diff still has.
    for (const first of [...expanded]) if (!foldsOf.some((fold) => fold.first === first)) expanded.delete(first);
    setState(result.kind, null, true);
    stats.replaceChildren(h('span', { class: 'add' }, `+${String(result.stats.added)}`), ' ', h('span', { class: 'del' }, `−${String(result.stats.removed)}`));
    root.style.setProperty('--dv-ch', String(widestRow(rows)));
    root.style.setProperty('--dv-digits', String(Math.max(2, String(largestLine(rows)).length)));
    root.dataset['rows'] = String(rows.length);
    rebuild();
    if (keep) {
      scrollTo(top);
      applyFocus(false);
      hunkIndex = Math.min(hunkIndex, hunks.length - 1);
    } else {
      applyFocus(false);
      const start = focusSpan?.first ?? hunks[0]?.first ?? 0;
      hunkIndex = focusSpan === null ? (hunks.length === 0 ? -1 : 0) : hunkFrom(hunks, focusSpan.first);
      reveal(start);
    }
    updateBar();
    render();
  }

  // ---------- items, windows ----------
  function rebuild(): void {
    items = buildItems(rows.length, foldsOf, expanded);
    content.style.height = `${String(items.list.length * ROW_HEIGHT)}px`;
    for (const node of mounted.values()) node.remove();
    mounted.clear();
  }

  function scrollTo(top: number): void {
    viewport.scrollTop = top;
    expectedTop = viewport.scrollTop;
    lastTop = expectedTop;
    render();
  }

  /** Scrolls so `row` is `lead` rows below the top, opening the fold that hides it. */
  function reveal(row: number, lead = LEAD): void {
    const fold = foldAt(items, row);
    if (fold !== null) {
      expanded.add(fold.first);
      rebuild();
    }
    scrollTo(scrollToItem(itemOfRow(items, row), ROW_HEIGHT, viewportHeight(), items.list.length, lead));
  }

  function foldNode(value: number, index: number): HTMLElement {
    const fold = items.folds[~value];
    const label = fold === undefined ? '' : foldLabel(fold);
    const node = h(
      'button',
      { type: 'button', class: 'dl fold', 'data-testid': 'diff-fold', 'data-fold': fold?.first ?? 0, 'aria-label': `Show ${label}` },
      h('span', { class: 'fold-label' }, label),
    );
    node.style.top = `${String(index * ROW_HEIGHT)}px`;
    return node;
  }

  function rowNode(row: DiffRow, rowIndex: number, index: number): HTMLElement {
    const text = h('span', { class: 'tx', 'data-testid': 'diff-text' });
    for (const piece of segments(row.text, row.hl)) {
      text.append(piece.cls === undefined ? document.createTextNode(piece.text) : h('span', { class: hlClass(piece.cls) }, piece.text));
    }
    if (row.cut === true) text.append(h('span', { class: 'cut-mark', title: 'This line is longer than 4,000 characters and was cut' }, ' … cut'));
    const gutter = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
    const number = (side: 'old' | 'new', value: number | null): HTMLElement =>
      value === null
        ? h('span', { class: `ln ${side} none`, 'data-testid': `diff-${side}` })
        : h('button', { type: 'button', class: `ln ${side}`, tabindex: -1, 'data-side': side, 'data-testid': `diff-${side}`, 'aria-label': `Select ${side} line ${String(value)}` }, String(value));
    const symbol = owner[rowIndex] ?? -1;
    const node = h(
      'div',
      {
        class: `dl ${row.kind}${symbol >= 0 ? ' sym' : ''}${row.cut === true ? ' cut' : ''}`,
        'data-testid': 'diff-row',
        'data-row': rowIndex,
        'data-kind': row.kind,
        'data-symbol': spans[symbol]?.id,
        'data-cut': row.cut === true ? 'true' : undefined,
      },
      number('old', row.old),
      number('new', row.new),
      h('span', { class: 'gt', 'data-testid': 'diff-gutter', 'aria-hidden': 'true' }, gutter),
      text,
    );
    node.style.top = `${String(index * ROW_HEIGHT)}px`;
    return node;
  }

  function itemNode(index: number): HTMLElement | null {
    const value = items.list[index];
    if (value === undefined) return null;
    if (value < 0) return foldNode(value, index);
    const row = rows[value];
    return row === undefined ? null : rowNode(row, value, index);
  }

  function render(): void {
    if (!showsRows()) return;
    const range = visibleRange(viewport.scrollTop, viewportHeight(), ROW_HEIGHT, items.list.length, OVERSCAN);
    for (const [index, node] of mounted) {
      if (index >= range.start && index < range.end) continue;
      node.remove();
      mounted.delete(index);
    }
    const lowest = Math.min(...mounted.keys(), range.end);
    const before = document.createDocumentFragment();
    const after = document.createDocumentFragment();
    for (let index = range.start; index < range.end; index++) {
      if (mounted.has(index)) continue;
      const node = itemNode(index);
      if (node === null) continue;
      mounted.set(index, node);
      (index < lowest ? before : after).append(node);
    }
    content.prepend(before);
    content.append(after);
    root.dataset['drawn'] = String(mounted.size);
    paint();
  }

  /** The classes that follow the state: the picked range, the hovered symbol, the focused one. */
  function paint(): void {
    const hot = spanOf(spans, hoverId);
    for (const node of mounted.values()) {
      const index = node.dataset['row'] === undefined ? -1 : Number(node.dataset['row']);
      const row = rows[index];
      if (row === undefined) continue;
      node.classList.toggle('picked', inRange(pick?.range ?? null, row));
      node.classList.toggle('hot', hot !== null && index >= hot.first && index <= hot.last);
      node.classList.toggle('focus', focusSpan !== null && index >= focusSpan.first && index <= focusSpan.last);
    }
  }

  // ---------- hunks ----------
  function updateBar(): void {
    counter.textContent = hunkCounter(hunkIndex, hunks.length);
    counter.hidden = hunks.length === 0;
    prevButton.disabled = nextButton.disabled = hunks.length === 0;
    keys.hidden = hunks.length === 0;
    root.dataset['hunk'] = String(hunkIndex + 1);
    root.dataset['hunks'] = String(hunks.length);
  }

  function step(direction: 'next' | 'prev'): void {
    if (!showsRows()) return;
    const to = stepHunk(hunkIndex, hunks.length, direction);
    const hunk = hunks[to];
    if (hunk === undefined) return;
    hunkIndex = to;
    updateBar();
    reveal(hunk.first);
  }

  // ---------- focus, hover, range ----------
  function applyFocus(scroll: boolean): void {
    const span = focusId === null ? null : (spanOf(spans, focusId) ?? (diff?.focus?.id === focusId ? diff.focus : null));
    focusSpan = span === null ? null : { first: span.first, last: span.last };
    paint();
    if (scroll && focusSpan !== null) {
      hunkIndex = hunkFrom(hunks, focusSpan.first);
      updateBar();
      reveal(focusSpan.first);
    }
  }

  /** Keeps `next` as the picked range and tells the reading panel when the range moved. */
  function commit(next: Pick | null): void {
    const before = pick?.range ?? null;
    pick = next;
    const range = next?.range ?? null;
    if (sameRange(before, range)) return;
    root.dataset['range'] = range === null ? '' : describeRange(range);
    options.onRange(range);
  }

  function setPointerSymbol(id: string | null): void {
    if (id === pointerId) return;
    pointerId = id;
    hoverId = id;
    paint();
    options.onHover(id);
  }

  content.addEventListener('pointerover', (event) => {
    const node = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-row]') : null;
    setPointerSymbol(node?.dataset['symbol'] ?? null);
  });
  viewport.addEventListener('pointerleave', () => {
    setPointerSymbol(null);
  });
  // Shift+click on a number must extend the range, not select text.
  content.addEventListener('mousedown', (event) => {
    if (event.shiftKey && event.target instanceof Element && event.target.closest('.ln') !== null) event.preventDefault();
  });
  content.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const foldButton = target?.closest<HTMLElement>('.fold') ?? null;
    if (foldButton !== null) {
      expand(Number(foldButton.dataset['fold']));
      return;
    }
    const number = target?.closest<HTMLElement>('.ln[data-side]') ?? null;
    const rowNode = target?.closest<HTMLElement>('[data-row]') ?? null;
    const side = number?.dataset['side'];
    const row = rows[Number(rowNode?.dataset['row'])];
    if (row === undefined || (side !== 'old' && side !== 'new')) return;
    const line = lineOn(row, side);
    if (line === null) return;
    commit(pickLine(pick, side, line, event.shiftKey));
    paint();
  });

  /** Opens the fold that starts at row `first`; the row at the top of the viewport stays where it is. */
  function expand(first: number): void {
    if (expanded.has(first)) return;
    const anchor = anchorRow(items, viewport.scrollTop, ROW_HEIGHT);
    expanded.add(first);
    rebuild();
    scrollTo(anchoredScroll(itemOfRow(items, anchor.row), anchor.offset, ROW_HEIGHT));
  }

  viewport.addEventListener('scroll', () => {
    if (Math.abs(viewport.scrollTop - expectedTop) < 1) {
      render();
      return;
    }
    expectedTop = -1;
    lastTop = viewport.scrollTop;
    // The reader moved: the counter follows what is at the top.
    const top = itemRows(items, Math.min(items.list.length - 1, Math.floor(viewport.scrollTop / ROW_HEIGHT))).first;
    const reading = hunkAtRow(hunks, top + LEAD);
    if (reading !== hunkIndex) {
      hunkIndex = reading;
      updateBar();
    }
    render();
  });

  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
        render();
      });
  resize?.observe(viewport);

  const onKey = (event: KeyboardEvent): void => {
    if (!attached || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
    if (event.key !== 'n' && event.key !== 'N') return;
    if (hunks.length === 0 || !showsRows()) return;
    event.preventDefault();
    step(event.shiftKey || event.key === 'N' ? 'prev' : 'next');
  };
  document.addEventListener('keydown', onKey);

  setState('loading');

  function forget(): void {
    controller?.abort();
    controller = null;
    path = null;
    diff = null;
    rows = [];
    hunks = [];
    spans = [];
    hunkIndex = -1;
    expanded.clear();
    commit(null);
    hoverId = null;
    pointerId = null;
    focusSpan = null;
    lastTop = 0;
    expectedTop = -1;
    rebuild();
  }

  return {
    show(mount, nextPath, symbolId, nextGeneration) {
      generation = nextGeneration;
      mount.replaceChildren(root);
      attached = true;
      if (nextPath === path) {
        focusId = symbolId;
        // The file view was rebuilt: the viewport is new, the scroll offset is ours.
        if (diff !== null && showsRows()) {
          viewport.scrollTop = lastTop;
          expectedTop = viewport.scrollTop;
          render();
        }
        if (diff !== null && (diff.stale || loadedGeneration !== nextGeneration)) load(true);
        else if (diff === null && controller === null) load(false);
        return;
      }
      forget();
      path = nextPath;
      focusId = symbolId;
      load(false);
    },
    focus(symbolId) {
      if (symbolId === focusId) return;
      focusId = symbolId;
      if (diff !== null && showsRows()) applyFocus(true);
    },
    hoverSymbol(symbolId) {
      // The pointer is on the diff itself: its own hover wins.
      if (pointerId !== null || symbolId === hoverId) return;
      hoverId = symbolId;
      paint();
    },
    range: () => pick?.range ?? null,
    hide() {
      attached = false;
      forget();
      setState('loading');
      root.remove();
    },
    dispose() {
      attached = false;
      controller?.abort();
      document.removeEventListener('keydown', onKey);
      resize?.disconnect();
      root.remove();
    },
  };
}
