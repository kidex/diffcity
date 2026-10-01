// The change rows of the Repo screen (SPEC.md section 3a): one row per change
// in the order the API sent them, with every field of the change record as
// the daemon computed it. Rows are keyed and updated in place, so the focused
// title link survives live updates and clock ticks.

import type { ChangeSummary } from '../../../core/model/types.js';
import { routeHref } from '../../app/router.js';
import { h, renderList, replaceChildren } from '../../shared/dom.js';
import {
  aheadBehind,
  ARCHIVE_REASON_LABEL,
  CHANGED_STATUSES,
  EVENT_LABEL,
  HEAD_NOT_FETCHED,
  HEAD_NOT_FETCHED_TITLE,
  kindLabel,
  plural,
  refName,
  relativeTime,
  REVIEW_STATE_LABEL,
  shortDate,
  STATUS_LABEL,
  VERDICT_LABEL,
  VERDICTS,
} from '../../shared/format.js';

export interface ChangeList {
  readonly element: HTMLOListElement;
  /** `archived` rows are read-only: their archive reason and date replace the review badges. */
  render(changes: readonly ChangeSummary[], now: number, archived: boolean): void;
}

/** The parts of a row, created once and updated in place. */
interface RowParts {
  kind: HTMLElement;
  link: HTMLAnchorElement;
  badges: HTMLElement;
  event: HTMLElement;
  where: HTMLElement;
  stats: HTMLElement;
}

