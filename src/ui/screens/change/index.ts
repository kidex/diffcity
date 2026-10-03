// The change screen (SPEC.md section 6): the night data city of the Report
// (ADR-026). It renders from a Report alone and never imports src/ui/data
// (ADR-002, ADR-022): the SPA hands it each new Report, the HTML export a
// single one. Loaded with import() by the route, so Fleet and Repo never
// download three.js.
//
// States: no Report yet (computing), a Report without files, no WebGL (a
// message and the touched-file table), or the city, with the HUD around it
// (hud/): top bar, filters, legend, tooltip, selection card, Fleet card.

import './change.css';

import type { Report } from '../../../core/report/types.js';
import { h, replaceChildren } from '../../shared/dom.js';
import { readToken } from '../../shared/tokens.js';
import { fallbackView } from './fallback.js';
import type { Hud } from './hud/index.js';
import { createHud } from './hud/index.js';
import { cardData, findingsIndex, tipData } from './model/hud.js';
import type { Filters } from './model/view.js';
import { clearFilters, pruneFilters, ruleIndex } from './model/view.js';
import type { FleetPort } from './ports.js';
import type { CityView, SceneStats } from './scene/view.js';
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
}

export interface ChangeScreen {
  /** Shows a new Report of the same change; the camera and the selection stay. */
  update(report: Report | null): void;
  unmount(): void;
}

/** The `?scene-debug` hook for tests and benchmarks (window.diffcityScene). */
export interface SceneDebug {
  ready: boolean;
  project(fileId: string): { x: number; y: number } | null;
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
  /** Views alive, and the renderer's geometries and textures just before the last view released its context. */
  disposal: typeof disposal;
}

declare global {
  interface Window {
    diffcityScene?: SceneDebug;
    /** Under `?scene-debug`, a FleetPort for tests: the SPA has no audit data to build one from yet. */
    diffcityFleet?: FleetPort;
  }
}

function debugEnabled(): boolean {
  return /[?&]scene-debug(?:[=&]|$)/.test(location.search) || location.hash.includes('scene-debug');
}

function installDebug(view: () => CityView | null): SceneDebug {
  const hook: SceneDebug = {
    ready: false,
    project: (fileId) => view()?.project(fileId) ?? null,
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
  let filters: Filters = clearFilters();
  let findings = findingsIndex({ findings: [] });
  let disposed = false;
  const debug = debugEnabled() ? installDebug(() => view) : null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const message = (testId: string, text: string): HTMLElement => h('p', { class: 'change-empty', role: 'status', 'data-testid': testId }, text);

  function dropView(): void {
    view?.dispose();
    view = null;
    hud?.dispose();
    hud = null;
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

  function startCity(): void {
    mode = 'pending';
    replaceChildren(element);
    element.classList.add('has-city');
    void monoReady().then(() => {
      if (disposed || mode !== 'pending' || latest === null) return;
      const screen = hudFor(latest);
      try {
        replaceChildren(element, screen.bar);
        view = createCityView(element, latest, {
          reducedMotion,
          onReady: () => {
            if (debug !== null) debug.ready = true;
          },
          hooks: {
            hover(info) {
              if (info === null) {
                screen.tip(null, 0, 0);
                return;
              }
              const rect = view?.element.getBoundingClientRect() ?? element.getBoundingClientRect();
              screen.tip(tipData(info.city, info.building, info.floor, findings), info.clientX - rect.left, info.clientY - rect.top);
            },
            select(building) {
              screen.card(building === null ? null : cardData(building));
            },
            selectionLost(building) {
              screen.toast(`${building.file.path} is no longer in this change`);
            },
          },
        });
        view.element.append(screen.overlay);
        view.setFilters(filters);
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
      view.setReport(report);
      view.setFilters(filters);
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
