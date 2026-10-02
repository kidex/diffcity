// The change rows of the Repo screen (SPEC.md section 3a): one row per change
// in the order the API sent them, with every field of the change record as
// the daemon computed it. Each row is a card: kind and review state as solid
// badges, the title as its heading, where it lives, the touched counters, and
// on the right the file verdict counters, the ones asking for a human look
// first and loudest. Rows are keyed and updated in place, so the focused
// title link survives live updates and clock ticks.

import type { ChangeSummary } from '../../../core/model/types.js';
import type { Verdict } from '../../../core/report/types.js';
import { routeHref } from '../../app/router.js';
import { h, renderList, replaceChildren } from '../../shared/dom.js';
import {
  aheadBehind,
  ARCHIVE_REASON_LABEL,
  ATTENTION_VERDICTS,
  CHANGED_STATUSES,
  EVENT_LABEL,
  HEAD_NOT_FETCHED,
  HEAD_NOT_FETCHED_TITLE,
  kindLabel,
  plural,
  QUIET_VERDICTS,
  refName,
  relativeTime,
  REVIEW_STATE_LABEL,
  shortDate,
  STATUS_LABEL,
  VERDICT_LABEL,
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
  verdicts: HTMLElement;
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

function notes(change: ChangeSummary): HTMLElement | null {
  if (!change.headAvailable) {
    return h('span', { class: 'note not-fetched', 'data-testid': 'head-not-fetched', title: HEAD_NOT_FETCHED_TITLE }, h('i', { 'aria-hidden': 'true' }), HEAD_NOT_FETCHED);
  }
  if (change.stats === null) return h('span', { class: 'note computing', 'data-testid': 'computing' }, h('i', { 'aria-hidden': 'true' }), 'computing');
  return null;
}

/** Touched files, then symbols by status; a zero status counter is kept but hidden. */
function stats(change: ChangeSummary): (Node | string)[] {
  const counts = change.headAvailable ? change.stats : null;
  if (counts === null) return [];
  return [
    h(
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
    ),
  ];
}

/**
 * The file verdict counters as the daemon counted them: the ones asking for
 * a human look (Needs your eyes, Risky, Outside the spec) as loud tiles, the
 * others quietly after them; a zero counter is left out.
 */
function verdicts(change: ChangeSummary): (Node | string)[] {
  const note = notes(change);
  if (note) return [note];
  const counts = change.stats;
  if (counts === null) return [];
  const flagged = ATTENTION_VERDICTS.filter((verdict) => counts.filesByVerdict[verdict] > 0);
  const quiet = QUIET_VERDICTS.filter((verdict) => counts.filesByVerdict[verdict] > 0);
  const tile = (verdict: Verdict, loud: boolean): HTMLElement =>
    h(
      'span',
      { class: `tag verdict ${verdict} ${loud ? 'flag' : 'quiet'}`, 'data-verdict': verdict },
      h('i', { 'aria-hidden': 'true' }),
      h('b', null, String(counts.filesByVerdict[verdict])),
      ' ',
      h('span', { class: 'label' }, VERDICT_LABEL[verdict]),
    );
  return [
    h(
      'span',
      { class: 'verdict-counts', 'data-testid': 'verdicts' },
      h(
        'span',
        { class: 'flags' },
        flagged.length > 0 ? flagged.map((verdict) => tile(verdict, true)) : h('span', { class: 'no-flags', 'data-testid': 'no-flags' }, 'Nothing flagged'),
      ),
      quiet.length > 0 ? h('span', { class: 'quiet-counts' }, quiet.map((verdict) => tile(verdict, false))) : null,
    ),
  ];
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
    const verdictBox = h('div', { class: 'attention' });
    const row = h(
      'li',
      { class: 'change-row', 'data-testid': 'change-row' },
      h(
        'div',
        { class: 'main' },
        h('div', { class: 'head' }, kind, badgeBox, event),
        h('h3', { class: 'change-name' }, link),
        whereBox,
        statsBox,
      ),
      verdictBox,
    );
    parts.set(row, { kind, link, badges: badgeBox, event, where: whereBox, stats: statsBox, verdicts: verdictBox });
    // The title is the keyboard target; a click anywhere on the row follows it.
    // The link handles its own clicks, modified and middle ones included.
    const open = (clicked: MouseEvent): void => {
      if (clicked.target instanceof Element && clicked.target.closest('a')) return;
      // The end of a text-selection drag is not a click on the row.
      const selection = row.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && row.contains(selection.anchorNode)) return;
      const href = link.getAttribute('href');
      if (!href) return;
      if (clicked.button === 1 || clicked.ctrlKey || clicked.metaKey || clicked.shiftKey) {
        window.open(link.href, '_blank', 'noopener');
      } else if (clicked.button === 0) {
        go(href);
      }
    };
    row.addEventListener('click', open);
    row.addEventListener('auxclick', (clicked) => {
      if (clicked.button === 1) open(clicked);
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
    const statsSig = JSON.stringify([change.headAvailable, change.stats]);
    rebuild(cells.stats, statsSig, () => stats(change));
    rebuild(cells.verdicts, statsSig, () => verdicts(change));
  }

  return {
    element,
    render(changes, at, isArchived) {
      now = at;
      archived = isArchived;
      element.setAttribute('aria-label', plural(changes.length, isArchived ? 'closed change' : 'change'));
      renderList<ChangeSummary, HTMLLIElement>(element, changes, (change) => String(change.id), createRow, updateRow);
    },
  };
}
