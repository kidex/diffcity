// The reading panel (SPEC.md section 6, right panel; ADR-026): the header and
// its four tabs with counters (a fifth, Session, with a SessionsPort and
// sessions to show, ADR-038), the stop cards, the findings, the files outside
// the spec and the touched symbols, and, once a building or a stop is
// clicked, the file view in place of the tabs. With finding actions (a
// FindingsPort) every finding card gets its buttons, and a new Report puts the
// focus back on the card it was in. Plain DOM; it renders a Report and holds
// only what is on screen: the tab, the selection it was told about and the
// open file. Selection is the city's: the panel asks `onSelect` and
// hears back through select().

import './panel.css';

import type { Report } from '../../../../core/report/types.js';
import { h } from '../../../shared/dom.js';
import type { Counters, FileViewData, TabId, Target } from '../model/panel.js';
import {
  counters,
  fileViewData,
  findingSources,
  navTargets,
  selectionAnnouncement,
  stepTarget,
  stopIsCurrent,
  summaryLine,
  TABS,
  touchedTargets,
} from '../model/panel.js';
import type { SessionsResponse } from '../../../../core/model/types.js';
import { hasSessions, sessionTab } from '../model/session.js';
import type { DiffPort, SessionsPort } from '../ports.js';
import type { FindingActions } from './finding-actions.js';
import type { FileViewRender } from './file-view.js';
import { DIFF_MOUNT, renderFileView } from './file-view.js';
import type { DiffView, LineRange } from './fileview/view.js';
import { createDiffView } from './fileview/view.js';
import type { TabActions, TabBody } from './lists.js';
import { bindHover, findingsBody, orderBody, outsideBody, symbolsBody } from './lists.js';
import type { SessionBodyState } from './session.js';
import { sessionBody } from './session.js';

/** The tabs of the panel: the Report's four, and Session. */
type PanelTab = TabId | 'session';

export interface PanelOptions {
  /** Selects a building (a file id) and its floor (a symbol id) in the city; null clears. */
  onSelect(fileId: string | null, symbolId: string | null): void;
  /** Lights a building as the pointer would; null puts it out. */
  onHover(fileId: string | null): void;
  /** The pointer is over the lines of a symbol in the file view's diff (null: none): the city lights its floor. */
  onHoverFloor?(fileId: string | null, symbolId: string | null): void;
  /** The line range selected in the file view's diff changed (null: none). */
  onRange?(fileId: string, range: LineRange | null): void;
  /** Without it the file view shows only the Report's step diffs. */
  diffs?: DiffPort | undefined;
  /** With review marks: fills the file view header's slot with the mark buttons of the file (and of the focused floor, a symbol id). */
  review?: { fill(slot: HTMLElement, fileId: string, symbolId: string | null): void } | undefined;
  /** With a FindingsPort: the action buttons of the finding cards. Without it the cards have none. */
  findings?: FindingActions | undefined;
  /** The Claude Code sessions of the change (ADR-038): the Session tab. Without it, or without sessions, there is no Session tab. */
  sessions?: SessionsPort | undefined;
  reducedMotion: boolean;
}

