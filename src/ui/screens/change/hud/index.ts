// The HUD around the city (ADR-026): top bar, title, filter rows, hint,
// legend, tooltip, selection card, Fleet card and toast. Plain DOM; it holds
// no state of its own beyond what is on screen: the filters live in
// index.ts, the paint rules in model/view.ts.

import type { Report } from '../../../../core/report/types.js';
import { h } from '../../../shared/dom.js';
import type { CardData, TipData } from '../model/hud.js';
import { ruleChips } from '../model/hud.js';
import type { Filters } from '../model/view.js';
import type { FleetPort } from '../ports.js';
import { createSelectionCard } from './card.js';
import { createFilterRows } from './filters.js';
import { createFleetCard } from './fleet.js';
import { createLegend } from './legend.js';
import { createTooltip } from './tooltip.js';
import { renderTopBar } from './topbar.js';

export const TITLE = 'What the agent built';
export const SUBTITLE =
  'Every block is a file, every floor a function. The label above each block is the review verdict. Filter by verdict or by kind of change.';
export const HINT = 'Drag to orbit, scroll to zoom';

/** How long a toast stays. */
const TOAST_MS = 6000;

export interface HudOptions {
  /** Also show the breadcrumb (repo, branch against base, commits and time): for a screen without the SPA shell. */
  crumb: boolean;
  fleet?: FleetPort | undefined;
  onFilters(filters: Filters): void;
}

export interface Hud {
  /** The top bar: above the city. */
  bar: HTMLElement;
  /** Everything over the city; append it inside the city element. */
  overlay: HTMLElement;
  update(report: Report, filters: Filters): void;
  /** Shows the tooltip at a point in the coordinates of the overlay, or hides it. */
  tip(data: TipData | null, x: number, y: number): void;
  /** The selection card; `focus` is the symbol id of the focused floor. */
  card(data: CardData | null, focus?: string | null): void;
  toast(text: string): void;
  dispose(): void;
}

export function createHud(options: HudOptions): Hud {
  const { crumb, fleet } = options;
  const bar = h('div', { class: 'hud-bar', role: 'group', 'aria-label': 'Change summary', 'data-testid': 'hud-bar' });
  const filters = createFilterRows((next) => {
    options.onFilters(next);
  });
  const legend = createLegend();
  const overlay = h('div', { class: 'hud', 'data-testid': 'hud' });
  const tooltip = createTooltip(overlay);
  const selection = createSelectionCard();
  const fleetCard = fleet === undefined ? null : createFleetCard(fleet);
  const toast = h('div', { class: 'toast', role: 'status', 'data-testid': 'toast' });
  toast.hidden = true;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  overlay.append(
    h('div', { class: 'hud-head' }, h('div', { class: 'hud-title' }, h('h1', null, TITLE), h('p', null, SUBTITLE)), filters.root),
    h('div', { class: 'hint', 'data-testid': 'hint' }, HINT, h('br'), h('span', { class: 'k' }, 'R'), ' reset view'),
    legend.root,
    h('div', { class: 'hud-corner' }, selection.root, fleetCard === null ? null : fleetCard.root),
    toast,
    tooltip.root,
  );

  return {
    bar,
    overlay,
    update(report, current) {
      renderTopBar(bar, report, crumb);
      filters.update(report, current);
      legend.update(ruleChips(report).length > 0);
    },
    tip(data, x, y) {
      if (data === null) tooltip.hide();
      else tooltip.show(data, x, y);
    },
    card(data, focus = null) {
      selection.show(data, focus);
    },
    toast(text) {
      toast.textContent = text;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.hidden = true;
      }, TOAST_MS);
    },
    dispose() {
      clearTimeout(toastTimer);
      fleetCard?.dispose();
      bar.remove();
      overlay.remove();
    },
  };
}
