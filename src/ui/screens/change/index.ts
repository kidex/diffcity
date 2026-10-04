// The change screen (SPEC.md section 6): the night data city of the Report
// (ADR-026). It renders from a Report alone and never imports src/ui/data
// (ADR-002, ADR-022): the SPA hands it each new Report, the HTML export a
// single one. Loaded with import() by the route, so Fleet and Repo never
// download three.js.
//
// States: no Report yet (computing), a Report without files, no WebGL (a
// message and the touched files grouped by package, with the reading panel at
// their right: a click opens the file view, so review works without the city),
// or the city, with the HUD around it (hud/): top bar, filters, legend,
// tooltip, selection card, Fleet card, and the reading panel at its right
// (panel/): tabs, stop cards and the file view.

import './change.css';

import type { Report } from '../../../core/report/types.js';
import { h, replaceChildren } from '../../shared/dom.js';
import { readToken } from '../../shared/tokens.js';
import type { FallbackView } from './fallback.js';
import { fallbackView } from './fallback.js';
import type { Hud } from './hud/index.js';
import { createHud } from './hud/index.js';
import { cardData, findingsIndex, tipData } from './model/hud.js';
import { marksOf, progressView, tipMark } from './model/review.js';
import type { Filters } from './model/view.js';
import { clearFilters, pruneFilters, ruleIndex, toggleHideChecked } from './model/view.js';
import type { Panel } from './panel/index.js';
import { createPanel } from './panel/index.js';
import type { DiffPort, FleetPort, ReviewPort } from './ports.js';
import type { ReviewController } from './review/controller.js';
import { createReviewController } from './review/controller.js';
import type { ReviewUi } from './review/ui.js';
import { createReviewUi } from './review/ui.js';
import type { CityView, EffectsState, SceneStats } from './scene/view.js';
import { createCityView, disposal } from './scene/view.js';

export const COMPUTING = 'Computing the first snapshot of this change…';
export const NO_FILES = 'No files in this change';

export interface ChangeScreenOptions {
  /** Null while the first snapshot is being computed. */
  report: Report | null;
  /** Show the breadcrumb (repo, branch against base, commits and time) in the top bar. The SPA shell has its own, so the route leaves it off. */
  crumb?: boolean;
  /** The audit card of the other repos; without it the card is hidden. */
  fleet?: FleetPort;
  /** The diff of a file (ADR-027); without it the file view shows only the Report's step diffs. */
  diffs?: DiffPort;
  /** The review marks (ADR-028): mark buttons, progress, "Hide checked" and the summary; without it the screen has none of them. */
  review?: ReviewPort;
}

export interface ChangeScreen {
  /** Shows a new Report of the same change; the camera and the selection stay. */
  update(report: Report | null): void;
  unmount(): void;
}

/** The `?scene-debug` hook for tests and benchmarks (window.diffcityScene). */
export interface SceneDebug {
  ready: boolean;
  /** Client point of a building's centre, or of one of its floors' when `symbolId` names it. */
  project(fileId: string, symbolId?: string): { x: number; y: number } | null;
  /** The symbol id of the focused floor of the selected building. */
  selectedFloor(): string | null;
  /** The symbol id of the floor the file view's diff is pointing at. */
  hoveredFloor(): string | null;
  stats(): SceneStats | null;
  bench(ms: number): Promise<{ fps: number; drawCalls: number } | null>;
  camera(): { theta: number; phi: number; r: number } | null;
  /** The camera of the first frame: far out when the intro runs, home when it is skipped. */
  firstCamera(): { theta: number; phi: number; r: number } | null;
  selected(): string | null;
  hovered(): string | null;
  /** What the filters dim: whole buildings by file id, and dimmed floor indices per file. */
  paint(): { dimmed: string[]; floors: Record<string, number[]> } | null;
  /** The buildings as drawn this frame (mid-tween included). */
  shown(): Record<string, { x: number; z: number; height: number }> | null;
  tweening(): boolean;
  /** Heights the newest tweened building had on each frame of the last tween. */
  tweenTrace(): { id: string; heights: number[] } | null;
  /** What the night effects drew: pulsing strips and their phases, halos, markers, the reading path, the tier 1 ring, and whether the loop runs on its own. */
  effects(): EffectsState | null;
  /** Views alive, and the renderer's geometries and textures just before the last view released its context. */
  disposal: typeof disposal;
}

declare global {
  interface Window {
    diffcityScene?: SceneDebug;
    /** Under `?scene-debug`, a FleetPort for tests: the SPA has no audit data to build one from yet. */
    diffcityFleet?: FleetPort;
    /** Under `?scene-debug`, set to true to mount the screen as the HTML export does: without a DiffPort. */
    diffcityNoDiffs?: boolean;
  }
}

