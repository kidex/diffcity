// The repo list under the Fleet map (SPEC.md section 6): one row per repo in
// the API order, with the counters exactly as the daemon sends them.

import type { RepoSummary } from '../../../core/model/types.js';
import { routeHref } from '../../app/router.js';
import { h, renderList, replaceChildren } from '../../shared/dom.js';
import { lastAuditLabel, plural, relativeTime } from '../../shared/format.js';

export interface FleetList {
  readonly element: HTMLElement;
  render(repos: readonly RepoSummary[], now: number): void;
  setHot(repoId: number | null): void;
  onHot(listener: (repoId: number | null) => void): void;
}

const COLUMNS = [
  ['repo', 'Repo'],
  ['draft', 'Draft'],
  ['branch', 'Branch'],
  ['pr', 'PR'],
  ['unreviewed', 'Unreviewed'],
  ['high', 'High findings'],
  ['audit', 'Last audit'],
  ['event', 'Last event'],
] as const;

/** The cells of a row, created once and updated in place on every render. */
interface RowParts {
  link: HTMLAnchorElement;
  indicators: HTMLElement;
  path: HTMLElement;
  notes: HTMLElement;
  counts: Record<'draft' | 'branch' | 'pr' | 'unreviewed' | 'high', HTMLTableCellElement>;
  audit: HTMLTableCellElement;
  event: HTMLTableCellElement;
}

const COUNT_COLUMNS = ['draft', 'branch', 'pr', 'unreviewed', 'high'] as const;

