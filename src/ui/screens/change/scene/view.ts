// The night data city of a Report (ADR-026): stage, ground, lots, towers and
// roof labels, the mockup's orbit camera, hover and selection. Rebuilt in
// place on a new Report, keeping the camera, the selected building and the
// city's row width (so lots before a change stay put), and on a theme change.
// A Report that keeps the layout (a finding's state, a verdict) is only
// repainted: markers, outlines, beams, pulses and labels, nothing rebuilt.
// Everything it creates is released by dispose().

import { Fog, HemisphereLight, PMREMGenerator, Vector3 } from 'three';
import type { Object3D } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import type { Report } from '../../../../core/report/types.js';
import { h } from '../../../shared/dom.js';
import type { City, CityBuilding, CityFloor } from '../model/city.js';
import { buildCity, sameLayout } from '../model/city.js';
import type { Critical, Marks } from '../model/critical.js';
import { criticalFloors } from '../model/critical.js';
import { canvasLabel } from '../model/hud.js';
import { findingMarkers } from '../model/markers.js';
import { pathStops, samePath } from '../model/path.js';
import type { CityPaint, Filters, RuleIndex } from '../model/view.js';
import { focusPaint, NO_FILTERS, paintCity, ruleIndex } from '../model/view.js';
import { easeOut, needsTween, TWEEN_MS, tweenCity } from '../model/tween.js';
import { LabelLayer } from './labels.js';
import { createGround } from './night/ground.js';
import type { FatLines } from './night/lines.js';
import { createLots } from './night/lots.js';
import type { MarkerInfo, Markers } from './night/markers.js';
import { createMarkers } from './night/markers.js';
import { breathe, createMotion } from './night/motion.js';
import type { Path } from './night/path.js';
import { createPath } from './night/path.js';
import { createTowers } from './night/towers.js';
import type { Towers, TowersState } from './night/towers.js';
import type { OrbitState } from './orbit.js';
import { bindOrbit, homeFor, Orbit, orbitPosition } from './orbit.js';
import type { Pick } from './picking.js';
import type { QualityState } from './quality.js';
import { Picker, projectToClient } from './picking.js';
import { Stage } from './stage.js';
import { colorToken, numberToken } from './tokens.js';

export interface SceneStats {
  /** Draw calls of the scene in the last frame (post passes excluded). */
  drawCalls: number;
  buildings: number;
  floors: number;
  lots: number;
  labels: number;
  frames: number;
  /** GPU resources the renderer holds right now. */
  geometries: number;
  textures: number;
  /** Triangles of the scene in the last frame (post passes excluded). */
  triangles: number;
  /** Times the towers' instanced buffers were built: once per Report, again only when a tween frame needs another instance count. */
  builds: number;
  /** Times the city was built (ground, lots, markers, path): at mount, for a Report with another layout and on a theme change; never for one that only repaints. */
  layouts: number;
  /** Shader programs the renderer holds now. */
  programs: number;
  /** The id of the newest shader program a frame has drawn with; ids only grow, so an unchanged id means no frame compiled one. */
  lastProgram: number;
}

/** What the night effects drew, for the debug hook (read-only). */
export interface EffectsState extends TowersState {
  /** The pulse runs ('animated') or holds its static glow with a halo ('static', reduced motion). */
  mode: 'animated' | 'static';
  markers: MarkerInfo[];
  /** The reading path: its stops by step number, whether the tube is drawn, whether packets move, whether it is shown (hidden mid-tween). Null without steps. */
  path: { stops: number[]; tube: boolean; animated: boolean; visible: boolean; atlas: { width: number; height: number; max: number } } | null;
  /** The tier 1 outer ring: whether there is one and its opacity now. */
  tier: { ring: boolean; opacity: number };
  /** The loop renders continuously: something animates, the tab is visible and motion is on. */
  continuous: boolean;
}