function debugEnabled(): boolean {
  return /[?&]scene-debug(?:[=&]|$)/.test(location.search) || location.hash.includes('scene-debug');
}

function installDebug(view: () => CityView | null): SceneDebug {
  const hook: SceneDebug = {
    ready: false,
    project: (fileId, symbolId) => view()?.project(fileId, symbolId) ?? null,
    selectedFloor: () => view()?.selectedFloor() ?? null,
    hoveredFloor: () => view()?.hoveredFloor() ?? null,
    stats: () => view()?.stats() ?? null,
    bench: async (ms) => (await view()?.bench(ms)) ?? null,
    camera: () => view()?.camera() ?? null,
    firstCamera: () => view()?.firstCamera() ?? null,
    selected: () => view()?.selected() ?? null,
    hovered: () => view()?.hovered() ?? null,
    paint: () => view()?.paint() ?? null,
    shown: () => view()?.shown() ?? null,
    tweening: () => view()?.tweening() ?? false,
    tweenTrace: () => view()?.tweenTrace() ?? null,
    effects: () => view()?.effects() ?? null,
    disposal,
  };
  window.diffcityScene = hook;
  return hook;
}

const fileCount = (report: Report): number => report.packages.reduce((sum, pkg) => sum + pkg.files.length, 0);

