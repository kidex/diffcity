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

function count(value: number, column: string, extra = ''): HTMLTableCellElement {
  return h('td', { class: `num${value === 0 ? ' zero' : ''}${extra}`, 'data-col': column }, value);
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

  function createRow(repo: RepoSummary): HTMLTableRowElement {
    const row = h('tr', { 'data-testid': 'repo-row' });
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

    // Rebuild the cells only when what they show changes (the relative time
    // included), so a live refetch with the same data leaves the row alone.
    const signature = JSON.stringify([repo, repo.lastEventAt === null ? null : relativeTime(repo.lastEventAt, now)]);
    if (row.dataset['signature'] === signature) return;
    row.dataset['signature'] = signature;

    const indicators: HTMLElement[] = [];
    if (repo.collecting) indicators.push(h('span', { class: 'tag collecting', 'data-testid': 'collecting' }, h('i'), 'collecting'));
    if (repo.error !== null) indicators.push(h('span', { class: 'tag del', 'data-testid': 'collect-error', title: repo.error }, 'error'));
    if (!repo.active) indicators.push(h('span', { class: 'tag', 'data-testid': 'inactive' }, 'inactive'));

    const notes: HTMLElement[] = [];
    if (repo.error !== null) notes.push(h('span', { class: 'note error', title: repo.error }, repo.error));
    if (repo.watch === 'git-only') {
      notes.push(h('span', { class: 'note', 'data-testid': 'git-only' }, 'working tree not watched (too large)'));
    }

    const event = repo.lastEventAt;
    replaceChildren(
      row,
      h(
        'th',
        { scope: 'row', 'data-col': 'repo' },
        h(
          'div',
          { class: 'name-line' },
          h('a', { href: routeHref({ name: 'repo', id: repo.id }), class: 'name' }, repo.name),
          indicators,
        ),
        h('div', { class: 'path' }, repo.path),
        notes,
      ),
      count(repo.counts.draft, 'draft'),
      count(repo.counts.branch, 'branch'),
      count(repo.counts.pr, 'pr'),
      count(repo.unreviewed, 'unreviewed', ' strong'),
      count(repo.highFindings, 'high', repo.highFindings > 0 ? ' high' : ''),
      h('td', { class: `when${repo.lastAudit === null ? ' never' : ''}`, 'data-col': 'audit' }, lastAuditLabel(repo.lastAudit, now)),
      h(
        'td',
        { class: 'when', 'data-col': 'event', title: event ?? '' },
        event === null ? h('span', { class: 'none' }, 'no events yet') : h('time', { datetime: event }, relativeTime(event, now)),
      ),
    );
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