export interface CityView {
  readonly element: HTMLElement;
  /** Shows a new Report: buildings in both Reports tween, new ones rise, removed ones sink; camera, selection and filters stay. */
  setReport(report: Report): void;
  /** The filter rows (model/view.ts); the scene dims what they filter out. */
  setFilters(filters: Filters): void;
  /**
   * Selects a building (a file id), and the floor of one of its symbols; null clears
   * it. The same as a click, without the hooks' `click`: the reading panel calls it.
   */
  select(fileId: string | null, symbolId?: string | null): void;
  /** Highlights a building as the pointer does; null removes it. */
  hover(fileId: string | null): void;
  /**
   * Lights one floor (a symbol of the building) and its building, as the reading
   * panel's diff does when the pointer is over a symbol's lines; null puts them out.
   */
  hoverFloor(fileId: string | null, symbolId?: string | null): void;
  /** The symbol id of the floor `hoverFloor` lit, or null. */
  hoveredFloor(): string | null;
  /** The symbol id of the focused floor of the selected building, or null. */
  selectedFloor(): string | null;
  /** The review marks (ADR-028): checked floors are drawn quiet, marked floors stop pulsing. Without marks, none. */
  setMarks(marks: Marks | undefined): void;
  /** What the night effects drew. */
  effects(): EffectsState;
  /** Client point of a building's centre, or null when it is not in the city or behind the camera. */
  project(fileId: string, symbolId?: string): { x: number; y: number } | null;
  stats(): SceneStats;
  /** The quality level chosen by the probe at mount, and whether the probe has finished (read-only). */
  quality(): QualityState;
  camera(): OrbitState;
  /** The camera of the first frame drawn (far out when the intro runs). */
  firstCamera(): OrbitState | null;
  selected(): string | null;
  hovered(): string | null;
  /** What the filters dim, by file id: whole buildings, and dimmed floor indices. */
  paint(): { dimmed: string[]; floors: Record<string, number[]> };
  /** The buildings as shown right now (mid-tween included): ground position and height. */
  shown(): Record<string, { x: number; z: number; height: number }>;
  /** True while a live-update tween plays. */
  tweening(): boolean;
  /** Heights the newest tweened building had on each frame of the last tween, for tests. */
  tweenTrace(): { id: string; heights: number[] } | null;
  /** The last Reports given to setReport, oldest first, for tests. */
  updates(): SceneUpdate[];
  /** Renders every frame for `ms` and reports the frame rate and the scene's draw calls. */
  bench(ms: number): Promise<{ fps: number; drawCalls: number }>;
  dispose(): void;
}

/** One setReport: its sequence number, when it ran and when the first frame after it was drawn (`performance.now()`), and the Report's open findings. */
export interface SceneUpdate {
  seq: number;
  at: number;
  drawnAt: number | null;
  open: number;
}

/** What the HUD hears from the scene. */
export interface SceneHooks {
  /** The pointer is over a building (client point), or left them all. */
  hover(info: { building: CityBuilding; floor: CityFloor | undefined; clientX: number; clientY: number; city: City } | null): void;
  /** The selection changed, or its building was rebuilt by a live update; `symbolId` is the focused floor's symbol. */
  select(building: CityBuilding | null, symbolId: string | null): void;
  /** A click on a building (not a programmatic selection): with the floor under the pointer. */
  click?(building: CityBuilding, floor: CityFloor | undefined): void;
  /** The selected file is no longer in the Report. */
  selectionLost(building: CityBuilding): void;
}

export interface CityViewOptions {
  reducedMotion: boolean;
  /** Called once, after the first frame is on screen. */
  onReady?: () => void;
  hooks?: SceneHooks;
}

/** The camera counts as resting this long after it last moved; labels are re-ranked and occluded then. */
const REST_MS = 120;

/** Memory left by the last disposed view, for the disposal test. */
export const disposal = { live: 0, lastGeometries: -1, lastTextures: -1 };

