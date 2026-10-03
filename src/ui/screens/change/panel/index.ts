// The reading panel (SPEC.md section 6, right panel; ADR-026): the header and
// its four tabs with counters, the stop cards, the findings, the files outside
// the spec and the touched symbols, and, once a building or a stop is
// clicked, the file view in place of the tabs. Plain DOM; it renders a Report
// and holds only what is on screen: the tab, the selection it was told about
// and the open file. Selection is the city's: the panel asks `onSelect` and
// hears back through select().

import './panel.css';

import type { Report } from '../../../../core/report/types.js';
import { h } from '../../../shared/dom.js';
import type { Counters, FileViewData, TabId, Target } from '../model/panel.js';
import { counters, fileViewData, findingSources, navTargets, stepTarget, stopIsCurrent, summaryLine, TABS } from '../model/panel.js';
import type { DiffPort } from '../ports.js';
import type { FileViewRender } from './file-view.js';
import { renderFileView } from './file-view.js';
import type { TabActions, TabBody } from './lists.js';
import { bindHover, findingsBody, orderBody, outsideBody, symbolsBody } from './lists.js';

export interface PanelOptions {
  /** Selects a building (a file id) and its floor (a symbol id) in the city; null clears. */
  onSelect(fileId: string | null, symbolId: string | null): void;
  /** Lights a building as the pointer would; null puts it out. */
  onHover(fileId: string | null): void;
  /** Without it the file view shows only the Report's step diffs. */
  diffs?: DiffPort | undefined;
  reducedMotion: boolean;
}

export interface Panel {
  root: HTMLElement;
  /** A new Report of the same change: the tab, the selection and the open file stay. */
  update(report: Report): void;
  /** The city's selection changed (or was rebuilt): null for none. */
  select(fileId: string | null, symbolId: string | null): void;
  /** A building was clicked in the city: its file view opens at the floor. */
  open(fileId: string, symbolId: string | null): void;
  dispose(): void;
}

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);

/** The footer's "Findings from Claude, semgrep, eslint": `rule:` sources are all "rules". */
function sourcesText(sources: readonly string[]): string {
  const names = [...new Set(sources.map((source) => (source === 'claude' ? 'Claude' : source.startsWith('rule:') ? 'rules' : source)))];
  return `Findings from ${names.join(', ')}`;
}

