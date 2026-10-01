// The page chrome around the city, shared by the three directions: top bar,
// title, verdict and type filters, legend, hint, hover tooltip and the
// selection card. Same information and wording as design/mockup.html; each
// direction restyles it in its own style.css. Colours are CSS variables only.

import type { City, CityBuilding, CityFloor, Status, Verdict } from './city.js';
import { CHANGE_STATUSES, STATUS_LABEL, VERDICTS, VERDICT_LABEL } from './city.js';
import { h } from './labels.js';
import { severityToken, statusToken, verdictToken } from './tokens.js';

export interface DirectionMeta {
  id: 'a' | 'b' | 'c';
  name: string;
  tagline: string;
}

export interface Filters {
  verdict: Verdict | null;
  type: Exclude<Status, 'same'> | null;
}

export interface Hud {
  city: HTMLElement;
  canvas: HTMLCanvasElement;
  showTip(building: CityBuilding, floor: CityFloor | undefined, clientX: number, clientY: number): void;
  hideTip(): void;
  showSelection(building: CityBuilding | null): void;
  onFilters(listener: (filters: Filters) => void): void;
}

const DIRECTIONS: readonly Omit<DirectionMeta, 'tagline'>[] = [
  { id: 'a', name: 'Glass & light' },
  { id: 'b', name: 'Architectural model' },
  { id: 'c', name: 'Night data city' },
];

function swatch(className: string, token: string): HTMLElement {
  const el = h('i', className);
  el.style.setProperty('--c', `var(${token})`);
  return el;
}

function brandMark(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'mark');
  svg.setAttribute('aria-hidden', 'true');
  const paths: [string, boolean][] = [
    ['M12 2 21 7v10l-9 5-9-5V7l9-5Z', false],
    ['M12 12 21 7M12 12v10M12 12 3 7', false],
    ['M12 12v5l4.5-2.5V9.5', true],
  ];
  for (const [d, filled] of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', filled ? 'mark-fill' : 'mark-line');
    svg.append(path);
  }
  return svg;
}

function topBar(city: City, current: DirectionMeta): HTMLElement {
  const { meta, summary } = city.report;
  const stat = (value: number, label: string, token?: string): HTMLElement =>
    h('div', 'stat', ...(token === undefined ? [] : [swatch('sw', token)]), h('b', '', String(value)), h('small', '', label));
  const nav = h('nav', 'switch');
  nav.setAttribute('aria-label', 'Visual directions');
  for (const direction of DIRECTIONS) {
    const link = h('a', direction.id === current.id ? 'on' : '', h('span', 'key', direction.id.toUpperCase()), h('span', 'name', direction.name));
    link.setAttribute('href', `../${direction.id}/`);
    if (direction.id === current.id) link.setAttribute('aria-current', 'page');
    nav.append(link);
  }
  const eyes = summary.byVerdict.eyes;
  return h(
    'header',
    'top',
    h('div', 'brand', brandMark(), 'diffcity'),
    h(
      'div',
      'crumb',
      h('strong', '', meta.repo),
      h('span', 'branch', meta.head),
      h('span', 'vs', 'against'),
      h('span', 'branch', meta.base),
      h('span', 'vs', `${String(meta.commits)} commits`),
    ),
    h(
      'div',
      'stats',
      stat(summary.files, 'files'),
      stat(summary.byStatus.add, 'added', '--add'),
      stat(summary.byStatus.mod, 'modified', '--mod'),
      stat(summary.byStatus.sig, 'signature', '--sig'),
      stat(summary.byStatus.del, 'removed', '--del'),
    ),
    h('div', 'tier', h('span', 'dot'), `${String(eyes)} file${eyes === 1 ? '' : 's'} need your eyes before merge`),
    nav,
  );
}

function legend(): HTMLElement {
  const item = (className: string, token: string, text: string): HTMLElement => h('span', '', swatch(className, token), text);
  return h(
    'div',
    'legend',
    h(
      'span',
      'g',
      item('v', '--verdict-eyes', 'needs your eyes'),
      item('v', '--verdict-risky', 'risky'),
      item('v', '--verdict-spec', 'outside the spec'),
      item('v', '--verdict-ok', 'reviewed, fine'),
    ),
    item('', '--add', 'added'),
    item('', '--mod', 'modified'),
    item('', '--sig', 'signature'),
    item('del', '--del', 'removed'),
    item('', '--same-top', 'untouched'),
    item('tier', '--tier', 'tier 1'),
  );
}

