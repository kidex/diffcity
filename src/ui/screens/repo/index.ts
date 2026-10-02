// Repo (SPEC.md section 6): the dynamic change list of one repo (section 3a),
// newest event first as the API orders it, with state badges, aggregated
// verdicts, the kind and review-state filters and the "Audit now" button.
// "Show closed changes" swaps the list for the archive (merged, deleted,
// closed or cleaned changes, read-only) and its own kind filter.
// Data comes from `GET /api/repos/:id` (and `?archived=1` for the archive);
// SSE `hello`, `repo`, `changes`, `snapshot` and `collect` for this repo
// refetch it (ADR-017), coalesced per 250 ms.

import './repo.css';

import type { ChangeKind, ChangeSummary, RepoDetail, ReviewState } from '../../../core/model/types.js';
import { ApiRequestError } from '../../data/api.js';
import type { DataContext } from '../../data/context.js';
import { copyButton } from '../../shared/copy.js';
import { h, replaceChildren } from '../../shared/dom.js';
import { CLOSED_CHANGES_HINT, KIND_FILTER_LABEL, KINDS, plural, REVIEW_STATE_LABEL, REVIEW_STATES } from '../../shared/format.js';
import { applyFilters, filterCounts, isFiltered, NO_FILTERS, toggleKind, toggleReview, type RepoFilters } from './filters.js';
import { noteCopy } from '../../shared/notes.js';
import { createChangeList } from './list.js';

/** Relative times ("3 min ago") are redrawn this often. */
const CLOCK_MS = 30_000;

export const AUDIT_TOOLTIP = 'Audit arrives in a later version';

/** The archive toggle names what a click does: open it, or go back. */
export const SHOW_CLOSED = 'Show closed changes';
export const BACK_TO_OPEN = 'Back to open changes';

type RepoState = 'loading' | 'ready' | 'missing' | 'unreachable';

interface Chip<T> {
  value: T;
  button: HTMLButtonElement;
  count: HTMLElement;
}