interface Content {
  /** The Report's city: what picking, labels and the layout use. */
  city: City;
  /** The city the towers draw right now: `city`, or a frame of the tween toward it. */
  shown: City;
  /** The scene parts, compiled one per task before the first frame. */
  parts: Object3D[];
  towers: Towers;
  markers: Markers;
  /** Null without steps. */
  path: Path | null;
  /** The tier 1 outer ring, which breathes. */
  ring: FatLines | null;
  /** Lot outlines; the towers' own are `towers.lines`. */
  lotLines: FatLines[];
  picker: Picker;
  /**
   * Takes the content out of the scene and returns what frees its GPU
   * resources; `keepTowers` leaves the towers (and their buffers) for the next
   * content to lay out again.
   */
  detach(keepTowers?: boolean): () => void;
}

/** A live-update tween in progress; it starts with the first frame drawn after it was set. */
interface Tween {
  from: City;
  to: City;
  startedAt: number | null;
}

/** `?scene-quality=<0-3>` under `?scene-debug`: the bench measures one level at a time. */
function forcedLevel(): number | undefined {
  if (!/[?&]scene-debug(?:[=&]|$)/.test(location.search)) return undefined;
  const value = /[?&]scene-quality=([0-3])(?:&|$)/.exec(location.search)?.[1];
  return value === undefined ? undefined : Number(value);
}

function optionalLevel(): { forceLevel?: number } {
  const level = forcedLevel();
  return level === undefined ? {} : { forceLevel: level };
}