/** Sets `text` on `element` only when it differs, so unchanged text nodes stay. */
function setText(element: Element, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** Rebuilds `container` only when `signature` changed: what it holds is never focusable. */
function rebuild(container: HTMLElement, signature: string, build: () => (Node | string)[]): void {
  if (container.dataset['sig'] === signature) return;
  container.dataset['sig'] = signature;
  replaceChildren(container, build());
}

function badges(change: ChangeSummary, archived: boolean): HTMLElement[] {
  if (archived && change.archiveReason !== null) {
    const at = change.archivedAt ?? change.updatedAt;
    return [
      h('span', { class: `tag archived ${change.archiveReason}`, 'data-testid': 'archive-reason' }, ARCHIVE_REASON_LABEL[change.archiveReason]),
      h('time', { class: 'archived-at', datetime: at, title: at, 'data-testid': 'archived-at' }, shortDate(at)),
    ];
  }
  const list = [
    h(
      'span',
      { class: `tag review ${change.reviewState}`, 'data-testid': 'review-state', 'data-state': change.reviewState },
      REVIEW_STATE_LABEL[change.reviewState],
    ),
  ];
  if (change.agentUnreviewed) {
    list.unshift(h('span', { class: 'tag agent', 'data-testid': 'agent-badge' }, h('i', { 'aria-hidden': 'true' }), 'Agent worked, not reviewed'));
  }
  return list;
}

function where(change: ChangeSummary): (Node | string)[] {
  const parts: (Node | string)[] = [];
  if (change.kind !== 'pr') parts.push(h('code', { class: 'ref', 'data-testid': 'ref' }, refName(change)));
  parts.push(h('span', { class: 'vs' }, 'against'), h('code', { class: 'base' }, change.base));
  const counts = aheadBehind(change);
  if (counts) parts.push(h('span', { class: 'ahead', 'data-testid': 'ahead-behind' }, counts));
  if (change.dirty) parts.push(h('span', { class: 'tag mod dirty', 'data-testid': 'dirty' }, 'uncommitted changes'));
  // Real spaces between the parts, so the text reads right without the CSS gaps.
  return parts.flatMap((part, index) => (index === 0 ? [part] : [' ', part]));
}

function stats(change: ChangeSummary): (Node | string)[] {
  if (!change.headAvailable) {
    return [
      h(
        'span',
        { class: 'note not-fetched', 'data-testid': 'head-not-fetched', title: HEAD_NOT_FETCHED_TITLE },
        HEAD_NOT_FETCHED,
      ),
    ];
  }
  const { stats: counts } = change;
  if (counts === null) return [h('span', { class: 'note computing', 'data-testid': 'computing' }, h('i', { 'aria-hidden': 'true' }), 'computing')];

  const symbols = h(
    'span',
    { class: 'stats', 'data-testid': 'touched' },
    h('span', { class: 'stat files' }, h('b', null, String(counts.touchedFiles)), ' ', h('small', null, counts.touchedFiles === 1 ? 'file' : 'files')),
    ' ',
    CHANGED_STATUSES.map((status) =>
      h(
        'span',
        { class: `stat ${status}${counts.symbolsByStatus[status] === 0 ? ' zero' : ''}`, 'data-status': status },
        h('span', { class: 'sw', 'aria-hidden': 'true' }),
        h('b', null, String(counts.symbolsByStatus[status])),
        ' ',
        h('small', null, STATUS_LABEL[status]),
      ),
    ),
  );
  const verdicts = h(
    'span',
    { class: 'verdict-counts', 'data-testid': 'verdicts' },
    VERDICTS.filter((verdict) => counts.filesByVerdict[verdict] > 0).map((verdict) =>
      h(
        'span',
        { class: `tag verdict ${verdict}`, 'data-verdict': verdict },
        h('i', { 'aria-hidden': 'true' }),
        VERDICT_LABEL[verdict],
        ' ',
        h('b', null, String(counts.filesByVerdict[verdict])),
      ),
    ),
  );
  return [symbols, verdicts];
}

export function createChangeList(go: (href: string) => void): ChangeList {
  const element = h('ol', { class: 'change-list', 'data-testid': 'change-list' });
  const parts = new WeakMap<HTMLElement, RowParts>();
  let now = Date.now();
  let archived = false;

  function createRow(change: ChangeSummary): HTMLLIElement {
    const kind = h('span', { class: 'tag kind', 'data-testid': 'kind' });
    const link = h('a', { class: 'change-title', 'data-testid': 'change-title' });
    const badgeBox = h('span', { class: 'badges' });
    const event = h('span', { class: 'when', 'data-testid': 'last-event' });
    const whereBox = h('div', { class: 'where' });
    const statsBox = h('div', { class: 'counts' });
    const row = h(
      'li',
      { class: 'change-row', 'data-testid': 'change-row' },
      h('div', { class: 'head' }, kind, link, badgeBox, event),
      whereBox,
      statsBox,
    );
    parts.set(row, { kind, link, badges: badgeBox, event, where: whereBox, stats: statsBox });
    // The title is the keyboard target; a click anywhere on the row follows it.
    row.addEventListener('click', (clicked) => {
      if (clicked.target instanceof Element && clicked.target.closest('a')) return;
      const href = link.getAttribute('href');
      if (href) go(href);
    });
    updateRow(row, change);
    return row;
  }

  function updateRow(row: HTMLElement, change: ChangeSummary): void {
    const cells = parts.get(row);
    if (!cells) return;
    row.dataset['changeId'] = String(change.id);
    row.dataset['kind'] = change.kind;
    row.classList.toggle('archived', archived);
    row.classList.toggle('agent', change.agentUnreviewed && !archived);

    setText(cells.kind, kindLabel(change));
    const href = routeHref({ name: 'change', id: change.id });
    if (cells.link.getAttribute('href') !== href) cells.link.setAttribute('href', href);
    setText(cells.link, change.title);

    rebuild(cells.badges, JSON.stringify([archived, change.reviewState, change.agentUnreviewed, change.archiveReason, change.archivedAt]), () =>
      badges(change, archived),
    );

    const at = change.lastEvent.at;
    rebuild(cells.event, JSON.stringify([change.lastEvent, relativeTime(at, now)]), () => [
      h('span', { class: 'ev' }, EVENT_LABEL[change.lastEvent.type]),
      ' ',
      h('time', { datetime: at, title: at }, relativeTime(at, now)),
    ]);

    rebuild(cells.where, JSON.stringify([change.kind, change.ref, change.prNumber, change.base, change.ahead, change.behind, change.dirty]), () =>
      where(change),
    );
    rebuild(cells.stats, JSON.stringify([change.headAvailable, change.stats]), () => stats(change));
  }

  return {
    element,
    render(changes, at, isArchived) {
      now = at;
      archived = isArchived;
      element.setAttribute('aria-label', plural(changes.length, isArchived ? 'archived change' : 'change'));
      renderList<ChangeSummary, HTMLLIElement>(element, changes, (change) => String(change.id), createRow, updateRow);
    },
  };
}
