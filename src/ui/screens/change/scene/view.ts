// The night data city of a Report (ADR-026): stage, ground, lots, towers and
// roof labels, the mockup's orbit camera, hover and selection. Rebuilt in
// place on a new Report, keeping the camera, the selected building and the
// city's row width (so lots before a change stay put), and on a theme change. Everything it creates is released by dispose().

import { Fog, HemisphereLight, PMREMGenerator, Vector3 } from 'three';
import type { Object3D } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import type { Report } from '../../../../core/report/types.js';
import { h } from '../../../shared/dom.js';
import type { City, CityBuilding } from '../model/city.js';
import { buildCity } from '../model/city.js';
import { LabelLayer } from './labels.js';
import { createGround } from './night/ground.js';
import type { FatLines } from './night/lines.js';
import { createLots } from './night/lots.js';
import { createTowers } from './night/towers.js';
import type { Towers } from './night/towers.js';
import type { OrbitState } from './orbit.js';
import { bindOrbit, homeFor, Orbit, orbitPosition } from './orbit.js';
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
}

export interface CityView {
  readonly element: HTMLElement;
  setReport(report: Report): void;
  /** Client point of a building's centre, or null when it is not in the city or behind the camera. */
  project(fileId: string): { x: number; y: number } | null;
  stats(): SceneStats;
  camera(): OrbitState;
  /** The camera of the first frame drawn (far out when the intro runs). */
  firstCamera(): OrbitState | null;
  selected(): string | null;
  hovered(): string | null;
  /** Renders every frame for `ms` and reports the frame rate and the scene's draw calls. */
  bench(ms: number): Promise<{ fps: number; drawCalls: number }>;
  dispose(): void;
}

export interface CityViewOptions {
  reducedMotion: boolean;
  /** Called once, after the first frame is on screen. */
  onReady?: () => void;
}

/** The camera counts as resting this long after it last moved; labels are re-ranked and occluded then. */
const REST_MS = 120;

/** Memory left by the last disposed view, for the disposal test. */
export const disposal = { live: 0, lastGeometries: -1, lastTextures: -1 };

interface Content {
  city: City;
  /** The scene parts, compiled one per task before the first frame. */
  parts: Object3D[];
  towers: Towers;
  lines: FatLines[];
  picker: Picker;
  dispose(): void;
}

/** Throws when WebGL2 is not available; the caller shows the fallback. */
export function createCityView(host: HTMLElement, report: Report, options: CityViewOptions): CityView {
  const canvas = h('canvas', { class: 'scene', 'data-testid': 'city-canvas' });
  const element = h(
    'div',
    { class: 'city', 'data-testid': 'city' },
    canvas,
    h(
      'div',
      { class: 'hint' },
      'Drag to orbit, scroll to zoom',
      h('br'),
      h('span', { class: 'kbd' }, 'R'),
      ' reset view',
    ),
  );
  host.append(element);

  let content: Content | null = null;
  let disposed = false;
  let hovered: string | null = null;
  let selected: string | null = null;
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
        return moving;
      },
      afterFrame: () => {
        labels.render(stage.camera);
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
        }
      },
      onResize: (width, height) => {
        labels.setSize(width, height);
        for (const line of content?.lines ?? []) line.material.resolution.set(width, height);
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
  room.dispose();
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.2;
  const sky = new HemisphereLight();
  scene.add(sky);

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

  function build(city: City): Content {
    content?.dispose();
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
    const towers = createTowers(city);
    scene.add(ground.mesh, lots.group, towers.group);
    const lines = [...lots.lines, ...towers.lines];
    for (const line of lines) line.material.resolution.set(stage.size.x, stage.size.y);
    labels.setCity(city);
    content = {
      city,
      towers,
      lines,
      parts: [ground.mesh, lots.group, towers.group],
      picker: new Picker(city),
      dispose() {
        scene.remove(ground.mesh, lots.group, towers.group);
        ground.dispose();
        lots.dispose();
        towers.dispose();
      },
    };

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

    // Hover does not survive a rebuild; the selection does while its file exists.
    hovered = null;
    canvas.style.cursor = '';
    if (selected !== null && !city.byId.has(selected)) selected = null;
    towers.setSelected(selected);
    labels.setFocus(selected, hovered);
    element.dataset['selected'] = selected ?? '';
    settled = false;
    stage.request();
    return content;
  }

  const buildingAt = (clientX: number, clientY: number): CityBuilding | null =>
    content?.picker.pick(clientX, clientY, canvas, camera)?.building ?? null;

  function setHover(id: string | null): void {
    if (id === hovered) return;
    hovered = id;
    if (labels.setFocus(selected, hovered)) settled = false;
    content?.towers.setHover(id);
    canvas.style.cursor = id === null ? '' : 'pointer';
    element.dataset['hovered'] = id ?? '';
    stage.request();
  }

  function select(id: string | null): void {
    selected = id;
    if (labels.setFocus(selected, hovered)) settled = false;
    content?.towers.setSelected(id);
    element.dataset['selected'] = id ?? '';
    stage.request();
  }

  // Shaders compile one scene part at a time before the first frame, in
  // parallel where the GPU supports it, so opening a change does not freeze
  // the page while they compile.
  let lastReport = report;
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
      setHover(buildingAt(x, y)?.id ?? null);
    },
    leave: () => {
      setHover(null);
    },
    click: (x, y) => {
      select(buildingAt(x, y)?.id ?? null);
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

  return {
    element,
    setReport(next) {
      if (disposed) return;
      lastReport = next;
      build(cityOf(next));
    },
    project(fileId) {
      const building = content?.city.byId.get(fileId);
      if (building === undefined) return null;
      return projectToClient(new Vector3(building.x, building.height * 0.5, building.z), camera, canvas);
    },
    stats() {
      return {
        drawCalls: stage.sceneCalls,
        buildings: content?.city.buildings.length ?? 0,
        floors: content?.towers.floors ?? 0,
        lots: content?.city.lots.length ?? 0,
        labels: labels.count,
        frames: stage.frames,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      };
    },
    camera: () => ({ ...orbit.state }),
    firstCamera: () => (firstCamera === null ? null : { ...firstCamera }),
    selected: () => selected,
    hovered: () => hovered,
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
      content?.dispose();
      content = null;
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
