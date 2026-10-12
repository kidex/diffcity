// The HUD around the city (ADR-026): top bar, title, filter rows, hint,
// legend, tooltip, selection card, Fleet card and toast. Plain DOM; it holds
// no state of its own beyond what is on screen: the filters live in
// index.ts, the paint rules in model/view.ts.

import type { Report } from '../../../../core/report/types.js';
import './review.css';
import { h } from '../../../shared/dom.js';
import type { CardData, TipData } from '../model/hud.js';
import { ruleChips } from '../model/hud.js';
import type { ProgressView } from '../model/review.js';
import type { Filters } from '../model/view.js';
import type { FleetPort } from '../ports.js';
import { createSelectionCard } from './card.js';
import { createFilterRows } from './filters.js';
import { createFleetCard } from './fleet.js';
import { createLegend } from './legend.js';
import { createTooltip } from './tooltip.js';
import { renderProgress } from './progress.js';
import type { BarExtras } from './topbar.js';
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
  /** The screen has a ReviewPort: the summary button is drawn and `onSummary` opens the dialog. */
  review?: { onSummary(trigger: HTMLElement): void } | undefined;
  /** The screen has an ApprovalPort: Approve's element, drawn among the bar's actions. */
  approve?: HTMLElement | undefined;
  /** The screen has an AgentPort: the agent run status, drawn in the bar. */
  agent?: HTMLElement | undefined;
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
  /** Where the selection card keeps its mark buttons. */
  cardReviewSlot: HTMLElement;
  /** The review progress for the bar, or null while there is no review state (nothing is drawn, "Hide checked" goes). */
  progress(view: ProgressView | null): void;
  /** The toast's element, for a screen that has no overlay to put it in. */
  toastRoot: HTMLElement;
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
  const progress = h('div', { class: 'rv-progress', 'data-testid': 'progress' });
  const summaryButton = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      'aria-haspopup': 'dialog',
      'data-testid': 'review-summary',
      onclick: (event: Event) => {
        if (event.currentTarget instanceof HTMLElement) options.review?.onSummary(event.currentTarget);
      },
    },
    'Review summary',
  );
  let reviewReady = false;
  let shown: { report: Report; filters: Filters } | null = null;
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

  /** Only with a review state: before it, and without a port, the bar has none of these nodes. */
  const extras = (): BarExtras => ({
    ...(options.review !== undefined && reviewReady ? { progress, summary: summaryButton } : {}),
    approve: options.approve,
    agent: options.agent,
  });

  return {
    bar,
    overlay,
    update(report, current) {
      shown = { report, filters: current };
      renderTopBar(bar, report, crumb, extras());
      filters.update(report, current, reviewReady);
      legend.update(ruleChips(report).length > 0);
    },
    cardReviewSlot: selection.reviewSlot,
    toastRoot: toast,
    progress(view) {
      if (view !== null) renderProgress(progress, view);
      if (reviewReady === (view !== null)) return;
      reviewReady = view !== null;
      if (shown === null) return;
      renderTopBar(bar, shown.report, crumb, extras());
      filters.update(shown.report, shown.filters, reviewReady);
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
