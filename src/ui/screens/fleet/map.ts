// The Fleet map (ADR-022): a 2D SVG with one lot per repo. The lot's side
// follows √(unreviewed + 1), its colour the audit age (always "never" in phase
// 2), an inactive repo is dimmed, and a lot is a link to its Repo screen. All
// colours come from tokens through fleet.css; this module only sets classes.

import type { RepoSummary } from '../../../core/model/types.js';
import { routeHref } from '../../app/router.js';
import { h, renderList, svg } from '../../shared/dom.js';
import { lastAuditLabel, plural, relativeTime } from '../../shared/format.js';
import { noteCopy, noteSummary } from '../../shared/notes.js';
import type { AuditAge } from '../../shared/tokens.js';
import { fitLabel, layoutLots, lotSide, type LotPlacement, type MapLayout } from './layout.js';

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
  /** Highlights the lot of `repoId` (hover on its list row); null clears. A focused lot keeps the highlight. */
  setHot(repoId: number | null): void;
  /** The highlighted repo: the keyboard-focused lot when there is one, else the hovered lot or row. */
  readonly current: number | null;
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
  for (const note of repo.notes) parts.push(`note: ${noteSummary(note, repo.path)}`);
  return parts.join(', ');
}

export function createFleetMap(): FleetMap {
  const lots = svg('g', { class: 'lots' });
  const canvas = svg(
    'svg',
    { class: 'fleet-svg', 'aria-label': 'Repo map', role: 'group', 'data-testid': 'fleet-map' },
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
  const ground = svg('svg', { class: 'fleet-ground', 'aria-hidden': 'true', focusable: 'false' });
  const element = h('figure', { class: 'fleet-map' }, ground, canvas, tip, legend);

  let repos: readonly RepoSummary[] = [];
  let now = Date.now();
  let layout: MapLayout = { lots: [], height: 0 };
  let width = 0;
  let hot: number | null = null;
  /** The lot holding keyboard focus; it wins over any pointer hover. */
  let focused: number | null = null;
  const current = (): number | null => focused ?? hot;
  /** The repo whose hover card is shown (pointer or focus on its lot); list hover shows none. */
  let tipFor: number | null = null;
  const hotListeners = new Set<(repoId: number | null) => void>();

  /**
   * The hover card, anchored to the lot it describes (pointer or keyboard):
   * centred above the lot, else below its labels, else beside it, always
   * inside the map and never over the lot or its labels.
   */
  function showTip(repo: RepoSummary | undefined): void {
    const place = repo ? layout.lots.find((lot) => lot.id === repo.id) : undefined;
    if (!repo || !place) {
      tipFor = null;
      tip.classList.remove('show');
      delete tip.dataset['placement'];
      return;
    }
    tipFor = repo.id;
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
      h('div', { class: 'pins' }, repo.lastEventAt === null ? 'no events yet' : `last event ${relativeTime(repo.lastEventAt, now)}`),
      ...repo.notes.map((note) => h('div', { class: 'note', 'data-testid': 'tip-note' }, noteCopy(note, repo.path).text)),
    );
    const { left, top, placement } = tipPosition(place, tip.offsetWidth, tip.offsetHeight, width, layout.height);
    tip.style.left = `${String(left)}px`;
    tip.style.top = `${String(top)}px`;
    tip.dataset['placement'] = placement;
    tip.classList.add('show');
  }

  function paintHot(): void {
    for (const lot of lots.children) {
      if (lot instanceof SVGElement) lot.classList.toggle('hot', Number(lot.dataset['repoId']) === current());
    }
  }

  function emitHot(repoId: number | null): void {
    hot = repoId;
    paintHot();
    const shown = current();
    showTip(repos.find((repo) => repo.id === shown));
    for (const listener of hotListeners) listener(shown);
  }

  function createLot(repo: RepoSummary): SVGElement {
    const lot = svg('a', { class: 'lot', 'data-testid': 'lot', 'data-repo-id': String(repo.id) });
    lot.addEventListener('mouseenter', () => {
      emitHot(repo.id);
    });
    lot.addEventListener('mouseleave', () => {
      emitHot(null);
    });
    lot.addEventListener('focus', () => {
      focused = Number(lot.dataset['repoId']);
      emitHot(focused);
    });
    lot.addEventListener('blur', () => {
      focused = null;
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
    lot.classList.toggle('hot', repo.id === current());
    lot.style.transform = `translate(${String(place.x)}px, ${String(place.y)}px)`;

    // Rebuild the drawing only when it changes: a live refetch that brings
    // the same data keeps the nodes (and any pointer or focus on them).
    const signature = JSON.stringify([repo, place.side, place.label]);
    if (lot.dataset['signature'] === signature) return;
    lot.dataset['signature'] = signature;

    const radius = String(Math.min(12, Math.round(side / 7)));
    const countSize = Math.round(Math.min(34, Math.max(15, side * 0.27)));
    const centre = String(side / 2);
    const clipId = `fleet-clip-${String(repo.id)}`;
    const children: SVGElement[] = [
      svg('clipPath', { id: clipId }, svg('rect', { width: String(side), height: String(side), rx: radius })),
      // A soft shadow from three stacked, growing rects: a `filter: blur` here
      // costs seconds of CPU raster on software-rendered browsers (DC-86).
      svg(
        'g',
        { class: 'shadow' },
        ...[5, 2.5, 0].map((grow) =>
          svg('rect', {
            x: String(2 - grow),
            y: String(DEPTH + 2 - grow),
            width: String(side - 4 + grow * 2),
            height: String(side - 2 + grow * 2),
            rx: String(Number(radius) + grow),
          }),
        ),
      ),
      svg('rect', { class: `side audit-${age}`, y: String(DEPTH), width: String(side), height: String(side), rx: radius }),
      svg(
        'g',
        { class: 'face' },
        svg(
          'g',
          { class: `slab audit-${age}`, 'clip-path': `url(#${clipId})` },
          ...faceBands(side),
          svg('path', { class: 'texture', d: textureLines(side) }),
        ),
        // The face's outline: it draws nothing, and gives the lot's top face a box to measure.
        svg('rect', { class: 'top', width: String(side), height: String(side), rx: radius, fill: 'none' }),
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
      svg('text', { class: 'name', x: centre, y: String(side + DEPTH + 20) }, fitLabel(repo.name, place.label / MONO_CHAR)),
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
    // A live update may change the described repo or move its lot.
    if (tipFor !== null) showTip(repos.find((repo) => repo.id === tipFor));
  }

  let groundSize = '';
  /** Draws the ground grid for the map's current box; a no-op while the box is unchanged. */
  function paintGround(): void {
    const w = Math.round(element.clientWidth);
    const hgt = Math.round(element.clientHeight);
    const stage = element.closest('.stage') ?? element;
    const key = `${String(w)}x${String(hgt)} ${String(stage.clientWidth)}x${String(stage.clientHeight)}`;
    if (w <= 0 || hgt <= 0 || groundSize === key) return;
    groundSize = key;
    ground.setAttribute('viewBox', `0 0 ${String(w)} ${String(hgt)}`);
    ground.replaceChildren(...groundGlow(stage.clientWidth, stage.clientHeight), ...groundGrid(w, hgt));
  }

  const observer = new ResizeObserver(() => {
    const next = Math.round(element.clientWidth);
    if (next !== width && next > 0) {
      width = next;
      relayout();
    }
    paintGround();
  });
  observer.observe(element);

  return {
    element,
    render(next, at) {
      repos = next;
      now = at;
      if (hot !== null && !repos.some((repo) => repo.id === hot)) hot = null;
      if (focused !== null && !repos.some((repo) => repo.id === focused)) focused = null;
      width = Math.round(element.clientWidth) || width || 960;
      relayout();
      paintGround();
    },
    setHot(repoId) {
      hot = repoId;
      paintHot();
    },
    get current() {
      return current();
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

/** Space between the hover card and what it must not cover, and the map edge it stays inside. */
const TIP_GAP = 10;
const TIP_EDGE = 8;
/** How far the labels reach below the lot's side face (two lines of text). */
const LABELS_BELOW = 44;

export type TipPlacement = 'above' | 'below' | 'right' | 'left';

/**
 * Where the hover card goes for a lot: the first of above, below the labels,
 * right and left that fits inside the map without covering the lot (lifted
 * face and focus ring included) or its labels. When nothing fits (a tiny
 * map), it goes below the labels, outside the map.
 */
export function tipPosition(
  place: LotPlacement,
  tipWidth: number,
  tipHeight: number,
  mapWidth: number,
  mapHeight: number,
): { left: number; top: number; placement: TipPlacement } {
  const centre = place.x + place.side / 2;
  const keepOut = {
    left: Math.min(place.x - 4, centre - place.label / 2),
    right: Math.max(place.x + place.side + 4, centre + place.label / 2),
    top: place.y - 8,
    bottom: place.y + place.side + DEPTH + LABELS_BELOW,
  };
  const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high));
  const across = clamp(centre - tipWidth / 2, TIP_EDGE, mapWidth - tipWidth - TIP_EDGE);
  const down = clamp(place.y, TIP_EDGE, mapHeight - tipHeight - TIP_EDGE);

  const above = keepOut.top - TIP_GAP - tipHeight;
  if (above >= TIP_EDGE) return { left: across, top: above, placement: 'above' };
  const below = keepOut.bottom + TIP_GAP;
  if (below + tipHeight <= mapHeight - TIP_EDGE) return { left: across, top: below, placement: 'below' };
  const right = keepOut.right + TIP_GAP;
  if (right + tipWidth <= mapWidth - TIP_EDGE) return { left: right, top: down, placement: 'right' };
  const left = keepOut.left - TIP_GAP - tipWidth;
  if (left >= TIP_EDGE) return { left, top: down, placement: 'left' };
  return { left: across, top: below, placement: 'below' };
}

function subLabel(repo: RepoSummary): string {
  if (repo.error !== null) return 'collection error';
  if (repo.collecting) return 'collecting…';
  if (!repo.active) return 'inactive';
  return repo.highFindings > 0 ? plural(repo.highFindings, 'high finding') : `${String(repo.unreviewed)} to review`;
}

/** The collecting, error or note pip in the lot's top-right corner; the first that applies. */
function statusPip(repo: RepoSummary, side: number): SVGElement[] {
  const cx = String(side - 12);
  if (repo.error !== null) {
    return [svg('g', { class: 'pip pip-error' }, svg('circle', { cx, cy: '12', r: '7' }), svg('text', { x: cx, y: '15.5' }, '!'))];
  }
  if (repo.collecting) {
    return [svg('g', { class: 'pip pip-collecting' }, svg('circle', { class: 'pulse', cx, cy: '12', r: '4' }), svg('circle', { cx, cy: '12', r: '4' }))];
  }
  if (repo.notes.length > 0) {
    return [svg('g', { class: 'pip pip-note', 'data-testid': 'lot-note' }, svg('circle', { cx, cy: '12', r: '7' }), svg('text', { x: cx, y: '15.5' }, 'i'))];
  }
  return [];
}


/** Horizontal strips a lot's face is built from: a vertical ramp from the high to the low face colour. */
const FACE_BANDS = 8;

/** The lot's face: stacked solid strips (see `.face-band` in fleet.css), clipped to the lot's rounded square. */
function faceBands(side: number): SVGElement[] {
  const step = side / FACE_BANDS;
  return Array.from({ length: FACE_BANDS }, (_, i) =>
    // One px of overlap hides the seam between neighbours.
    svg('rect', { class: `face-band b${String(i)}`, y: String(Math.floor(i * step)), width: String(side), height: String(Math.ceil(step) + 1) }),
  );
}

/** The faint 12px plot grid on a lot's face, as one path of lines. */
function textureLines(side: number): string {
  const lines: string[] = [];
  for (let at = 12; at < side; at += 12) lines.push(`M${String(at)} 0V${String(side)}M0 ${String(at)}H${String(side)}`);
  return lines.join('');
}

/** Grid cell of the ground, in px. */
const GROUND_CELL = 28;
/** Opacity of the grid lines at the centre of the map. */
const GROUND_ALPHA = 0.7;
/** Steps the grid's fade toward the edges is drawn in. */
const GROUND_STEPS = 7;
/** Where the fade begins and ends, as a fraction of the ellipse radius (the mockup's 35% and 100%). */
const FADE_FROM = 0.35;

/**
 * The ground grid with its edge fade: a vertical and a horizontal line every
 * 28px, each cut into pieces by the rings of a centred ellipse (70% x 75% of
 * the box, at 50% 52%) with one opacity per ring. Drawn as thin solid strokes
 * instead of two full-box gradients under a radial mask: that costs seconds of
 * first-paint raster on software-rendered browsers (DC-86).
 */
function groundGrid(width: number, height: number): SVGElement[] {
  const cx = width / 2;
  const cy = height * 0.52;
  const rx = width * 0.7;
  const ry = height * 0.75;
  const rings = Array.from({ length: GROUND_STEPS + 1 }, (_, i) => FADE_FROM + ((1 - FADE_FROM) * i) / GROUND_STEPS);
  // Ring 0 is the opaque core (r < FADE_FROM); ring k covers rings[k-1] <= r < rings[k].
  const paths: string[] = rings.map(() => '');
  const alpha = (k: number): number => {
    if (k === 0) return 1;
    const mid = ((rings[k - 1] ?? FADE_FROM) + (rings[k] ?? 1)) / 2;
    return Math.max(0, 1 - (mid - FADE_FROM) / (1 - FADE_FROM));
  };
  /** Adds the pieces of one line, at offset `u` radii from the centre across it, to the ring each falls in. */
  const cut = (line: number, centre: number, along: number, u: number, vertical: boolean): void => {
    if (Math.abs(u) >= 1) return;
    const half = (t: number): number => (t > Math.abs(u) ? along * Math.sqrt(t * t - u * u) : 0);
    const at = (a: number, b: number): string => (vertical ? `M${String(line)} ${a.toFixed(1)}V${b.toFixed(1)}` : `M${a.toFixed(1)} ${String(line)}H${b.toFixed(1)}`);
    const cuts = rings.map(half);
    for (let k = 0; k < cuts.length; k++) {
      const inner = k === 0 ? 0 : (cuts[k - 1] ?? 0);
      const outer = cuts[k] ?? 0;
      if (outer - inner < 0.5) continue;
      paths[k] = (paths[k] ?? '') + at(centre - outer, centre - inner) + at(centre + inner, centre + outer);
    }
  };
  // Vertical lines: tiles are centred on the box, one line at the left of each; horizontal: from the top.
  const first = ((width - GROUND_CELL) / 2) % GROUND_CELL;
  for (let x = first; x < width; x += GROUND_CELL) cut(x + 0.5, cy, ry, (x + 0.5 - cx) / rx, true);
  for (let y = 0; y < height; y += GROUND_CELL) cut(y + 0.5, cx, rx, (y + 0.5 - cy) / ry, false);
  return paths.flatMap((d, k) => (d === '' ? [] : [svg('path', { d, 'stroke-opacity': (GROUND_ALPHA * alpha(k)).toFixed(3) })]));
}

/** Steps the stage glow is drawn in. */
const GLOW_STEPS = 16;

/**
 * The stage's soft glow (components.css `.stage`: a 1200x600 radial gradient
 * of --panel-2 at 60%, gone at 70% of its radius, centred at 40% 30%), as
 * nested ellipses with just enough opacity each to add up to the gradient's
 * ramp. The steps are about one 8-bit colour level apart, so the eye sees a
 * gradient; the paint is solid fills, which software raster draws cheaply.
 */
function groundGlow(stageWidth: number, stageHeight: number): SVGElement[] {
  if (stageWidth <= 0 || stageHeight <= 0) return [];
  const cx = stageWidth * 0.4;
  const cy = stageHeight * 0.3;
  const reach = 0.7;
  const peak = 0.6;
  const ellipses: SVGElement[] = [];
  let below = 0;
  for (let i = 0; i < GLOW_STEPS; i++) {
    // From the outside in: ring i spans radius (1 - i / steps) .. (1 - (i + 1) / steps) of the reach.
    const outer = 1 - i / GLOW_STEPS;
    const middle = 1 - (i + 0.5) / GLOW_STEPS;
    const wanted = peak * (1 - middle * reach / reach);
    const own = 1 - (1 - wanted) / (1 - below);
    below = wanted;
    ellipses.push(svg('ellipse', { class: 'glow', cx: String(cx), cy: String(cy), rx: (1200 * reach * outer).toFixed(1), ry: (600 * reach * outer).toFixed(1), 'fill-opacity': own.toFixed(4) }));
  }
  return ellipses;
}
