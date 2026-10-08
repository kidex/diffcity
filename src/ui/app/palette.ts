// The Cmd+K / Ctrl+K quick search (SPEC.md section 6). The daemon computes and
// orders the results (ADR-017); the palette only shows them and navigates.
// Keyboard: Up/Down move, Enter opens, Esc closes.

import type { SearchResult } from '../../core/model/types.js';
import type { Api } from '../data/api.js';
import { h, replaceChildren } from '../shared/dom.js';
import { searchIcon } from './icons.js';
import { searchResultRoute, type Route } from './router.js';

export interface Palette {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  dispose(): void;
}

const KIND_LABEL: Record<SearchResult['kind'], string> = { repo: 'Repo', change: 'Change', file: 'File' };
const SEARCH_DELAY_MS = 80;
const LIMIT = 20;

/** What a result opens: the same key in two answers is the same result. */
function searchResultKey(result: SearchResult): string {
  switch (result.kind) {
    case 'repo':
      return `repo:${String(result.repoId)}`;
    case 'change':
      return `change:${String(result.changeId)}`;
    case 'file':
      return `file:${String(result.changeId)}:${result.path}`;
  }
}

/** Cmd+K on macOS, Ctrl+K elsewhere; both are accepted everywhere. */
export function isPaletteShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
}

export function mountPalette(api: Api, go: (route: Route) => void, doc: Document = document): Palette {
  const listId = 'palette-results';
  const input = h('input', {
    type: 'text',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    'aria-label': 'Search repos, branches and files',
    placeholder: 'Search repos, branches and files',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const list = h('ul', { id: listId, role: 'listbox', 'aria-label': 'Results' });
  const empty = h('div', { class: 'empty', role: 'status' });
  const dialog = h(
    'div',
    { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick search' },
    h('div', { class: 'field' }, searchIcon(), input),
    list,
    empty,
    h(
      'div',
      { class: 'foot' },
      h('span', { class: 'k' }, '↑'),
      h('span', { class: 'k' }, '↓'),
      ' move',
      h('span', { class: 'k' }, 'Enter'),
      ' open',
      h('span', { class: 'spacer' }),
      h('span', { class: 'k' }, 'Esc'),
      ' close',
    ),
  );
  const backdrop = h('div', { class: 'palette-backdrop', hidden: true }, dialog);
  doc.body.append(backdrop);

  let results: SearchResult[] = [];
  let active = -1;
  /**
   * The result the user moved the selection to (arrows or pointer), if any.
   * Results for a newer query keep it selected while they still list it, so an
   * answer that lands after the user moved never sends Enter somewhere else.
   */
  let picked: SearchResult | null = null;
  let returnFocus: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let sequence = 0;
  let latest: Promise<void> = Promise.resolve();
  /** Incremented on every close, so a pending Enter does not act on a later session. */
  let session = 0;

  function setEmpty(text: string): void {
    empty.textContent = text;
    empty.hidden = text === '';
  }

  function render(): void {
    replaceChildren(
      list,
      results.map((result, index) =>
        h(
          'li',
          {
            id: `palette-option-${String(index)}`,
            role: 'option',
            'aria-selected': index === active ? 'true' : 'false',
            'data-kind': result.kind,
            onmousemove: () => {
              if (active !== index) setActive(index);
            },
            onclick: () => {
              choose(index);
            },
          },
          h('span', { class: 'kind' }, KIND_LABEL[result.kind]),
          h('span', { class: 'label' }, result.label),
          h('span', { class: 'detail' }, result.detail),
        ),
      ),
    );
    list.hidden = results.length === 0;
    input.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
    updateActiveDescendant();
  }

  function updateActiveDescendant(): void {
    if (active >= 0) input.setAttribute('aria-activedescendant', `palette-option-${String(active)}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function setActive(index: number): void {
    active = index;
    picked = results[index] ?? null;
    for (const [i, option] of Array.from(list.children).entries()) {
      option.setAttribute('aria-selected', i === active ? 'true' : 'false');
    }
    updateActiveDescendant();
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function choose(index: number): void {
    const result = results[index];
    if (!result) return;
    close();
    go(searchResultRoute(result));
  }

  async function search(query: string): Promise<void> {
    inflight?.abort();
    const id = ++sequence;
    if (query === '') {
      inflight = null;
      picked = null;
      results = [];
      active = -1;
      render();
      setEmpty('Type to search repos, branches and files.');
      return;
    }
    const controller = new AbortController();
    inflight = controller;
    try {
      const found = await api.search(query, { limit: LIMIT, signal: controller.signal });
      if (id !== sequence) return;
      results = found;
      const pickedKey = picked === null ? null : searchResultKey(picked);
      const kept = pickedKey === null ? -1 : found.findIndex((result) => searchResultKey(result) === pickedKey);
      if (kept < 0) picked = null;
      active = kept >= 0 ? kept : found.length > 0 ? 0 : -1;
      render();
      setEmpty(found.length > 0 ? '' : 'No matches.');
    } catch {
      if (id !== sequence || controller.signal.aborted) return;
      results = [];
      active = -1;
      render();
      setEmpty('Search needs the daemon, which is not reachable.');
    }
  }

  function runSearch(): Promise<void> {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    latest = search(input.value.trim());
    return latest;
  }

  function scheduleSearch(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void runSearch(), SEARCH_DELAY_MS);
  }

  /** Enter: waits for the results of what was typed, so a fast Enter never opens a stale result. */
  async function chooseActive(): Promise<void> {
    const opened = session;
    await (timer !== null ? runSearch() : latest);
    if (!backdrop.hidden && session === opened) choose(active);
  }

  function open(): void {
    if (!backdrop.hidden) {
      input.select();
      return;
    }
    returnFocus = doc.activeElement;
    backdrop.hidden = false;
    input.select();
    input.focus();
    void runSearch();
  }

  function close(): void {
    if (backdrop.hidden) return;
    // Hiding the dialog does not move focus out of it at once: the browser
    // drops focus from a hidden element only at its next rendering update.
    // Blur first, so focus is on the page as soon as the palette is closed,
    // even when there is no control to give it back to.
    const inside = doc.activeElement;
    if (inside instanceof HTMLElement && backdrop.contains(inside)) inside.blur();
    backdrop.hidden = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    inflight?.abort();
    sequence++;
    session++;
    picked = null;
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  input.addEventListener('input', scheduleSearch);
  input.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (results.length === 0) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((active + step + results.length) % results.length);
        return;
      }
      case 'Enter':
        event.preventDefault();
        void chooseActive();
        return;
      case 'Escape':
        event.preventDefault();
        close();
        return;
    }
  });
  // The dialog is modal: Tab and Shift+Tab keep focus on the search input.
  backdrop.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    input.focus();
  });
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });

  const onKeydown = (event: KeyboardEvent): void => {
    if (!isPaletteShortcut(event)) return;
    event.preventDefault();
    if (backdrop.hidden) open();
    else close();
  };
  doc.addEventListener('keydown', onKeydown);

  return {
    open,
    close,
    get isOpen() {
      return !backdrop.hidden;
    },
    dispose() {
      close();
      doc.removeEventListener('keydown', onKeydown);
      backdrop.remove();
    },
  };
}
