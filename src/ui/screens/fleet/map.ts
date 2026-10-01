// The Fleet map (ADR-022): a 2D SVG with one lot per repo. The lot's side
// follows √(unreviewed + 1), its colour the audit age (always "never" in phase
// 2), an inactive repo is dimmed, and a lot is a link to its Repo screen. All
// colours come from tokens through fleet.css; this module only sets classes.

import type { RepoSummary } from '../../../core/model/types.js';
import { routeHref } from '../../app/router.js';
import { h, renderList, svg } from '../../shared/dom.js';
import { lastAuditLabel, plural, relativeTime } from '../../shared/format.js';
import type { AuditAge } from '../../shared/tokens.js';
import { fitLabel, layoutLots, lotSide, type MapLayout } from './layout.js';

/**
 * The audit age every lot shows in phase 2: there are no audits yet, and the
 * age thresholds come with the audit itself (SPEC.md section 8, phase 5),
 * computed by the daemon.
 */
const AUDIT_AGE: AuditAge = 'never';

/** Lift of the top face, in px: the slab's visible front edge. */
const DEPTH = 6;
/** Mono label width per character at 12.5px. */
const MONO_CHAR = 7.6;

export interface FleetMap {
  readonly element: HTMLElement;
  render(repos: readonly RepoSummary[], now: number): void;
  /** Highlights the lot of `repoId` (hover on its list row); null clears. */
  setHot(repoId: number | null): void;
  /** Called when a lot is hovered or focused (null when it is left). */
  onHot(listener: (repoId: number | null) => void): void;
  dispose(): void;
}

const LEGEND: readonly [AuditAge, string][] = [
  ['fresh', 'fresh'],
  ['aging', 'aging'],
  ['stale', 'stale'],
  ['never', 'never audited'],
];

/** The accessible name of a lot: everything its row says, in one sentence. */
export function lotLabel(repo: RepoSummary, now: number): string {
  const parts = [
    repo.name,
    plural(repo.unreviewed, 'unreviewed change'),
    `${String(repo.counts.draft)} draft, ${String(repo.counts.branch)} branch, ${String(repo.counts.pr)} PR`,
    plural(repo.highFindings, 'high finding'),
    `last audit ${lastAuditLabel(repo.lastAudit, now)}`,
  ];
  if (!repo.active) parts.push('inactive');
  if (repo.collecting) parts.push('collecting');
  if (repo.error !== null) parts.push('collection error');
  return parts.join(', ');
}

