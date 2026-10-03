// The change screen (SPEC.md section 6): the night data city of the Report
// (ADR-026). It renders from a Report alone and never imports src/ui/data
// (ADR-002, ADR-022): the SPA hands it each new Report, the HTML export a
// single one. Loaded with import() by the route, so Fleet and Repo never
// download three.js.
//
// States: no Report yet (computing), a Report without files, no WebGL (a
// message and the touched-file table), or the city, with the HUD around it
// (hud/): top bar, filters, legend, tooltip, selection card, Fleet card, and
// the reading panel at its right (panel/): tabs, stop cards and the file view.

import './change.css';

import type { Report } from '../../../core/report/types.js';
import { h, replaceChildren } from '../../shared/dom.js';
import { readToken } from '../../shared/tokens.js';
import { fallbackView } from './fallback.js';
import type { Hud } from './hud/index.js';
import { createHud } from './hud/index.js';
import { cardData, findingsIndex, tipData } from './model/hud.js';
import type { MarkKind, Marks } from './model/critical.js';
import type { Filters } from './model/view.js';
import { clearFilters, pruneFilters, ruleIndex } from './model/view.js';
import type { Panel } from './panel/index.js';
import { createPanel } from './panel/index.js';
import type { DiffPort, FleetPort } from './ports.js';
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
    /** Under `?scene-debug`, review marks for tests, by file id and symbol id: the ReviewPort is not wired to the city yet. Read when the city opens and on every update. */
    diffcityMarks?: { files?: Record<string, MarkKind>; symbols?: Record<string, MarkKind> };
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
  let filters: Filters = clearFilters();
  let findings = findingsIndex({ findings: [] });
  let disposed = false;
  const debug = debugEnabled() ? installDebug(() => view) : null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** The marks the test page set, as the scene takes them; undefined outside the debug hook. */
  const debugMarks = (): Marks | undefined => {
    const given = debug === null ? undefined : window.diffcityMarks;
    if (given === undefined) return undefined;
    return { files: new Map(Object.entries(given.files ?? {})), symbols: new Map(Object.entries(given.symbols ?? {})) };
  };

  const message = (testId: string, text: string): HTMLElement => h('p', { class: 'change-empty', role: 'status', 'data-testid': testId }, text);

  function dropView(): void {
    view?.dispose();
    view = null;
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
        onSelect: (fileId, symbolId) => view?.select(fileId, symbolId),
        onHover: (fileId) => view?.hover(fileId),
        onHoverFloor: (fileId, symbolId) => view?.hoverFloor(fileId, symbolId),
        diffs: debug !== null && window.diffcityNoDiffs === true ? undefined : options.diffs,
        reducedMotion,
      },
      report,
    );
    return panel;
  }

  function startCity(): void {
    mode = 'pending';
    replaceChildren(element);
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
              screen.tip(tipData(info.city, info.building, info.floor, findings), info.clientX - rect.left, info.clientY - rect.top);
            },
            select(building, symbolId) {
              screen.card(building === null ? null : cardData(building), symbolId);
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
        view.setMarks(debugMarks());
        mode = 'city';
      } catch {
        mode = 'fallback';
        element.classList.remove('has-city');
        replaceChildren(element, screen.bar, fallbackView(latest));
      }
    });
  }

  function show(report: Report | null): void {
    latest = report;
    if (report === null) {
      dropView();
      mode = 'computing';
      element.classList.remove('has-city');
      replaceChildren(element, message('report-computing', COMPUTING));
      return;
    }
    if (fileCount(report) === 0) {
      dropView();
      mode = 'empty';
      element.classList.remove('has-city');
      replaceChildren(element, message('no-files', NO_FILES));
      return;
    }
    if (mode === 'city' && view !== null) {
      hudFor(report);
      panelFor(report).update(report);
      view.setReport(report);
      view.setFilters(filters);
      view.setMarks(debugMarks());
      return;
    }
    if (mode === 'pending') return;
    if (mode === 'fallback') {
      replaceChildren(element, hudFor(report).bar, fallbackView(report));
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
      dropView();
      element.classList.remove('has-city');
      element.replaceChildren();
    },
  };
}