export interface Panel {
  root: HTMLElement;
  /** A new Report of the same change: the tab, the selection and the open file stay. */
  update(report: Report): void;
  /** The city's selection changed (or was rebuilt): null for none. */
  select(fileId: string | null, symbolId: string | null): void;
  /** The city's pointer is over a floor (null: none): the lines of its symbol in the open file's diff are lit. */
  hoverFloor(fileId: string | null, symbolId: string | null): void;
  /** The line range selected in the open file's diff, for the review marks (T10); null when none. */
  lineRange(): { fileId: string; range: LineRange } | null;
  /** The review marks changed: the file view's mark buttons are drawn again. */
  refreshReview(): void;
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
  let tab: PanelTab = 'order';
  /** The sessions as the port last gave them; null: none, no Session tab. */
  let sessions: SessionsResponse | null = null;
  let sessionsLoad: AbortController | null = null;
  const sessionState: SessionBodyState = { expanded: new Set() };
  let selection: Target | null = null;
  let fileId: string | null = null;
  let body: TabBody | null = null;
  let view: FileViewRender | null = null;
  let tabScroll = 0;
  let fileScroll = 0;
  /** The card or row the file view was opened from while it had the focus: Esc and Back give the focus back to it. */
  let opener: Target | null = null;
  let scrollFrame: number | undefined;
  const diffView: DiffView | null =
    options.diffs === undefined
      ? null
      : createDiffView({
          diffs: options.diffs,
          onHover: (symbolId) => options.onHoverFloor?.(fileId, symbolId),
          onRange: (range) => {
            if (fileId !== null) options.onRange?.(fileId, range);
          },
        });

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
  // Tells a screen reader what was selected, in the city or in the list (the card is not a live region).
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'data-testid': 'selection-live' });
  let announced: string | null = null;
  const root = h('aside', { class: 'read', 'aria-label': 'Reading path', 'data-testid': 'reading-panel' }, header, scroll, fileRoot, foot, live);

  function announce(id: string | null): void {
    if (id === announced) return;
    announced = id;
    live.textContent = id === null ? '' : (selectionAnnouncement(report, id) ?? '');
  }

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

  const tabButtons = new Map<PanelTab, HTMLButtonElement>();
  const counts = (): Counters => counters(report);

  function tabButton(id: PanelTab, label: string, count: number): HTMLButtonElement {
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
    }
    if (button.parentElement !== tabsRow) tabsRow.append(button);
    button.className = tab === id ? 'on' : '';
    button.setAttribute('aria-pressed', String(tab === id));
    button.replaceChildren(label, h('span', { class: 'cnt', 'data-testid': `count-${id}` }, String(count)));
    return button;
  }

  function renderTabs(): void {
    const current = counts();
    for (const { id, label } of TABS) tabButton(id, label, current[id]);
    // Session is there only with sessions to show: never in the HTML export.
    if (hasSessions(sessions)) tabButton('session', 'Session', sessions.total);
    else tabButtons.get('session')?.remove();
  }

  function renderChrome(): void {
    summary.textContent = summaryLine(report);
    const hasStops = counts().order > 0;
    keys.replaceChildren(
      h('span', { class: 'k' }, 'J'),
      h('span', { class: 'k' }, 'K'),
      ` next / previous ${hasStops ? 'stop' : 'symbol'} `,
      h('span', { class: 'k', 'data-testid': 'building-key' }, '['),
      h('span', { class: 'k', 'data-testid': 'building-key' }, ']'),
      ' building',
      // With review marks the keys that make them are named here, as J and K are.
      ...(options.review === undefined
        ? []
        : [' ', ...['C', 'G', 'W', 'U'].map((key) => h('span', { class: 'k', 'data-testid': 'review-key' }, key)), ' mark']),
    );
    const found = findingSources(report);
    sources.textContent = found.length === 0 ? '' : sourcesText(found);
    renderTabs();
  }

  function renderBody(): void {
    if (tab === 'session' && !hasSessions(sessions)) tab = 'order';
    if (tab === 'session' && hasSessions(sessions)) {
      body = sessionBody(sessionTab(sessions, report), actions, sessionState);
    } else {
      const make = { order: orderBody, findings: findingsBody, outside: outsideBody, symbols: symbolsBody }[tab === 'session' ? 'order' : tab];
      body = make(report, actions);
    }
    // A redraw keeps the focus on the same agent row or file of the Session tab.
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && scroll.contains(active) ? (active.dataset['focusKey'] ?? null) : null;
    scroll.replaceChildren(body.root);
    if (focusKey !== null) {
      const again = [...body.root.querySelectorAll<HTMLElement>('[data-focus-key]')].find((node) => node.dataset['focusKey'] === focusKey);
      (again ?? scroll).focus({ preventScroll: true });
    }
    scroll.dataset['tab'] = tab;
    markCurrent();
    fillActions();
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
      diffView?.focus(focus);
      for (const excerpt of view.excerpts) excerpt.root.classList.toggle('focus', focus !== null && excerpt.symbolId === focus);
      if (view.reviewSlot !== null && fileId !== null) options.review?.fill(view.reviewSlot, fileId, focus);
    }
    if (scrollTo) scheduleScroll();
  }

  /** Draws the action buttons of every finding card on screen (the tab's and the file view's). */
  function fillActions(): void {
    const actions = options.findings;
    if (actions === undefined) return;
    const byId = new Map(report.findings.map((finding) => [finding.id, finding]));
    for (const card of root.querySelectorAll<HTMLElement>('.pin[data-finding]')) {
      const finding = byId.get(card.dataset['finding'] ?? '');
      const slot = card.querySelector<HTMLElement>('.fix');
      if (finding !== undefined && slot !== null) actions.fill(slot, finding);
    }
  }
  const stopActions = options.findings?.onChange(fillActions);

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

  function showTab(next: PanelTab): void {
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
    view = renderFileView(fileRoot, data, { actions, back: closeFile, hasDiffPort: diffView !== null, hasReview: options.review !== undefined });
    const mount = view.area.querySelector<HTMLElement>(`.${DIFF_MOUNT}`);
    if (diffView !== null && mount !== null) {
      diffView.show(mount, data.placed.file.id, selection?.fileId === fileId ? selection.symbolId : null, report.meta.generatedAt);
    }
    markCurrent();
    fillActions();
  }

  function openFile(id: string, symbolId: string | null): void {
    // Hiding the list would drop the focus on the page: it moves to the file view's Back button instead.
    const fromList = fileId === null && document.activeElement !== null && scroll.contains(document.activeElement);
    if (fileId === null) {
      tabScroll = scroll.scrollTop;
      opener = fromList ? { fileId: id, symbolId } : null;
    }
    const same = fileId === id && view !== null;
    fileId = id;
    selection = { fileId: id, symbolId };
    scroll.hidden = true;
    header.hidden = true;
    fileRoot.hidden = false;
    if (same) {
      markCurrent();
      // A click on a floor of the open file: the diff goes back to it.
      if (symbolId !== null) diffView?.focus(symbolId, true);
    } else {
      renderFile();
      if (view !== null) view.scroll.scrollTop = 0;
    }
    root.dataset['mode'] = 'file';
    if (fromList) fileRoot.querySelector<HTMLElement>('.fv-back')?.focus({ preventScroll: true });
  }

  /** After the file view closed with the focus in it: back on the card or row it was opened from, or on the list. */
  function restoreFocus(target: Target): void {
    const card = body?.stops.find((other) => other.stop.step.fileId === target.fileId && other.stop.step.symbolId === target.symbolId)?.root;
    const row = body?.symbols.find((other) => other.target.fileId === target.fileId && other.target.symbolId === target.symbolId)?.root;
    (card ?? row ?? scroll).focus({ preventScroll: true });
  }

  function closeFile(): void {
    if (fileId === null) return;
    const returnTo = opener !== null && document.activeElement !== null && fileRoot.contains(document.activeElement) ? opener : null;
    opener = null;
    fileId = null;
    view = null;
    diffView?.hide();
    fileRoot.hidden = true;
    fileRoot.replaceChildren();
    header.hidden = false;
    scroll.hidden = false;
    // Hidden elements lose their scroll offset in some browsers: put it back.
    scroll.scrollTop = tabScroll;
    delete root.dataset['mode'];
    markCurrent();
    if (returnTo !== null) restoreFocus(returnTo);
  }

  /** The finding card the focus is in, and the action button it is on, if any. */
  function focusedFinding(): { id: string; inFile: boolean; action: string | null } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
    const card = active.closest<HTMLElement>('.pin[data-finding]');
    if (card === null) return null;
    return { id: card.dataset['finding'] ?? '', inFile: fileRoot.contains(card), action: active.dataset['action'] ?? null };
  }

  /**
   * A new Report redraws the cards: the focus goes back to the same finding's
   * card, on the same action when it is still offered, else on its first
   * button (Mark as intended becomes Undo), else on the list (or the file
   * view's Back). The scroll stays.
   */
  function restoreFindingFocus(focus: { id: string; inFile: boolean; action: string | null }): void {
    const area = focus.inFile ? fileRoot : scroll;
    const card = [...area.querySelectorAll<HTMLElement>('.pin[data-finding]')].find((node) => node.dataset['finding'] === focus.id);
    const buttons = [...(card?.querySelectorAll<HTMLElement>('button[data-action]') ?? [])];
    const target = buttons.find((node) => node.dataset['action'] === focus.action) ?? buttons[0] ?? (focus.inFile ? fileRoot.querySelector<HTMLElement>('.fv-back') : scroll);
    target?.focus({ preventScroll: true });
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
    if (event.key === 'Escape') {
      closeFile();
      return;
    }
    // J and K walk the stops; ] and [ the touched buildings, in the Report's order.
    const brackets = event.key === ']' ? 'next' : event.key === '[' ? 'prev' : null;
    const direction = brackets ?? (event.key === 'j' || event.key === 'J' ? 'next' : event.key === 'k' || event.key === 'K' ? 'prev' : null);
    if (direction === null) return;
    const target = stepTarget(brackets === null ? navTargets(report) : touchedTargets(report), selection, direction);
    if (target === null) return;
    event.preventDefault();
    options.onSelect(target.fileId, target.symbolId);
    markCurrent(true);
  };
  document.addEventListener('keydown', onKey);

  /** Fetches the sessions again; an older answer that arrives later is dropped, a failed fetch keeps what is shown. */
  function loadSessions(): void {
    const port = options.sessions;
    if (port === undefined) return;
    sessionsLoad?.abort();
    const current = new AbortController();
    sessionsLoad = current;
    port.load(current.signal).then(
      (next) => {
        if (current.signal.aborted) return;
        sessionsLoad = null;
        sessions = next;
        if (tab === 'session') {
          // Without sessions any more the tab goes back to Execution order.
          const top = hasSessions(sessions) ? scroll.scrollTop : 0;
          renderBody();
          scroll.scrollTop = top;
        }
        renderTabs();
      },
      () => {
        if (sessionsLoad === current) sessionsLoad = null;
      },
    );
  }
  const stopSessions = options.sessions?.onChange(loadSessions);

  renderChrome();
  renderBody();
  loadSessions();

  return {
    root,
    update(next) {
      report = next;
      if (fileId !== null) fileScroll = view?.scroll.scrollTop ?? 0;
      else tabScroll = scroll.scrollTop;
      const focus = focusedFinding();
      renderChrome();
      renderBody();
      scroll.scrollTop = tabScroll;
      if (fileId !== null) {
        renderFile();
        if (view !== null) view.scroll.scrollTop = fileScroll;
      }
      if (focus !== null) restoreFindingFocus(focus);
    },
    select(id, symbolId) {
      selection = id === null ? null : { fileId: id, symbolId };
      announce(id);
      if (id === null) {
        closeFile();
      } else if (fileId !== null && fileId !== id) {
        openFile(id, symbolId);
        return;
      }
      markCurrent(true);
    },
    hoverFloor(id, symbolId) {
      diffView?.hoverSymbol(id !== null && id === fileId ? symbolId : null);
    },
    lineRange() {
      const range = diffView?.range() ?? null;
      return fileId === null || range === null ? null : { fileId, range };
    },
    refreshReview() {
      if (view?.reviewSlot !== null && view !== null && fileId !== null) {
        const focus = selection?.fileId === fileId ? selection.symbolId : null;
        options.review?.fill(view.reviewSlot, fileId, focus);
      }
    },
    open: openFile,
    dispose() {
      stopActions?.();
      stopSessions?.();
      sessionsLoad?.abort();
      diffView?.dispose();
      document.removeEventListener('keydown', onKey);
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
      root.remove();
    },
  };
}