/** Throws when WebGL2 is not available; the caller shows the fallback. */
export function createCityView(host: HTMLElement, report: Report, options: CityViewOptions): CityView {
  const canvas = h('canvas', { class: 'scene', role: 'img', 'aria-label': canvasLabel(report), 'data-testid': 'city-canvas' });
  const element = h(
    'div',
    { class: 'city', 'data-testid': 'city' },
    canvas,
  );
  host.append(element);

  let content: Content | null = null;
  let disposed = false;
  let hovered: string | null = null;
  let selected: string | null = null;
  /** The symbol id of the focused floor of `selected`. */
  let focusedFloor: string | null = null;
  /** The floor the reading panel's diff is pointing at. */
  let hoveredFloor: { id: string; symbolId: string } | null = null;
  let filters: Filters = NO_FILTERS;
  let rules: RuleIndex = ruleIndex(report);
  /** The Report on show: findings and steps come from it. */
  let lastReport = report;
  let marks: Marks | undefined;
  /** The floors that pulse for the Report and the marks (model/critical.ts). */
  let critical: ReadonlyMap<string, Critical> = criticalFloors(report);
  const motion = createMotion(options.reducedMotion);
  let tween: Tween | null = null;
  let trace: { id: string; heights: number[] } | null = null;
  /** Times the towers' instanced buffers were built, for the stats. */
  let towerBuilds = 0;
  /** Times build() ran, for the stats. */
  let layouts = 0;
  /** The newest program id seen after a frame, for the stats. */
  let lastProgram = -1;
  /** The last setReport calls, for the debug hook. */
  const updates: SceneUpdate[] = [];
  let updateSeq = 0;
  /** The paint of the shown city for the filters alone: hover and selection are laid over it. */
  let baseline: CityPaint | null = null;
  const hooks = options.hooks;
  /** Labels are ranked and occluded for the current camera, selection and hover. */
  let settled = false;
  let cameraMovedAt = Number.NEGATIVE_INFINITY;
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  /** Row width of the first city, kept for every later Report (ADR-026 layout stability). */
  let rowWidth: number | undefined;
  const target = new Vector3();
  // Homed on the first build.
  const orbit = new Orbit(homeFor(1));
  let homed = false;
  // The intro starts with the first frame, so a slow first frame (shader compile) does not eat it.
  let introPending = false;
  let firstCamera: OrbitState | null = null;
  const labels = new LabelLayer(element);
  /**
   * What replaced content leaves to free, released after the next frame is
   * drawn: three deletes a shader program as soon as no material uses it, so
   * freeing the old materials before the new ones are drawn would compile
   * every program again (seconds in a software renderer, DC-110). A hidden
   * page draws no frame, so it frees at once rather than piling up.
   */
  let retired: (() => void)[] = [];
  const release = (): void => {
    const pending = retired;
    retired = [];
    for (const free of pending) free();
  };
  const retire = (free: () => void): void => {
    retired.push(free);
    if (document.visibilityState !== 'visible') release();
  };

  let stage: Stage;
  try {
    stage = new Stage({
      canvas,
      container: element,
      bloomStrength: numberToken('--c-bloom', 0.45),
      beforeFrame: ({ now }) => {
        if (introPending) {
          introPending = false;
          if (orbit.introRunning) orbit.startIntro(now);
        }
        const moving = orbit.step(now);
        applyCamera();
        firstCamera ??= { ...orbit.state };
        if (moving) cameraMoved(now);
        if (!options.reducedMotion) {
          motion.time.value = now / 1000;
          const ring = content?.ring;
          if (ring) ring.material.opacity = breathe(motion.time.value);
        }
        return stepTween(now) || moving || animating();
      },
      afterFrame: () => {
        labels.render(stage.camera);
        for (const program of renderer.info.programs ?? []) lastProgram = Math.max(lastProgram, program.id);
        const drawnAt = performance.now();
        for (const update of updates) update.drawnAt ??= drawnAt;
        release();
        if (!settled && content !== null && !orbit.introRunning) {
          // Only when the camera rests, never on every drag frame.
          const wait = cameraMovedAt + REST_MS - performance.now();
          if (wait <= 0) {
            labels.updateOcclusion(stage.camera, content.picker);
            settled = true;
          } else {
            clearTimeout(restTimer);
            restTimer = setTimeout(() => {
              stage.request();
            }, wait);
          }
        }
        if (!ready) {
          ready = true;
          element.dataset['ready'] = 'true';
          options.onReady?.();
          // The quality is chosen once, now that the shaders are compiled and the first frame is out.
          void stage.probe();
        }
      },
      ...optionalLevel(),
      onQuality: (level) => {
        if (!level.environment) scene.environment = null;
      },
      onResize: (width, height) => {
        labels.setSize(width, height);
        for (const line of [...(content?.lotLines ?? []), ...(content?.towers.lines ?? [])]) line.material.resolution.set(width, height);
      },
    });
  } catch (error) {
    labels.dispose();
    element.remove();
    throw error;
  }
  disposal.live += 1;

  const { scene, camera, renderer } = stage;
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  // The room's standard material is the first upload of three's shared lookup texture.
  stage.keepLookupFrom(room);
  room.dispose();
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.2;
  const sky = new HemisphereLight();
  scene.add(sky);

  /** Something animates, motion is on and the tab is visible: only then does the loop run on its own (ADR-026). */
  function animating(): boolean {
    const c = content;
    if (c === null || options.reducedMotion || document.visibilityState !== 'visible') return false;
    return c.towers.pulsing > 0 || c.path?.animated === true || c.ring !== null;
  }

  function cameraMoved(now = performance.now()): void {
    cameraMovedAt = now;
    settled = false;
  }

  function cityOf(next: Report): City {
    const city = buildCity(next, { rowWidth });
    rowWidth = city.rowWidth > 0 ? city.rowWidth : rowWidth;
    return city;
  }

  function applyCamera(): void {
    const position = orbitPosition(target, orbit.state);
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(target);
    // Picking and projection read the matrices before the next frame is drawn.
    camera.updateMatrixWorld();
  }

  /** Brings the towers' paint in line with the filters, hover and selection; `full` recomputes the filter paint too. */
  function repaint(full: boolean): void {
    const c = content;
    if (c === null) return;
    if (full || baseline === null) {
      baseline = paintCity({ city: c.shown, filters, rules, hover: null, selection: null, critical, marks });
      const dim = new Set<string>();
      for (const building of c.shown.buildings) if (baseline.buildings[building.index]?.dimmed === true) dim.add(building.id);
      labels.setDimmed(dim, tween !== null);
      element.dataset['filters'] = `verdict=${filters.verdict ?? ''};type=${filters.type ?? ''};rule=${filters.rule ?? ''}${filters.hideChecked === true ? ';hide-checked' : ''}`;
    }
    const paint = focusPaint(baseline, c.shown, hovered, selected, focusedFloor, hoveredFloor);
    c.towers.setPaint(paint);
    c.markers.setPaint(paint);
    stage.request();
  }

  /**
   * Draws `shown` (the Report's city, or a frame of the tween toward it): in
   * place while it needs as many instances as the towers have, in new towers
   * only when the count changes (ADR-026).
   */
  function showCity(shown: City): void {
    const c = content;
    if (c === null) return;
    c.markers.update(shown);
    if (!c.towers.update(shown)) {
      const old = c.towers;
      scene.remove(old.group);
      retire(() => {
        old.dispose();
      });
      const towers = createTowers(shown, motion);
      towerBuilds += 1;
      scene.add(towers.group);
      for (const line of towers.lines) line.material.resolution.set(stage.size.x, stage.size.y);
      c.towers = towers;
    }
    c.shown = shown;
    repaint(true);
  }

  /** One frame of the tween; true while it still has frames to draw. */
  function stepTween(now: number): boolean {
    const running = tween;
    if (running === null || content === null) return false;
    running.startedAt ??= now;
    const progress = Math.min(1, (now - running.startedAt) / TWEEN_MS);
    const frame = tweenCity(running.from, running.to, easeOut(progress));
    if (progress >= 1) tween = null;
    showCity(frame);
    if (trace !== null) trace.heights.push(frame.byId.get(trace.id)?.height ?? 0);
    if (progress >= 1) {
      // The labels and the path come back at the final positions.
      labels.setDimmed(labels.dimmedIds, false);
      content.path?.setVisible(true);
      return false;
    }
    return true;
  }

  /**
   * `reuse`: a new Report of the same view keeps the towers' instanced buffers
   * and lays the frame out in them when it needs as many instances (a theme
   * change builds anew: the materials read the colour tokens once).
   */
  function build(city: City, from: City | null = null, reuse = false): Content {
    const previous = content?.city ?? null;
    layouts += 1;
    const reusable = reuse && content !== null ? content.towers : null;
    if (content !== null) retire(content.detach(reusable !== null));
    const voidColor = colorToken('--c-void');
    const { bounds } = city;
    scene.background = voidColor;
    scene.fog = new Fog(voidColor, bounds.span * 1.4, bounds.span * 3.4);
    sky.color = colorToken('--c-sky');
    sky.groundColor = voidColor;
    sky.intensity = 0.6;
    stage.setBloomStrength(numberToken('--c-bloom', 0.45));

    const ground = createGround(bounds);
    const lots = createLots(city, renderer);
    // A tween starts with its first frame drawn; the first frame it draws is its start.
    tween = from !== null && needsTween(from, city) ? { from, to: city, startedAt: null } : null;
    trace = null;
    if (tween !== null) {
      // The newest building, or else the first one that moves.
      const followed = city.buildings.find((building) => !tween?.from.byId.has(building.id)) ?? city.buildings[0];
      if (followed !== undefined) trace = { id: followed.id, heights: [] };
    }
    const shown = tween === null ? city : tweenCity(tween.from, city, 0);
    let towers = reusable;
    if (towers === null || !towers.update(shown)) {
      // Freed after the next frame, as the rest of the old content: the new towers take their programs over.
      const old = towers;
      if (old !== null) {
        retire(() => {
          old.dispose();
        });
      }
      towers = createTowers(shown, motion);
      towerBuilds += 1;
    }
    const markers = createMarkers(findingMarkers(city, lastReport.findings), shown);
    const path = createPath(pathStops(city, lastReport.steps), motion, renderer);
    // Built for the Report's own city, so it waits for the tween to end.
    path?.setVisible(tween === null);
    scene.add(ground.mesh, lots.group, towers.group, markers.group);
    if (path !== null) scene.add(path.group);
    for (const line of [...lots.lines, ...towers.lines]) line.material.resolution.set(stage.size.x, stage.size.y);
    labels.setCity(city);
    const made: Content = {
      city,
      shown,
      towers,
      markers,
      path,
      ring: lots.ring,
      lotLines: lots.lines,
      parts: [ground.mesh, lots.group, towers.group, markers.group, ...(path === null ? [] : [path.group])],
      picker: new Picker(city),
      detach(keepTowers = false) {
        const towers = made.towers;
        scene.remove(ground.mesh, lots.group, towers.group, markers.group);
        if (path !== null) scene.remove(path.group);
        return () => {
          ground.dispose();
          lots.dispose();
          if (!keepTowers) towers.dispose();
          markers.dispose();
          path?.dispose();
        };
      },
    };
    content = made;

    const home = homeFor(bounds.span);
    camera.far = home.r * 2 + bounds.span * 4;
    camera.updateProjectionMatrix();
    orbit.setHome(home);
    if (!homed) {
      homed = true;
      target.set(bounds.cx, 0.4, bounds.cz + bounds.span * 0.03);
      orbit.reset();
      if (!options.reducedMotion) {
        orbit.startIntro(performance.now());
        introPending = true;
      }
    }
    applyCamera();
    settle(city, previous);
    return made;
  }

  /**
   * A new Report that lays out as the city on screen (a finding's state, a
   * verdict, the marks): the ground, the lots, the path and the towers' buffers
   * stay, and only what the Report paints is drawn again, so no material or
   * texture is made anew (DC-110).
   */
  function refresh(city: City): void {
    const c = content;
    if (c === null) return;
    const previous = c.city;
    c.city = city;
    c.picker = new Picker(city);
    c.markers.setPlan(findingMarkers(city, lastReport.findings));
    showCity(city);
    labels.setCity(city);
    settle(city, previous);
  }

  /** After a new city: hover, selection and focused floor follow it, the paint is redone and the hooks hear of it. */
  function settle(city: City, previous: City | null): void {
    // Hover does not survive a rebuild; the selection does while its file exists.
    hovered = null;
    hoveredFloor = null;
    element.dataset['hoveredFloor'] = '';
    hooks?.hover(null);
    canvas.style.cursor = '';
    const lost = selected === null || city.byId.has(selected) ? null : (previous?.byId.get(selected) ?? null);
    if (selected !== null && !city.byId.has(selected)) selected = null;
    // The focused floor stays while its symbol is still a floor of the building.
    if (selected === null || city.byId.get(selected)?.floors.some((floor) => floor.symbolId === focusedFloor) !== true) focusedFloor = null;
    labels.setFocus(selected, hovered);
    element.dataset['selected'] = selected ?? '';
    element.dataset['selectedFloor'] = focusedFloor ?? '';
    baseline = null;
    repaint(true);
    hooks?.select(selected === null ? null : (city.byId.get(selected) ?? null), focusedFloor);
    if (lost !== null) hooks?.selectionLost(lost);
    settled = false;
    stage.request();
  }

  const pickAt = (clientX: number, clientY: number): Pick | null => content?.picker.pick(clientX, clientY, canvas, camera) ?? null;

  function setHover(id: string | null): void {
    if (id === hovered) return;
    hovered = id;
    if (labels.setFocus(selected, hovered)) settled = false;
    repaint(false);
    canvas.style.cursor = id === null ? '' : 'pointer';
    element.dataset['hovered'] = id ?? '';
  }

  function setHoverFloor(id: string | null, symbolId: string | null = null): void {
    const building = id === null ? undefined : content?.city.byId.get(id);
    const floor = building?.floors.find((candidate) => candidate.symbolId === symbolId);
    const next = building !== undefined && floor !== undefined && symbolId !== null ? { id: building.id, symbolId } : null;
    if (next?.id === hoveredFloor?.id && next?.symbolId === hoveredFloor?.symbolId) return;
    hoveredFloor = next;
    element.dataset['hoveredFloor'] = next?.symbolId ?? '';
    // The pointer is in the panel: the building is lit with the floor.
    if (next === null) setHover(null);
    else setHover(next.id);
    repaint(false);
  }

  function select(id: string | null, symbolId: string | null = null): void {
    const building = id === null ? undefined : content?.city.byId.get(id);
    // A file that is not in the city cannot be selected.
    if (id !== null && building === undefined) return;
    selected = id;
    focusedFloor = building?.floors.some((floor) => floor.symbolId === symbolId) === true ? symbolId : null;
    if (labels.setFocus(selected, hovered)) settled = false;
    repaint(false);
    element.dataset['selected'] = id ?? '';
    element.dataset['selectedFloor'] = focusedFloor ?? '';
    hooks?.select(building ?? null, focusedFloor);
  }

  // Shaders compile one scene part at a time before the first frame, in
  // parallel where the GPU supports it, so opening a change does not freeze
  // the page while they compile.
  const first = build(cityOf(report));
  const isDisposed = (): boolean => disposed;
  // A new Report or a theme change disposes `first`; its materials are not compiled then.
  const isStale = (): boolean => content !== first;
  void (async () => {
    try {
      for (const part of first.parts) {
        if (isDisposed()) return;
        if (isStale()) break;
        await renderer.compileAsync(part, camera, scene);
      }
    } catch {
      // A failed warm-up only means the first frame compiles the rest.
    }
    if (!isDisposed()) stage.start();
  })();

  const unbind = bindOrbit(canvas, orbit, {
    changed: () => {
      applyCamera();
      cameraMoved();
      stage.request();
    },
    hover: (x, y) => {
      const pick = pickAt(x, y);
      setHover(pick?.building.id ?? null);
      if (pick === null || content === null) hooks?.hover(null);
      else hooks?.hover({ building: pick.building, floor: pick.floor, clientX: x, clientY: y, city: content.city });
    },
    leave: () => {
      setHover(null);
      hooks?.hover(null);
    },
    click: (x, y) => {
      const pick = pickAt(x, y);
      select(pick?.building.id ?? null, pick?.floor?.symbolId ?? null);
      if (pick !== null) hooks?.click?.(pick.building, pick.floor);
    },
    clear: () => {
      select(null);
    },
  });

  // A theme change re-reads every colour token.
  const scheme = matchMedia('(prefers-color-scheme: light)');
  const onScheme = (): void => {
    build(cityOf(lastReport));
  };
  scheme.addEventListener('change', onScheme);
  // Back on screen: the loop starts again if something animates.
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') stage.request();
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    element,
    setReport(next) {
      if (disposed) return;
      updateSeq += 1;
      updates.push({ seq: updateSeq, at: performance.now(), drawnAt: null, open: next.findings.filter((finding) => finding.state === 'open').length });
      if (updates.length > 16) updates.shift();
      const previousSteps = lastReport.steps;
      lastReport = next;
      canvas.setAttribute('aria-label', canvasLabel(next));
      rules = ruleIndex(next);
      critical = criticalFloors(next, marks);
      // A tween in progress continues from what is on screen.
      const from = options.reducedMotion ? null : (content?.shown ?? null);
      const city = cityOf(next);
      const c = content;
      if (c !== null && tween === null && sameLayout(c.city, city) && samePath(pathStops(c.city, previousSteps), pathStops(city, next.steps))) refresh(city);
      else build(city, from, true);
    },
    select,
    hover: setHover,
    hoverFloor: setHoverFloor,
    hoveredFloor: () => hoveredFloor?.symbolId ?? null,
    selectedFloor: () => focusedFloor,
    setFilters(next) {
      filters = next;
      repaint(true);
    },
    setMarks(next) {
      marks = next;
      critical = criticalFloors(lastReport, marks);
      repaint(true);
    },
    effects() {
      const c = content;
      const state = c?.towers.state() ?? { pulsing: 0, halos: 0, pulse: {}, checked: {}, gains: {} };
      const path = c?.path ?? null;
      return {
        ...state,
        mode: options.reducedMotion ? 'static' : 'animated',
        markers: c?.markers.list() ?? [],
        path: path === null ? null : { ...path.state(), visible: path.group.visible },
        tier: { ring: c?.ring != null, opacity: c?.ring?.material.opacity ?? 1 },
        continuous: animating(),
      };
    },
    project(fileId, symbolId) {
      const building = content?.city.byId.get(fileId);
      if (building === undefined) return null;
      const floor = symbolId === undefined ? undefined : building.floors.find((candidate) => candidate.symbolId === symbolId);
      const y = floor === undefined ? building.height * 0.5 : (floor.y0 + floor.y1) / 2;
      return projectToClient(new Vector3(building.x, y, building.z), camera, canvas);
    },
    stats() {
      return {
        drawCalls: stage.sceneCalls,
        triangles: stage.sceneTriangles,
        buildings: content?.city.buildings.length ?? 0,
        floors: content?.towers.floors ?? 0,
        lots: content?.city.lots.length ?? 0,
        labels: labels.count,
        frames: stage.frames,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        builds: towerBuilds,
        layouts,
        programs: renderer.info.programs?.length ?? 0,
        lastProgram,
      };
    },
    quality: () => stage.quality,
    camera: () => ({ ...orbit.state }),
    firstCamera: () => (firstCamera === null ? null : { ...firstCamera }),
    selected: () => selected,
    hovered: () => hovered,
    paint() {
      const dimmed: string[] = [];
      const floors: Record<string, number[]> = {};
      const c = content;
      if (c === null || baseline === null) return { dimmed, floors };
      for (const building of c.shown.buildings) {
        if (baseline.buildings[building.index]?.dimmed === true) dimmed.push(building.id);
        const dimFloors = (baseline.floors[building.index] ?? []).flatMap((floor, i) => (floor.dimmed ? [i] : []));
        if (dimFloors.length > 0) floors[building.id] = dimFloors;
      }
      return { dimmed, floors };
    },
    shown() {
      const result: Record<string, { x: number; z: number; height: number }> = {};
      for (const building of content?.shown.buildings ?? []) result[building.id] = { x: building.x, z: building.z, height: building.height };
      return result;
    },
    tweening: () => tween !== null,
    tweenTrace: () => (trace === null ? null : { id: trace.id, heights: [...trace.heights] }),
    updates: () => updates.map((update) => ({ ...update })),
    bench(ms) {
      return new Promise((resolve) => {
        const start = stage.frames;
        const startedAt = performance.now();
        stage.runContinuously(ms);
        setTimeout(() => {
          const elapsed = performance.now() - startedAt;
          resolve({ fps: Math.round(((stage.frames - start) * 1000) / elapsed), drawCalls: stage.sceneCalls });
        }, ms);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unbind();
      clearTimeout(restTimer);
      scheme.removeEventListener('change', onScheme);
      document.removeEventListener('visibilitychange', onVisible);
      if (content !== null) retired.push(content.detach());
      content = null;
      release();
      scene.remove(sky);
      sky.dispose();
      scene.environment = null;
      environment.dispose();
      labels.dispose();
      const left = stage.dispose();
      disposal.lastGeometries = left.geometries;
      disposal.lastTextures = left.textures;
      element.remove();
      disposal.live -= 1;
    },
  };
}