function chip<T extends string>(value: T, label: string, group: string, onClick: () => void): Chip<T> {
  const count = h('b');
  const button = h(
    'button',
    { type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-filter': group, 'data-value': value, onclick: onClick },
    h('i', { 'aria-hidden': 'true' }),
    label,
    ' ',
    count,
  );
  return { value, button, count };
}

export interface RepoMountOptions {
  /**
   * The change screen mounted right before this one, if any. Coming back
   * from it (the back link, the breadcrumb, browser Back) puts focus on its
   * row instead of on <body>. Any other way in leaves focus alone.
   */
  fromChange?: number;
}

export function mountRepo(element: HTMLElement, context: DataContext, repoId: number, options: RepoMountOptions = {}): () => void {
  const { api, live, refetch } = context;
  const go = (href: string): void => {
    window.location.hash = href;
  };

  let detail: RepoDetail | null = null;
  let archivedChanges: ChangeSummary[] | null = null;
  /** The last archive fetch failed; cleared by the next successful one. */
  let archiveFailed = false;
  let showArchive = false;
  let filters: RepoFilters = NO_FILTERS;
  let failed: 'missing' | 'unreachable' | null = null;
  let disposed = false;
  let shown: RepoState | null = null;
  const controllers = new Map<string, AbortController>();

  // ---------- header ----------
  const name = h('h1');
  const path = h('p', { class: 'path' });
  const indicators = h('span', { class: 'indicators' });
  // Out of the accessibility tree until shown; aria-describedby still reads it.
  const archiveTip = h('span', { class: 'hint-tip on-demand', role: 'tooltip', id: `archive-tip-${String(repoId)}` }, CLOSED_CHANGES_HINT);
  const archiveToggle = h(
    'button',
    {
      type: 'button',
      class: 'btn archive-toggle',
      'aria-describedby': archiveTip.id,
      'data-testid': 'archive-toggle',
      onclick: () => {
        showArchive = !showArchive;
        filters = NO_FILTERS;
        if (showArchive) loadArchived();
        render();
      },
    },
    SHOW_CLOSED,
  );
  // aria-disabled, not disabled: the button stays focusable, so the keyboard
  // reaches it and its tooltip, and a click does nothing.
  const auditTip = h('span', { class: 'hint-tip', role: 'tooltip', id: `audit-tip-${String(repoId)}` }, AUDIT_TOOLTIP);
  const audit = h(
    'button',
    {
      type: 'button',
      class: 'btn primary audit',
      'aria-disabled': 'true',
      'aria-describedby': auditTip.id,
      'data-testid': 'audit-now',
      onclick: (event: Event) => {
        event.preventDefault();
      },
    },
    'Audit now',
  );
  const head = h(
    'div',
    { class: 'repo-head' },
    h('div', { class: 'title' }, h('div', { class: 'name-line' }, name, indicators), path),
    h('div', { class: 'actions' }, h('span', { class: 'has-tip' }, archiveToggle, archiveTip), h('span', { class: 'has-tip' }, audit, auditTip)),
  );

  // ---------- notes (calm info banners under the header, one per daemon note) ----------
  const notesSlot = h('div', { class: 'repo-notes', 'data-testid': 'repo-notes' });

  // ---------- filters ----------
  const kindChips = KINDS.map((kind) =>
    chip(kind, KIND_FILTER_LABEL[kind], 'kind', () => {
      filters = toggleKind(filters, kind);
      render();
    }),
  );
  const reviewChips = REVIEW_STATES.map((review) =>
    chip(review, REVIEW_STATE_LABEL[review], 'review', () => {
      filters = toggleReview(filters, review);
      render();
    }),
  );
  const clearButton = (testId: string, label: string): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip clear',
        'data-testid': testId,
        onclick: () => {
          filters = NO_FILTERS;
          render();
        },
      },
      label,
    );
  const filterBar = h(
    'div',
    { class: 'filters', 'data-testid': 'open-filters' },
    h('div', { class: 'chips kinds', role: 'group', 'aria-label': 'Filter by kind' }, kindChips.map((c) => c.button)),
    h(
      'div',
      { class: 'chips reviews', role: 'group', 'aria-label': 'Filter by review state' },
      reviewChips.map((c) => c.button),
      clearButton('show-everything', 'Show everything'),
    ),
  );
  // The archive has its own bar: closed changes have no review to filter by.
  const closedKindChips = KINDS.map((kind) =>
    chip(kind, KIND_FILTER_LABEL[kind], 'kind', () => {
      filters = toggleKind(filters, kind);
      render();
    }),
  );
  const archiveBar = h(
    'div',
    { class: 'filters closed', 'data-testid': 'closed-filters' },
    h('p', { class: 'closed-note' }, h('i', { 'aria-hidden': 'true' }), 'Read-only: closed changes are kept for reference and can’t be reviewed.'),
    h(
      'div',
      { class: 'chips' },
      h('div', { class: 'chips kinds', role: 'group', 'aria-label': 'Filter by kind' }, closedKindChips.map((c) => c.button)),
      clearButton('show-all-closed', 'Show all closed'),
    ),
  );
  const filterSlot = h('div', { class: 'filter-slot' });

  // ---------- list ----------
  const list = createChangeList(go);
  const listTitle = h('h2', { id: `changes-title-${String(repoId)}` });
  // The visible counter is terse ("3 of 6"); screen readers get the sentence.
  const listTotal = h('span', { class: 'cnt', 'aria-hidden': 'true', 'data-testid': 'change-count' });
  const listTotalText = h('span', { class: 'sr-only', 'data-testid': 'change-count-text' });
  const listNote = h('p');
  const listStatus = h('p', { class: 'list-status', role: 'status', 'data-testid': 'list-empty' });
  const listSection = h(
    'section',
    { class: 'changes', 'aria-labelledby': listTitle.id },
    h('header', null, h('div', { class: 'heading' }, listTitle, listTotal, listTotalText), listNote),
    list.element,
    listStatus,
  );

  const status = h('p', { class: 'repo-status', role: 'status' });
  const stage = h('section', { class: 'stage repo', 'data-screen': 'repo' });
  element.dataset['repoId'] = String(repoId);
  replaceChildren(element, stage);

  function state(): RepoState {
    if (detail === null) return failed ?? 'loading';
    return 'ready';
  }

  function paintChips<T extends string>(chips: Chip<T>[], active: T | null, counts: Record<T, number>): void {
    for (const { value, button, count } of chips) {
      const on = value === active;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
      const text = String(counts[value]);
      if (count.textContent !== text) count.textContent = text;
    }
  }

  /** The change to put focus back on, used at the first render with data, then dropped. */
  let returnTo = options.fromChange ?? null;

  /**
   * Focuses the row of the change we came back from, once, if it is listed
   * and nothing else has the focus: not while the user is already somewhere
   * else, such as typing in the Cmd+K palette.
   */
  function restoreFocus(): void {
    if (returnTo === null) return;
    const changeId = returnTo;
    returnTo = null;
    const active = element.ownerDocument.activeElement;
    if (active !== null && active !== element.ownerDocument.body) return;
    if (element.ownerDocument.querySelector('.palette-backdrop:not([hidden])')) return;
    const link = list.element.querySelector<HTMLAnchorElement>(`[data-change-id="${String(changeId)}"] a[href]`);
    if (!link) return;
    link.focus({ preventScroll: true });
    link.scrollIntoView({ block: 'nearest' });
  }

  /** Rebuilt only when the notes change, so a focused Copy button survives live updates. */
  function renderNotes(notes: readonly string[], repoPath: string): void {
    const signature = JSON.stringify([notes, repoPath]);
    if (notesSlot.dataset['sig'] === signature) return;
    notesSlot.dataset['sig'] = signature;
    replaceChildren(
      notesSlot,
      notes.map((note) => {
        const { text, command } = noteCopy(note, repoPath);
        return h(
          'div',
          { class: 'repo-note', role: 'note', 'data-testid': 'repo-note' },
          h('i', { class: 'mark', 'aria-hidden': 'true' }, 'i'),
          h(
            'div',
            { class: 'body' },
            h('p', null, text),
            command === null
              ? null
              : h('div', { class: 'cmd' }, h('span', { class: 'prompt', 'aria-hidden': 'true' }, '$'), h('code', { 'data-testid': 'note-command' }, command), copyButton(command)),
          ),
        );
      }),
    );
  }

  function renderReady(repo: RepoDetail): void {
    const now = Date.now();
    if (name.textContent !== repo.repo.name) name.textContent = repo.repo.name;
    if (path.textContent !== repo.repo.path) path.textContent = repo.repo.path;
    const signature = JSON.stringify([repo.repo.collecting, repo.repo.error, repo.repo.watch]);
    if (indicators.dataset['sig'] !== signature) {
      indicators.dataset['sig'] = signature;
      const tags: HTMLElement[] = [];
      if (repo.repo.collecting) tags.push(h('span', { class: 'tag collecting', 'data-testid': 'collecting' }, h('i'), 'collecting'));
      if (repo.repo.error !== null) tags.push(h('span', { class: 'tag del', title: repo.repo.error, 'data-testid': 'collect-error' }, 'error'));
      if (repo.repo.watch === 'git-only') tags.push(h('span', { class: 'tag', 'data-testid': 'git-only' }, 'working tree not watched (too large)'));
      replaceChildren(indicators, tags);
    }
    renderNotes(repo.repo.notes, repo.repo.path);

    const toggleText = showArchive ? BACK_TO_OPEN : SHOW_CLOSED;
    if (archiveToggle.textContent !== toggleText) archiveToggle.textContent = toggleText;
    archiveToggle.dataset['showing'] = showArchive ? 'closed' : 'open';
    archiveToggle.classList.toggle('on', showArchive);
    stage.classList.toggle('archive', showArchive);
    const bar = showArchive ? archiveBar : filterBar;
    if (filterSlot.firstElementChild !== bar) {
      // Only when the view changes, so a focused chip survives live updates.
      replaceChildren(filterSlot, bar);
    }

    const source = showArchive ? archivedChanges : repo.changes;
    const all = source ?? [];
    const counts = filterCounts(all);
    paintChips<ChangeKind>(showArchive ? closedKindChips : kindChips, filters.kind, counts.kind);
    paintChips<ReviewState>(reviewChips, filters.review, counts.review);

    const rows = applyFilters(all, filters);
    if (showArchive) {
      listTitle.textContent = 'Closed changes';
      listNote.textContent = `${CLOSED_CHANGES_HINT}.`;
    } else {
      listTitle.textContent = 'Open changes';
      listNote.textContent = 'Drafts, branches and pull requests, latest activity first.';
    }
    const total = isFiltered(filters) ? `${String(rows.length)} of ${String(all.length)}` : String(all.length);
    listTotal.textContent = total;
    const noun = showArchive ? 'closed change' : 'change';
    listTotalText.textContent = isFiltered(filters) ? `${String(rows.length)} of ${plural(all.length, noun)} shown` : plural(all.length, noun);
    list.render(rows, now, showArchive);
    restoreFocus();

    let message = '';
    if (showArchive && archiveFailed) message = 'Can’t load the closed changes right now.';
    else if (source === null) message = 'Loading the closed changes…';
    else if (all.length === 0) message = showArchive ? 'No change closed in the last 90 days.' : 'No changes yet. Drafts, branches and pull requests appear here as soon as diffcity sees them.';
    else if (rows.length === 0) message = 'No change matches these filters.';
    listStatus.textContent = message;
    listStatus.hidden = message === '';
  }

  function render(): void {
    const next = state();
    stage.dataset['state'] = next;
    if (next !== shown) {
      shown = next;
      switch (next) {
        case 'loading':
          status.textContent = 'Loading changes…';
          replaceChildren(stage, h('div', { class: 'repo-hero' }, status));
          break;
        case 'missing':
          replaceChildren(
            stage,
            h(
              'div',
              { class: 'repo-hero', 'data-testid': 'repo-missing' },
              h('h2', null, 'This repo is not tracked'),
              h('p', null, 'It may have been removed. ', h('a', { href: '#/' }, 'Back to all repos')),
            ),
          );
          break;
        case 'unreachable':
          replaceChildren(
            stage,
            h(
              'div',
              { class: 'repo-hero', 'data-testid': 'repo-unreachable' },
              h('h2', null, 'Can’t reach the diffcity daemon'),
              h('p', null, 'The changes appear as soon as the daemon answers.'),
            ),
          );
          break;
        case 'ready':
          replaceChildren(stage, head, notesSlot, filterSlot, listSection);
          break;
      }
    }
    if (next === 'ready' && detail) renderReady(detail);
  }

  async function fetchInto<T>(key: string, request: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, onError: (error: unknown) => void): Promise<void> {
    if (disposed) return;
    controllers.get(key)?.abort();
    const controller = new AbortController();
    controllers.set(key, controller);
    try {
      const value = await request(controller.signal);
      if (controller.signal.aborted) return;
      apply(value);
    } catch (error) {
      if (controller.signal.aborted) return;
      onError(error);
    }
    render();
  }

  const loadDetail = (): void => {
    void fetchInto(
      'detail',
      (signal) => api.repo(repoId, signal),
      (value) => {
        detail = value;
        failed = null;
      },
      (error) => {
        // Keep what is on screen; the daemon indicator says why it is stale.
        if (detail === null) failed = error instanceof ApiRequestError && error.status === 404 ? 'missing' : 'unreachable';
      },
    );
  };

  function loadArchived(): void {
    void fetchInto(
      'archived',
      (signal) => api.archivedChanges(repoId, signal),
      (value) => {
        archivedChanges = value;
        archiveFailed = false;
      },
      () => {
        // Keep any archive already shown; say the refresh failed.
        archiveFailed = true;
      },
    );
  }

  const reload = (): void => {
    if (disposed) return;
    refetch.request(`repo:${String(repoId)}`, loadDetail);
    if (showArchive) refetch.request(`repo:${String(repoId)}:archived`, loadArchived);
  };
  const reloadIfMine = ({ repoId: id }: { repoId: number }): void => {
    if (id === repoId) reload();
  };

  const stops = [
    live.on('hello', reload),
    live.on('repo', reloadIfMine),
    live.on('changes', reloadIfMine),
    live.on('snapshot', reloadIfMine),
    live.on('collect', reloadIfMine),
  ];
  const clock = setInterval(() => {
    if (shown === 'ready') render();
  }, CLOCK_MS);

  render();
  reload();

  return () => {
    disposed = true;
    for (const stop of stops) stop();
    clearInterval(clock);
    for (const controller of controllers.values()) controller.abort();
    delete element.dataset['repoId'];
    element.replaceChildren();
  };
}
