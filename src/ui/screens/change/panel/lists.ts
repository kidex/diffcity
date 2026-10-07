// The bodies of the four tabs (SPEC.md section 6, right panel): the stop
// cards under their section headings, the findings by file, the files outside the spec and the touched
// symbols. Plain DOM and textContent only.

import type { Report, Status } from '../../../../core/report/types.js';
import { h } from '../../../shared/dom.js';
import { STATUS_LABEL } from '../../../shared/format.js';
import type { FindingGroup, PlacedFile, StopSection, SymbolGroup, Target } from '../model/panel.js';
import {
  EMPTY_FINDINGS,
  EMPTY_OUTSIDE_ALL_IN,
  EMPTY_OUTSIDE_NO_SPEC,
  EMPTY_SYMBOLS,
  emptyStepsText,
  findingGroups,
  outsideSpec,
  stopSections,
  touchedSymbols,
} from '../model/panel.js';
import type { StopCard } from './stops.js';
import { pin, stopCard, verdictTag } from './stops.js';

/** What a tab does with a click: select a floor, or select a file and open its file view. */
export interface TabActions {
  select(target: Target): void;
  open(target: Target): void;
  hover(fileId: string | null): void;
}

/** A body and the elements the panel marks as current when the selection moves. */
export interface TabBody {
  root: HTMLElement;
  stops: StopCard[];
  symbols: { root: HTMLElement; target: Target }[];
}

const empty = (testId: string, text: string): HTMLElement => h('p', { class: 'panel-empty', role: 'status', 'data-testid': testId }, text);

const swatchVar = (status: Status): string => (status === 'same' ? '--same-top' : `--${status}`);

/** The header of a group: the file, its package and verdict; a button that selects the file and opens its file view. */
function fileHead(placed: PlacedFile, actions: TabActions): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'group-head',
      'data-testid': 'group-file',
      'data-file': placed.file.id,
      title: `Open ${placed.file.path}`,
      onclick: () => {
        actions.open({ fileId: placed.file.id, symbolId: null });
      },
    },
    h('span', { class: 'path' }, placed.file.path),
    h('span', { class: 'pkg' }, placed.pkg),
    verdictTag(placed.file.verdict),
  );
}

const fileOf = (node: EventTarget | null): HTMLElement | null => (node instanceof Element ? node.closest<HTMLElement>('[data-file]') : null);

/** Hover or focus on a file's card, row or header lights its building; leaving puts it out. */
export function bindHover(root: HTMLElement, actions: TabActions): void {
  root.addEventListener('mouseover', (event) => {
    const el = fileOf(event.target);
    if (el !== null) actions.hover(el.dataset['file'] ?? null);
  });
  root.addEventListener('mouseout', (event) => {
    const el = fileOf(event.target);
    if (el === null) return;
    const to = fileOf(event.relatedTarget);
    // Moving between two parts of the same card keeps the building lit.
    if (to !== el) actions.hover(to?.dataset['file'] ?? null);
  });
  root.addEventListener('mouseleave', () => {
    actions.hover(null);
  });
  root.addEventListener('focusin', (event) => {
    const el = fileOf(event.target);
    if (el !== null && el.classList.contains('step')) actions.hover(el.dataset['file'] ?? null);
  });
  root.addEventListener('focusout', () => {
    actions.hover(null);
  });
}

/** Makes a card a button: a click or Enter selects it and opens its file view. */
export function activatable(card: HTMLElement, target: Target, actions: TabActions): void {
  card.addEventListener('click', (event) => {
    const inside = event.target instanceof Element ? event.target.closest('button, a') : null;
    if (inside === null) actions.open(target);
  });
  card.addEventListener('keydown', (event) => {
    if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    actions.open(target);
  });
}