/** Canvas text of the lot names needs the mono face loaded; never waits more than 3 s. */
function monoReady(): Promise<unknown> {
  const family = readToken('--mono');
  if (family === '' || !('fonts' in document)) return Promise.resolve();
  return Promise.race([document.fonts.load(`500 64px ${family}`).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

export function mountChange(element: HTMLElement, options: ChangeScreenOptions): ChangeScreen {
  let view: CityView | null = null;
  let mode: 'computing' | 'empty' | 'fallback' | 'city' | 'pending' | null = null;
  let latest = options.report;
  let hud: Hud | null = null;
  let panel: Panel | null = null;
  let list: FallbackView | null = null;
  let filters: Filters = clearFilters();
  let findings = findingsIndex({ findings: [] });
  let disposed = false;
  const debug = debugEnabled() ? installDebug(() => view) : null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** The selected building and focused floor, as the review actions need them. */
  let selection: { fileId: string; symbolId: string | null } | null = null;
  const controller: ReviewController | null =
    options.review === undefined
      ? null
      : createReviewController({
          port: options.review,
          toast: (text) => {
            hud?.toast(text);
          },
        });
  const reviewUi: ReviewUi | null =
    controller === null
      ? null
      : createReviewUi({
          controller,
          report: () => latest,
          selection: () => selection,
          range: () => panel?.lineRange() ?? null,
        });
  const stopReview = controller?.onChange(syncReview);

  /** Brings the city, the progress, the filters and every mark button in line with the review state. */
  function syncReview(): void {
    if (controller === null) return;
    const state = controller.state();
    // "Hide checked" goes with the marks: without a review state there is nothing to hide.
    if (state === null && filters.hideChecked === true) {
      filters = toggleHideChecked(filters);
      if (latest !== null) hud?.update(latest, filters);
      view?.setFilters(filters);
    }
    hud?.progress(state === null ? null : progressView(state.progress));
    view?.setMarks(marksOf(state));
    reviewUi?.refresh();
  }

  const message = (testId: string, text: string): HTMLElement => h('p', { class: 'change-empty', role: 'status', 'data-testid': testId }, text);

  function dropView(): void {
    view?.dispose();
    view = null;
    list = null;
    hud?.dispose();
    hud = null;
    panel?.dispose();
    panel = null;
    if (debug !== null) debug.ready = false;
  }

  /** The HUD for `report`, created on first use. */
  function hudFor(report: Report): Hud {
    hud ??= createHud({
      crumb: options.crumb ?? false,
      fleet: options.fleet ?? (debug === null ? undefined : window.diffcityFleet),
      review:
        reviewUi === null
          ? undefined
          : {
              onSummary: (trigger) => {
                reviewUi.openSummary(trigger);
              },
            },
      onFilters(next) {
        filters = next;
        if (latest !== null) hud?.update(latest, filters);
        view?.setFilters(filters);
      },
    });
    findings = findingsIndex(report);
    filters = pruneFilters(filters, ruleIndex(report));
    hud.update(report, filters);
    return hud;
  }

  /** The reading panel for `report`, created on first use; it drives the city's selection and hover. */
  function panelFor(report: Report): Panel {
    panel ??= createPanel(
      {
        onSelect: (fileId, symbolId) => {
          if (view !== null) view.select(fileId, symbolId);
          else selectInList(fileId, symbolId);
        },
        onHover: (fileId) => view?.hover(fileId),
        onHoverFloor: (fileId, symbolId) => view?.hoverFloor(fileId, symbolId),
        diffs: debug !== null && window.diffcityNoDiffs === true ? undefined : options.diffs,
        review:
          reviewUi === null
            ? undefined
            : {
                fill: (slot, fileId, symbolId) => {
                  reviewUi.fill(slot, fileId, symbolId);
                },
              },
        reducedMotion,
      },
      report,
    );
    return panel;
  }

  /** Without the city the list holds the selection: the keys, the panel's cards and the review marks act on it as they would on a building. */
  function selectInList(fileId: string | null, symbolId: string | null): void {
    selection = fileId === null ? null : { fileId, symbolId };
    list?.select(fileId);
    panel?.select(fileId, symbolId);
  }

  const hasFile = (report: Report, fileId: string): boolean => report.packages.some((pkg) => pkg.files.some((file) => file.id === fileId));

  /** The touched-file list beside the reading panel, under the top bar; a toast has no overlay to sit in, so it gets its own. */
  function showList(report: Report): void {
    const screen = hudFor(report);
    const reading = panelFor(report);
    list = fallbackView(report, {
      onOpen: (fileId) => {
        selectInList(fileId, null);
        reading.open(fileId, null);
      },
    });
    list.select(selection?.fileId ?? null);
    const toast = h('div', { class: 'hud list-toast' }, screen.toastRoot);
    const work = h('div', { class: 'change-work no-city', 'data-testid': 'change-work' }, list.root, reading.root, toast);
    element.classList.add('has-list');
    replaceChildren(element, screen.bar, work);
  }

  function startCity(): void {
    mode = 'pending';
    replaceChildren(element);
    element.classList.remove('has-list');
    element.classList.add('has-city');
    void monoReady().then(() => {
      if (disposed || mode !== 'pending' || latest === null) return;
      const screen = hudFor(latest);
      try {
        // The city and the reading panel side by side, under the top bar.
        const work = h('div', { class: 'change-work', 'data-testid': 'change-work' });
        replaceChildren(element, screen.bar, work);
        const reading = panelFor(latest);
        view = createCityView(work, latest, {
          reducedMotion,
          onReady: () => {
            if (debug !== null) debug.ready = true;
          },
          hooks: {
            hover(info) {
              reading.hoverFloor(info?.building.id ?? null, info?.floor?.symbolId ?? null);
              if (info === null) {
                screen.tip(null, 0, 0);
                return;
              }
              const rect = view?.element.getBoundingClientRect() ?? element.getBoundingClientRect();
              const tip = tipData(info.city, info.building, info.floor, findings);
              if (controller !== null) tip.mark = tipMark(controller.state(), info.building.id, info.floor?.symbolId ?? null);
              screen.tip(tip, info.clientX - rect.left, info.clientY - rect.top);
            },
            select(building, symbolId) {
              selection = building === null ? null : { fileId: building.id, symbolId };
              screen.card(building === null ? null : cardData(building), symbolId);
              if (building !== null) reviewUi?.fill(screen.cardReviewSlot, building.id, symbolId);
              reading.select(building === null ? null : building.id, symbolId);
            },
            click(building, floor) {
              reading.open(building.id, floor?.symbolId ?? null);
            },
            selectionLost(building) {
              screen.toast(`${building.file.path} is no longer in this change`);
            },
          },
        });
        view.element.append(screen.overlay);
        work.append(reading.root);
        view.setFilters(filters);
        mode = 'city';
        syncReview();
      } catch {
        mode = 'fallback';
        element.classList.remove('has-city');
        showList(latest);
        syncReview();
      }
    });
  }

  function show(report: Report | null): void {
    latest = report;
    if (report === null) {
      dropView();
      mode = 'computing';
      element.classList.remove('has-city', 'has-list');
      replaceChildren(element, message('report-computing', COMPUTING));
      return;
    }
    if (fileCount(report) === 0) {
      dropView();
      mode = 'empty';
      element.classList.remove('has-city', 'has-list');
      replaceChildren(element, message('no-files', NO_FILES));
      return;
    }
    if (mode === 'city' && view !== null) {
      hudFor(report);
      panelFor(report).update(report);
      view.setReport(report);
      view.setFilters(filters);
      view.setMarks(marksOf(controller?.state() ?? null));
      reviewUi?.refresh();
      return;
    }
    if (mode === 'pending') return;
    if (mode === 'fallback') {
      hudFor(report);
      panelFor(report).update(report);
      list?.update(report);
      if (selection !== null && !hasFile(report, selection.fileId)) selectInList(null, null);
      reviewUi?.refresh();
      return;
    }
    startCity();
  }

  show(options.report);
  return {
    update(report) {
      if (!disposed) show(report);
    },
    unmount() {
      disposed = true;
      stopReview?.();
      reviewUi?.dispose();
      controller?.dispose();
      dropView();
      element.classList.remove('has-city', 'has-list');
      element.replaceChildren();
    },
  };
}