export function createPanel(options: PanelOptions, first: Report): Panel {
  let report = first;
  let tab: TabId = 'order';
  let selection: Target | null = null;
  let fileId: string | null = null;
  let body: TabBody | null = null;
  let view: FileViewRender | null = null;
  let tabScroll = 0;
  let fileScroll = 0;
  let scrollFrame: number | undefined;

  const title = h('h2', null, 'Reading path');
  const summary = h('p', { 'data-testid': 'panel-summary' });
  const tabsRow = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Reading panel tabs', 'data-testid': 'panel-tabs' });
  const header = h('header', null, title, summary, tabsRow);
  const scroll = h('div', { class: 'scroll', 'data-testid': 'panel-scroll', tabindex: -1 });
  const fileRoot = h('div', { class: 'fileview', 'data-testid': 'file-view' });
  fileRoot.hidden = true;
  const keys = h('span', { class: 'keys' });
  const sources = h('span', { 'data-testid': 'panel-sources' });
  const foot = h('div', { class: 'foot' }, keys, h('span', { class: 'spacer' }), sources);
  const root = h('aside', { class: 'read', 'aria-label': 'Reading path', 'data-testid': 'reading-panel' }, header, scroll, fileRoot, foot);

  const actions: TabActions = {
    select: (target) => {
      options.onSelect(target.fileId, target.symbolId);
    },
    open: (target) => {
      options.onSelect(target.fileId, target.symbolId);
      openFile(target.fileId, target.symbolId);
    },
    hover: (id) => {
      options.onHover(id);
    },
  };
  bindHover(scroll, actions);

  const tabButtons = new Map<TabId, HTMLButtonElement>();
  const counts = (): Counters => counters(report);

  function renderTabs(): void {
    const current = counts();
    for (const { id, label } of TABS) {
      let button = tabButtons.get(id);
      if (button === undefined) {
        button = h('button', {
          type: 'button',
          'data-testid': `tab-${id}`,
          onclick: () => {
            showTab(id);
          },
        });
        tabButtons.set(id, button);
        tabsRow.append(button);
      }
      button.className = tab === id ? 'on' : '';
      button.setAttribute('aria-pressed', String(tab === id));
      button.replaceChildren(label, h('span', { class: 'cnt', 'data-testid': `count-${id}` }, String(current[id])));
    }
  }

  function renderChrome(): void {
    summary.textContent = summaryLine(report);
    const hasStops = counts().order > 0;
    keys.replaceChildren(h('span', { class: 'k' }, 'J'), h('span', { class: 'k' }, 'K'), ` next / previous ${hasStops ? 'stop' : 'symbol'}`);
    const found = findingSources(report);
    sources.textContent = found.length === 0 ? '' : sourcesText(found);
    renderTabs();
  }

  function renderBody(): void {
    const make = { order: orderBody, findings: findingsBody, outside: outsideBody, symbols: symbolsBody }[tab];
    body = make(report, actions);
    scroll.replaceChildren(body.root);
    scroll.dataset['tab'] = tab;
    markCurrent();
  }

  /** Marks the stops and symbol rows of the selection; the file view's stops too. */
  function markCurrent(scrollTo = false): void {
    const stops = (body?.stops ?? []).map((card) => card.stop);
    for (const card of body?.stops ?? []) card.root.classList.toggle('on', stopIsCurrent(stops, card.stop, selection));
    for (const row of body?.symbols ?? []) {
      row.root.classList.toggle('on', selection !== null && row.target.fileId === selection.fileId && row.target.symbolId === selection.symbolId);
    }
    if (view !== null) {
      const shown = view.stops.map((card) => card.stop);
      for (const card of view.stops) card.root.classList.toggle('on', stopIsCurrent(shown, card.stop, selection));
      const focus = selection?.fileId === fileId ? selection.symbolId : null;
      view.area.dataset['focusSymbol'] = focus ?? '';
      for (const excerpt of view.excerpts) excerpt.root.classList.toggle('focus', focus !== null && excerpt.symbolId === focus);
    }
    if (scrollTo) scheduleScroll();
  }

  /**
   * Brings the current card into view in the tabs, on the next frame: a click
   * that opens the file view selects first, and the tabs must keep the scroll
   * position they had when it opened.
   */
  function scheduleScroll(): void {
    if (scrollFrame !== undefined) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      if (view !== null || scroll.hidden) return;
      const current = scroll.querySelector<HTMLElement>('.step.on, .sym-row.on');
      current?.scrollIntoView({ block: 'nearest', behavior: options.reducedMotion ? 'auto' : 'smooth' });
    });
  }

  function showTab(next: TabId): void {
    if (next === tab && body !== null) return;
    tab = next;
    renderTabs();
    renderBody();
    scroll.scrollTop = 0;
  }

  function renderFile(): void {
    if (fileId === null) return;
    const data: FileViewData | null = fileViewData(report, fileId);
    if (data === null) {
      closeFile();
      return;
    }
    view = renderFileView(fileRoot, data, { actions, back: closeFile, hasDiffPort: options.diffs !== undefined });
    markCurrent();
  }

  function openFile(id: string, symbolId: string | null): void {
    if (fileId === null) tabScroll = scroll.scrollTop;
    const same = fileId === id && view !== null;
    fileId = id;
    selection = { fileId: id, symbolId };
    scroll.hidden = true;
    header.hidden = true;
    fileRoot.hidden = false;
    if (same) markCurrent();
    else {
      renderFile();
      if (view !== null) view.scroll.scrollTop = 0;
    }
    root.dataset['mode'] = 'file';
  }

  function closeFile(): void {
    if (fileId === null) return;
    fileId = null;
    view = null;
    fileRoot.hidden = true;
    fileRoot.replaceChildren();
    header.hidden = false;
    scroll.hidden = false;
    // Hidden elements lose their scroll offset in some browsers: put it back.
    scroll.scrollTop = tabScroll;
    delete root.dataset['mode'];
    markCurrent();
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
    if (event.key === 'Escape') {
      closeFile();
      return;
    }
    const direction = event.key === 'j' || event.key === 'J' ? 'next' : event.key === 'k' || event.key === 'K' ? 'prev' : null;
    if (direction === null) return;
    const target = stepTarget(navTargets(report), selection, direction);
    if (target === null) return;
    event.preventDefault();
    options.onSelect(target.fileId, target.symbolId);
    markCurrent(true);
  };
  document.addEventListener('keydown', onKey);

  renderChrome();
  renderBody();

  return {
    root,
    update(next) {
      report = next;
      if (fileId !== null) fileScroll = view?.scroll.scrollTop ?? 0;
      else tabScroll = scroll.scrollTop;
      renderChrome();
      renderBody();
      scroll.scrollTop = tabScroll;
      if (fileId !== null) {
        renderFile();
        if (view !== null) view.scroll.scrollTop = fileScroll;
      }
    },
    select(id, symbolId) {
      selection = id === null ? null : { fileId: id, symbolId };
      if (id === null) {
        closeFile();
      } else if (fileId !== null && fileId !== id) {
        openFile(id, symbolId);
        return;
      }
      markCurrent(true);
    },
    open: openFile,
    dispose() {
      document.removeEventListener('keydown', onKey);
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
      root.remove();
    },
  };
}