/** A section of the reading path: its heading with the number of stops, what it holds, and its cards; the rail runs within the section. */
function stopSection(section: StopSection, actions: TabActions, cards: StopCard[]): HTMLElement {
  return h(
    'section',
    { class: `stop-section ${section.id}`, 'data-testid': 'stop-section', 'data-section': section.id },
    h(
      'h3',
      { class: 'section-head', 'data-testid': 'section-heading' },
      h('span', { 'data-testid': 'section-label' }, section.label),
      h('span', { class: 'cnt', 'data-testid': 'section-count' }, String(section.stops.length)),
    ),
    h('p', { class: 'section-note', 'data-testid': 'section-note' }, section.note),
    section.stops.map((stop) => {
      const card = stopCard(stop);
      activatable(card.root, { fileId: stop.step.fileId, symbolId: stop.step.symbolId }, actions);
      cards.push(card);
      return card.root;
    }),
  );
}

export function orderBody(report: Report, actions: TabActions): TabBody {
  const cards: StopCard[] = [];
  const emptyText = emptyStepsText(report);
  const root = h(
    'div',
    { class: 'tab-body', 'data-testid': 'tab-order-body' },
    emptyText !== null ? empty('empty-steps', emptyText) : stopSections(report).map((section) => stopSection(section, actions, cards)),
  );
  return { root, stops: cards, symbols: [] };
}

function findingGroup(group: FindingGroup, actions: TabActions): HTMLElement {
  const wholeChange = group.placed === null && group.path === '';
  return h(
    'section',
    { class: 'group', 'data-testid': 'finding-group', 'data-group': wholeChange ? 'change' : group.path },
    group.placed !== null
      ? fileHead(group.placed, actions)
      : h('div', { class: 'group-head plain', 'data-testid': 'group-change' }, h('span', { class: 'path' }, wholeChange ? 'Whole change' : group.path)),
    group.findings.map(pin),
  );
}

export function findingsBody(report: Report, actions: TabActions): TabBody {
  const groups = findingGroups(report);
  const root = h(
    'div',
    { class: 'tab-body', 'data-testid': 'tab-findings-body' },
    groups.length === 0 ? empty('empty-findings', EMPTY_FINDINGS) : groups.map((group) => findingGroup(group, actions)),
  );
  return { root, stops: [], symbols: [] };
}

export function outsideBody(report: Report, actions: TabActions): TabBody {
  const { files, specKnown } = outsideSpec(report);
  const root = h(
    'div',
    { class: 'tab-body', 'data-testid': 'tab-outside-body' },
    files.length === 0
      ? empty('empty-outside', specKnown ? EMPTY_OUTSIDE_ALL_IN : EMPTY_OUTSIDE_NO_SPEC)
      : h('ul', { class: 'plain-list' }, files.map((placed) => h('li', { 'data-testid': 'outside-file' }, fileHead(placed, actions)))),
  );
  return { root, stops: [], symbols: [] };
}

function symbolGroup(group: SymbolGroup, actions: TabActions, rows: TabBody['symbols']): HTMLElement {
  const list = h(
    'ul',
    { class: 'plain-list symbols', 'aria-label': `Symbols of ${group.placed.file.path}` },
    group.symbols.map((symbol) => {
      const swatch = h('i', { 'aria-hidden': 'true' });
      swatch.style.setProperty('--c', `var(${swatchVar(symbol.status)})`);
      const target = { fileId: group.placed.file.id, symbolId: symbol.id };
      const button = h(
        'button',
        {
          type: 'button',
          class: `sym-row s-${symbol.status}`,
          'data-testid': 'symbol-row',
          'data-file': group.placed.file.id,
          'data-symbol': symbol.id,
          onclick: () => {
            actions.select(target);
          },
        },
        swatch,
        h('span', { class: 'sym' }, symbol.name),
        h('span', { class: `tag ${symbol.status}` }, STATUS_LABEL[symbol.status]),
      );
      rows.push({ root: button, target });
      return h('li', null, button);
    }),
  );
  return h('section', { class: 'group', 'data-testid': 'symbol-group', 'data-group': group.placed.file.path }, fileHead(group.placed, actions), list);
}

export function symbolsBody(report: Report, actions: TabActions): TabBody {
  const groups = touchedSymbols(report);
  const symbols: TabBody['symbols'] = [];
  const root = h(
    'div',
    { class: 'tab-body', 'data-testid': 'tab-symbols-body' },
    groups.length === 0 ? empty('empty-symbols', EMPTY_SYMBOLS) : groups.map((group) => symbolGroup(group, actions, symbols)),
  );
  return { root, stops: [], symbols };
}