export function createFleetMap(): FleetMap {
  const lots = svg('g', { class: 'lots' });
  const canvas = svg(
    'svg',
    { class: 'fleet-svg', 'aria-label': 'Repo map', role: 'group', 'data-testid': 'fleet-map' },
    svg(
      'defs',
      {},
      svg('pattern', { id: 'fleet-plot', width: '12', height: '12', patternUnits: 'userSpaceOnUse' }, svg('path', { d: 'M 12 0 L 0 0 0 12', class: 'plot-line' })),
      ...LEGEND.map(([age]) =>
        svg(
          'linearGradient',
          { id: `fleet-face-${age}`, x1: '0', y1: '0', x2: '0.35', y2: '1' },
          svg('stop', { offset: '0', class: `face-hi audit-${age}` }),
          svg('stop', { offset: '1', class: `face-lo audit-${age}` }),
        ),
      ),
    ),
    lots,
  );

  const tip = h('div', { class: 'tip', 'aria-hidden': 'true' });
  const legend = h(
    'div',
    { class: 'legend', 'data-testid': 'fleet-legend' },
    h('span', { class: 'g' }, h('span', { class: 'legend-title' }, 'Last audit'), ...LEGEND.map(([age, label]) => h('span', { 'data-age': age }, h('i', { class: `audit audit-${age}` }), label))),
    h('span', null, h('i', { class: 'size' }), 'size: unreviewed changes'),
    h('span', null, h('i', { class: 'dim' }), 'dimmed: inactive'),
  );
  const element = h('figure', { class: 'fleet-map' }, canvas, tip, legend);

  let repos: readonly RepoSummary[] = [];
  let now = Date.now();
  let layout: MapLayout = { lots: [], height: 0 };
  let width = 0;
  let hot: number | null = null;
  const hotListeners = new Set<(repoId: number | null) => void>();

  function showTip(repo: RepoSummary | undefined): void {
    if (!repo) {
      tip.classList.remove('show');
      return;
    }
    const place = layout.lots.find((lot) => lot.id === repo.id);
    if (!place) return;
    tip.replaceChildren(
      h('div', { class: 'f' }, repo.name),
      h('div', { class: 'p' }, repo.path),
      h(
        'div',
        { class: 'row' },
        h('span', null, h('b', null, repo.counts.draft), ' draft'),
        h('span', null, h('b', null, repo.counts.branch), ' branch'),
        h('span', null, h('b', null, repo.counts.pr), ' PR'),
      ),
      h(
        'div',
        { class: 'pins' },
        repo.lastEventAt === null ? 'no events yet' : `last event ${relativeTime(repo.lastEventAt, now)}`,
      ),
    );
    // Beside the lot (right, or left when there is no room); a pointer moves
    // it from there.
    const tipWidth = 220;
    const right = place.x + place.side + 16;
    const left = right + tipWidth <= width - 8 ? right : Math.max(8, place.x - 16 - tipWidth);
    tip.style.left = `${String(left)}px`;
    tip.style.top = `${String(place.y)}px`;
    tip.classList.add('show');
  }

  /** As in the mockup: the card follows the pointer, offset 14 px, clamped to the map. */
  function followPointer(event: MouseEvent): void {
    const box = element.getBoundingClientRect();
    const x = event.clientX - box.left + 14;
    const y = event.clientY - box.top + 14;
    tip.style.left = `${String(Math.min(x, box.width - tip.offsetWidth - 8))}px`;
    tip.style.top = `${String(Math.min(y, box.height - tip.offsetHeight - 8))}px`;
  }

  function paintHot(): void {
    for (const lot of lots.children) {
      if (lot instanceof SVGElement) lot.classList.toggle('hot', Number(lot.dataset['repoId']) === hot);
    }
  }

  function emitHot(repoId: number | null): void {
    hot = repoId;
    paintHot();
    showTip(repos.find((repo) => repo.id === hot));
    for (const listener of hotListeners) listener(repoId);
  }

  function createLot(repo: RepoSummary): SVGElement {
    const lot = svg('a', { class: 'lot', 'data-testid': 'lot', 'data-repo-id': String(repo.id) });
    lot.addEventListener('mouseenter', () => {
      emitHot(repo.id);
    });
    lot.addEventListener('mousemove', (event) => {
      followPointer(event);
    });
    lot.addEventListener('mouseleave', () => {
      emitHot(null);
    });
    lot.addEventListener('focus', () => {
      emitHot(Number(lot.dataset['repoId']));
    });
    lot.addEventListener('blur', () => {
      emitHot(null);
    });
    updateLot(lot, repo);
    return lot;
  }

  function updateLot(lot: SVGElement, repo: RepoSummary): void {
    const place = layout.lots.find((candidate) => candidate.id === repo.id);
    if (!place) return;
    const { side } = place;
    const age = AUDIT_AGE;
    lot.setAttribute('href', routeHref({ name: 'repo', id: repo.id }));
    lot.setAttribute('aria-label', lotLabel(repo, now));
    lot.dataset['repoId'] = String(repo.id);
    lot.dataset['side'] = String(side);
    lot.dataset['age'] = age;
    lot.classList.toggle('inactive', !repo.active);
    lot.classList.toggle('collecting', repo.collecting);
    lot.classList.toggle('error', repo.error !== null);
    lot.classList.toggle('hot', repo.id === hot);
    lot.style.transform = `translate(${String(place.x)}px, ${String(place.y)}px)`;

    // Rebuild the drawing only when it changes: a live refetch that brings
    // the same data keeps the nodes (and any pointer or focus on them).
    const signature = JSON.stringify([repo, place.side, place.cell]);
    if (lot.dataset['signature'] === signature) return;
    lot.dataset['signature'] = signature;

    const radius = String(Math.min(12, Math.round(side / 7)));
    const countSize = Math.round(Math.min(34, Math.max(15, side * 0.27)));
    const centre = String(side / 2);
    const children: SVGElement[] = [
      svg('rect', { class: 'shadow', x: '2', y: String(DEPTH + 2), width: String(side - 4), height: String(side - 2), rx: radius }),
      svg('rect', { class: `side audit-${age}`, y: String(DEPTH), width: String(side), height: String(side), rx: radius }),
      svg(
        'g',
        { class: 'face' },
        svg('rect', { class: 'top', width: String(side), height: String(side), rx: radius, fill: `url(#fleet-face-${age})` }),
        svg('rect', { class: 'texture', x: '1', y: '1', width: String(side - 2), height: String(side - 2), rx: radius }),
        svg('rect', { class: `edge audit-${age}`, x: '0.75', y: '0.75', width: String(side - 1.5), height: String(side - 1.5), rx: radius }),
        svg('rect', { class: 'ring', x: '-4', y: '-4', width: String(side + 8), height: String(side + 8 + DEPTH), rx: String(Number(radius) + 4) }),
        svg(
          'text',
          { class: `count${repo.unreviewed === 0 ? ' zero' : ''}`, x: centre, y: String(side / 2 + (side >= 96 ? -2 : countSize * 0.36)), 'font-size': String(countSize) },
          String(repo.unreviewed),
        ),
        ...(side >= 96 ? [svg('text', { class: 'count-label', x: centre, y: String(side / 2 + 16) }, 'unreviewed')] : []),
        ...statusPip(repo, side),
      ),
      svg('text', { class: 'name', x: centre, y: String(side + DEPTH + 20) }, fitLabel(repo.name, place.cell / MONO_CHAR)),
      svg('text', { class: 'sub', x: centre, y: String(side + DEPTH + 37) }, subLabel(repo)),
    ];
    lot.replaceChildren(...children);
  }

  function relayout(): void {
    layout = layoutLots(
      repos.map((repo) => ({ id: repo.id, side: lotSide(repo.unreviewed) })),
      width,
    );
    canvas.setAttribute('viewBox', `0 0 ${String(width)} ${String(layout.height)}`);
    canvas.setAttribute('height', String(layout.height));
    renderList<RepoSummary, SVGElement>(lots, repos, (repo) => String(repo.id), createLot, updateLot);
    paintHot();
  }

  const observer = new ResizeObserver(() => {
    const next = Math.round(element.clientWidth);
    if (next !== width && next > 0) {
      width = next;
      relayout();
    }
  });
  observer.observe(element);

  return {
    element,
    render(next, at) {
      repos = next;
      now = at;
      if (hot !== null && !repos.some((repo) => repo.id === hot)) hot = null;
      width = Math.round(element.clientWidth) || width || 960;
      relayout();
    },
    setHot(repoId) {
      hot = repoId;
      paintHot();
    },
    onHot(listener) {
      hotListeners.add(listener);
    },
    dispose() {
      observer.disconnect();
      hotListeners.clear();
    },
  };
}

function subLabel(repo: RepoSummary): string {
  if (repo.error !== null) return 'collection error';
  if (repo.collecting) return 'collecting…';
  if (!repo.active) return 'inactive';
  return repo.highFindings > 0 ? plural(repo.highFindings, 'high finding') : `${String(repo.unreviewed)} to review`;
}

/** The collecting or error pip in the lot's top-right corner. */
function statusPip(repo: RepoSummary, side: number): SVGElement[] {
  const cx = String(side - 12);
  if (repo.error !== null) {
    return [svg('g', { class: 'pip pip-error' }, svg('circle', { cx, cy: '12', r: '7' }), svg('text', { x: cx, y: '15.5' }, '!'))];
  }
  if (repo.collecting) {
    return [svg('g', { class: 'pip pip-collecting' }, svg('circle', { class: 'pulse', cx, cy: '12', r: '4' }), svg('circle', { cx, cy: '12', r: '4' }))];
  }
  return [];
}