/** Sets `text` on `element` only when it differs, so unchanged text nodes stay. */
function setText(element: Element, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function setCount(cell: HTMLTableCellElement, value: number, extra: string): void {
  setText(cell, String(value));
  cell.className = `num${value === 0 ? ' zero' : ''}${extra}`;
}

export function createFleetList(go: (href: string) => void): FleetList {
  const body = h('tbody');
  const total = h('span', { class: 'cnt' });
  const element = h(
    'section',
    { class: 'fleet-list', 'aria-labelledby': 'fleet-list-title' },
    h('header', null, h('h2', { id: 'fleet-list-title' }, 'Repos', total), h('p', null, 'Latest activity first. Open a repo to see its drafts, branches and pull requests.')),
    h(
      'table',
      { 'data-testid': 'fleet-list' },
      h('thead', null, h('tr', null, COLUMNS.map(([key, label]) => h('th', { scope: 'col', 'data-col': key }, label)))),
      body,
    ),
  );

  let hot: number | null = null;
  let now = Date.now();
  const hotListeners = new Set<(repoId: number | null) => void>();

  function emitHot(repoId: number | null): void {
    hot = repoId;
    paintHot();
    for (const listener of hotListeners) listener(repoId);
  }

  function paintHot(): void {
    for (const row of body.children) {
      if (row instanceof HTMLElement) row.classList.toggle('hot', Number(row.dataset['repoId']) === hot);
    }
  }

  const parts = new WeakMap<HTMLElement, RowParts>();

  function createRow(repo: RepoSummary): HTMLTableRowElement {
    const link = h('a', { class: 'name' });
    const indicators = h('span', { class: 'indicators' });
    const path = h('div', { class: 'path' });
    const notes = h('div', { class: 'notes' });
    const cell = (column: string): HTMLTableCellElement => h('td', { 'data-col': column });
    const counts = Object.fromEntries(COUNT_COLUMNS.map((column) => [column, cell(column)])) as RowParts['counts'];
    const audit = cell('audit');
    const event = cell('event');
    const row = h(
      'tr',
      { 'data-testid': 'repo-row' },
      h('th', { scope: 'row', 'data-col': 'repo' }, h('div', { class: 'name-line' }, link, indicators), path, notes),
      COUNT_COLUMNS.map((column) => counts[column]),
      audit,
      event,
    );
    parts.set(row, { link, indicators, path, notes, counts, audit, event });
    // The name is the keyboard target; a click anywhere on the row follows it.
    row.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a')) return;
      const href = row.querySelector('a')?.getAttribute('href');
      if (href) go(href);
    });
    row.addEventListener('mouseenter', () => {
      emitHot(Number(row.dataset['repoId']));
    });
    row.addEventListener('mouseleave', () => {
      emitHot(null);
    });
    updateRow(row, repo);
    return row;
  }

  function updateRow(row: HTMLElement, repo: RepoSummary): void {
    row.dataset['repoId'] = String(repo.id);
    row.classList.toggle('inactive', !repo.active);
    row.classList.toggle('hot', repo.id === hot);

    const cells = parts.get(row);
    if (!cells) return;
    // Text, classes and attributes change in place: the name link keeps its
    // focus across live updates and clock ticks. Only the indicator and note
    // containers, which hold nothing focusable, are rebuilt, and only when
    // what they show changes.
    const href = routeHref({ name: 'repo', id: repo.id });
    if (cells.link.getAttribute('href') !== href) cells.link.setAttribute('href', href);
    setText(cells.link, repo.name);
    setText(cells.path, repo.path);

    const status = JSON.stringify([repo.collecting, repo.error, repo.active, repo.watch]);
    if (cells.indicators.dataset['status'] !== status) {
      cells.indicators.dataset['status'] = status;
      const indicators: HTMLElement[] = [];
      if (repo.collecting) indicators.push(h('span', { class: 'tag collecting', 'data-testid': 'collecting' }, h('i'), 'collecting'));
      if (repo.error !== null) indicators.push(h('span', { class: 'tag del', 'data-testid': 'collect-error', title: repo.error }, 'error'));
      if (!repo.active) indicators.push(h('span', { class: 'tag', 'data-testid': 'inactive' }, 'inactive'));
      replaceChildren(cells.indicators, indicators);

      const notes: HTMLElement[] = [];
      if (repo.error !== null) notes.push(h('span', { class: 'note error', title: repo.error }, repo.error));
      if (repo.watch === 'git-only') notes.push(h('span', { class: 'note', 'data-testid': 'git-only' }, 'working tree not watched (too large)'));
      replaceChildren(cells.notes, notes);
    }

    setCount(cells.counts.draft, repo.counts.draft, '');
    setCount(cells.counts.branch, repo.counts.branch, '');
    setCount(cells.counts.pr, repo.counts.pr, '');
    setCount(cells.counts.unreviewed, repo.unreviewed, ' strong');
    setCount(cells.counts.high, repo.highFindings, repo.highFindings > 0 ? ' high' : '');

    cells.audit.className = `when${repo.lastAudit === null ? ' never' : ''}`;
    setText(cells.audit, lastAuditLabel(repo.lastAudit, now));

    const at = repo.lastEventAt;
    cells.event.className = 'when';
    cells.event.title = at ?? '';
    const shown = cells.event.firstElementChild;
    if (at === null) {
      if (!(shown instanceof HTMLSpanElement)) replaceChildren(cells.event, h('span', { class: 'none' }, 'no events yet'));
    } else if (shown instanceof HTMLTimeElement) {
      if (shown.dateTime !== at) shown.dateTime = at;
      setText(shown, relativeTime(at, now));
    } else {
      replaceChildren(cells.event, h('time', { datetime: at }, relativeTime(at, now)));
    }
  }

  return {
    element,
    render(repos, at) {
      now = at;
      if (hot !== null && !repos.some((repo) => repo.id === hot)) hot = null;
      total.textContent = String(repos.length);
      total.setAttribute('aria-label', plural(repos.length, 'repo'));
      renderList<RepoSummary, HTMLTableRowElement>(body, repos, (repo) => String(repo.id), createRow, updateRow);
    },
    setHot(repoId) {
      hot = repoId;
      paintHot();
    },
    onHot(listener) {
      hotListeners.add(listener);
    },
  };
}