export function createHud(root: HTMLElement, city: City, current: DirectionMeta): Hud {
  const canvas = document.createElement('canvas');
  canvas.className = 'scene';
  canvas.setAttribute('aria-label', 'The change as a 3D city');
  const tip = h('div', 'tip');
  tip.setAttribute('role', 'tooltip');
  const card = h('aside', 'card');
  card.setAttribute('aria-live', 'polite');

  const counts = new Map<Verdict, number>();
  for (const building of city.buildings) counts.set(building.verdict, (counts.get(building.verdict) ?? 0) + 1);
  const floorCounts = new Map<Status, number>();
  for (const building of city.buildings) for (const floor of building.floors) floorCounts.set(floor.status, (floorCounts.get(floor.status) ?? 0) + 1);

  const verdictRow = h('div', 'chips verdicts');
  verdictRow.setAttribute('role', 'group');
  verdictRow.setAttribute('aria-label', 'Filter by verdict');
  for (const verdict of VERDICTS) {
    const button = h('button', '', swatch('', verdictToken(verdict)), VERDICT_LABEL[verdict], h('b', '', String(counts.get(verdict) ?? 0)));
    button.dataset['v'] = verdict;
    verdictRow.append(button);
  }
  const typeRow = h('div', 'chips types');
  typeRow.setAttribute('role', 'group');
  typeRow.setAttribute('aria-label', 'Filter by change type');
  for (const status of CHANGE_STATUSES) {
    const button = h('button', '', swatch('', statusToken(status)), STATUS_LABEL[status], h('b', '', String(floorCounts.get(status) ?? 0)));
    button.dataset['t'] = status;
    typeRow.append(button);
  }
  const clear = h('button', 'clear', 'Show everything');
  clear.dataset['t'] = '';
  typeRow.append(clear);

  const cityEl = h(
    'section',
    'city',
    canvas,
    h(
      'div',
      'title',
      h('h1', '', 'What the agent built'),
      h('p', '', `Direction ${current.id.toUpperCase()}: ${current.name}. ${current.tagline}`),
    ),
    verdictRow,
    typeRow,
    h(
      'div',
      'hint',
      'Drag to orbit, scroll to zoom',
      h('br', ''),
      h('span', 'k', 'R'),
      ' reset view ',
      h('span', 'k', 'J'),
      h('span', 'k', 'K'),
      ' stops',
    ),
    legend(),
    card,
    tip,
  );
  cityEl.setAttribute('aria-label', 'Change map');
  if (city.sampleOverlay) {
    cityEl.append(h('div', 'note', 'Reading path and finding pins: sample overlay (this Report has none yet)'));
  }
  root.append(topBar(city, current), cityEl);

  const filters: Filters = { verdict: null, type: null };
  const listeners: ((filters: Filters) => void)[] = [];
  const sync = (): void => {
    for (const button of verdictRow.querySelectorAll<HTMLButtonElement>('button')) button.classList.toggle('on', button.dataset['v'] === filters.verdict);
    for (const button of typeRow.querySelectorAll<HTMLButtonElement>('button')) button.classList.toggle('on', button.dataset['t'] !== '' && button.dataset['t'] === filters.type);
    for (const listener of listeners) listener({ ...filters });
  };
  verdictRow.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (button === null) return;
    const verdict = button.dataset['v'] as Verdict;
    filters.verdict = filters.verdict === verdict ? null : verdict;
    sync();
  });
  typeRow.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (button === null) return;
    const type = button.dataset['t'] ?? '';
    if (type === '') {
      filters.type = null;
      filters.verdict = null;
    } else {
      const status = type as Exclude<Status, 'same'>;
      filters.type = filters.type === status ? null : status;
    }
    sync();
  });

  const counter = (building: CityBuilding): HTMLElement =>
    h(
      'div',
      'row',
      h('span', 'add', h('b', '', `+${String(building.counts.add)}`), ' added'),
      h('span', 'mod', h('b', '', String(building.counts.mod)), ' modified'),
      h('span', 'sig', h('b', '', String(building.counts.sig)), ' sig'),
      h('span', 'del', h('b', '', String(building.counts.del)), ' removed'),
    );
  const verdictLine = (building: CityBuilding): HTMLElement => {
    const el = h('div', 'v', h('i', ''), VERDICT_LABEL[building.verdict]);
    el.style.setProperty('--c', `var(${verdictToken(building.verdict)})`);
    return el;
  };

  return {
    city: cityEl,
    canvas,
    showTip(building, floor, clientX, clientY) {
      const findings = building.findings.length;
      tip.replaceChildren(
        verdictLine(building),
        h('div', 'f', building.name),
        h('div', 'p', building.pkg.path),
        counter(building),
        h(
          'div',
          'pins',
          floor === undefined ? '' : `floor: ${floor.symbol.name}`,
          findings === 0 ? '' : h('span', 'n', `${String(findings)} finding${findings === 1 ? '' : 's'}`),
        ),
      );
      const rect = cityEl.getBoundingClientRect();
      const width = tip.offsetWidth || 250;
      const height = tip.offsetHeight || 120;
      tip.style.left = `${String(Math.min(clientX - rect.left + 14, rect.width - width - 8))}px`;
      tip.style.top = `${String(Math.min(clientY - rect.top + 14, rect.height - height - 8))}px`;
      tip.classList.add('show');
    },
    hideTip() {
      tip.classList.remove('show');
    },
    showSelection(building) {
      if (building === null) {
        card.classList.remove('show');
        card.replaceChildren();
        return;
      }
      const floors = h('ol', 'floors');
      for (const floor of [...building.floors].reverse()) {
        const li = h('li', `s-${floor.status}`, swatch('', statusToken(floor.status)), h('span', 'sym', floor.symbol.name), h('span', 'st', floor.status === 'same' ? '' : STATUS_LABEL[floor.status]));
        floors.append(li);
      }
      const findings = h('ul', 'findings');
      for (const finding of building.findings) {
        findings.append(h('li', '', swatch('sev', severityToken(finding.severity)), h('span', '', finding.title), h('span', 'src', finding.source)));
      }
      const stops = building.stops.length === 0 ? '' : `stop ${building.stops.join(', ')} of ${String(city.path.length)}`;
      card.replaceChildren(
        h('div', 'head', verdictLine(building), building.tier1 ? h('span', 'tag tier', 'tier 1') : '', h('span', 'stops', stops)),
        h('div', 'f', building.file.path),
        counter(building),
        floors,
        building.findings.length === 0 ? '' : findings,
      );
      card.classList.add('show');
    },
    onFilters(listener) {
      listeners.push(listener);
    },
  };
}
