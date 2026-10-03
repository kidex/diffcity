// The file view (SPEC.md section 6, "Click building"; ADR-027): what the right
// panel shows once a building or a stop is clicked. Header (file, package,
// verdict, counts by status), the file's stops, and the diff area. In this
// task the diff area holds the Report's `Step.diff` excerpts; with a DiffPort
// it also holds the mount point the full diff renders into, and without one
// it says the full diff is in the app. Plain DOM and textContent only.

import { h } from '../../../shared/dom.js';
import type { FileViewData, Target } from '../model/panel.js';
import { DIFF_IN_APP } from '../model/panel.js';
import { countLine } from '../model/hud.js';
import type { TabActions } from './lists.js';
import { activatable, bindHover } from './lists.js';
import type { StopCard } from './stops.js';
import { codeBlock, pin, stopCard, stopStatus, verdictTag } from './stops.js';

export interface FileViewOptions {
  actions: TabActions;
  /** "Back": returns to the tabs. */
  back(): void;
  /** A DiffPort was given: the full diff will render into the mount point. */
  hasDiffPort: boolean;
}

export interface FileViewRender {
  /** The part that scrolls. */
  scroll: HTMLElement;
  stops: StopCard[];
  /** The excerpt of each stop, by the stop's symbol id. */
  excerpts: { root: HTMLElement; symbolId: string }[];
  /** The diff area; `data-focus-symbol` names the symbol the diff should open at. */
  area: HTMLElement;
}

/** The class name of the full diff's mount point, for the task that renders into it. */
export const DIFF_MOUNT = 'diff-mount';

export function renderFileView(root: HTMLElement, data: FileViewData, options: FileViewOptions): FileViewRender {
  const { actions } = options;
  const { file } = data.placed;
  const back = h(
    'button',
    { type: 'button', class: 'fv-back', 'data-testid': 'file-view-back', onclick: () => {
        options.back();
      },
    },
    h('span', { 'aria-hidden': 'true' }, '←'),
    'Back',
  );
  const counts = h(
    'div',
    { class: 'row', 'data-testid': 'file-view-counts' },
    countLine(data.counts).map(({ status, count, text }) => h('span', { class: status }, h('b', null, status === 'add' ? `+${String(count)}` : String(count)), ` ${text}`)),
  );
  const head = h(
    'div',
    { class: 'fv-head', 'data-testid': 'file-view-head' },
    back,
    h('h2', { class: 'fv-file', 'data-testid': 'file-view-file' }, file.path),
    h(
      'div',
      { class: 'fv-meta' },
      h('span', { class: 'fv-pkg', 'data-testid': 'file-view-package' }, data.placed.pkg),
      verdictTag(file.verdict, 'file-view-verdict'),
      data.placed.tier1 ? h('span', { class: 'tag tier', 'data-testid': 'file-view-tier' }, 'tier 1') : null,
      counts,
    ),
  );

  const cards = data.stops.map((stop) => {
    const card = stopCard(stop, { compact: true });
    const target: Target = { fileId: stop.step.fileId, symbolId: stop.step.symbolId };
    // In the file view a click on a stop focuses its symbol: the file is already open.
    activatable(card.root, target, {
      ...actions,
      open: (next) => {
        actions.select(next);
      },
    });
    return card;
  });
  const stopsSection = h(
    'section',
    { class: 'fv-section', 'data-testid': 'file-view-stops' },
    h('h3', null, 'Stops in this file'),
    cards.length === 0 ? h('p', { class: 'panel-empty', 'data-testid': 'file-view-no-stops' }, 'No stop of the reading path is in this file') : cards.map((card) => card.root),
  );

  const excerpts = data.stops
    .filter((stop) => stop.step.diff.length > 0)
    .map((stop) => {
      const name = stop.symbol?.name ?? stop.step.symbolId;
      const root = h(
        'section',
        { class: `fv-excerpt ${stopStatus(stop)}`, 'data-testid': 'diff-excerpt', 'data-symbol': stop.step.symbolId },
        h('h4', null, name),
        codeBlock(stop.step.diff, `Changes in ${name}`),
      );
      return { root, symbolId: stop.step.symbolId };
    });
  const area = h(
    'section',
    { class: 'fv-section fv-diff', 'data-testid': 'file-diff', 'data-file': file.id },
    h('h3', null, 'Diff'),
    excerpts.map((excerpt) => excerpt.root),
    // The full diff of the file renders here when a DiffPort is given.
    options.hasDiffPort ? h('div', { class: DIFF_MOUNT, 'data-testid': 'diff-mount', 'data-file': file.id }) : h('p', { class: 'fv-note', 'data-testid': 'diff-in-app' }, DIFF_IN_APP),
  );

  const loose =
    data.loose.length === 0
      ? null
      : h('section', { class: 'fv-section', 'data-testid': 'file-view-findings' }, h('h3', null, 'Findings in this file'), data.loose.map(pin));

  const scroll = h('div', { class: 'scroll fv-scroll', 'data-testid': 'file-view-scroll' }, stopsSection, loose, area);
  root.replaceChildren(head, scroll);
  bindHover(scroll, actions);
  return { scroll, stops: cards, excerpts, area };
}
