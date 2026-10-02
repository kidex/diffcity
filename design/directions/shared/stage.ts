// Everything the three directions share around their scene: the renderer,
// the orbit camera ported from the mockup (drag, wheel, R, intro move),
// picking, hover, selection, filters and the render loop. A direction only
// builds its scene, paints a building for a given state and renders a frame.

import '../../../src/ui/shared/tokens.css';
import { fontsReady } from '../../../src/ui/shared/fonts.js';
import './hud.css';

import { PerspectiveCamera, Raycaster, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer } from 'three';
import type { Object3D, ToneMapping } from 'three';

import { buildCity } from './city.js';
import type { City, CityBuilding, CityFloor, Status } from './city.js';
import type { DirectionMeta, Filters } from './hud.js';
import { createHud } from './hud.js';
import { LabelLayer } from './labels.js';
import { loadReport } from './report.js';

export interface PaintState {
  hovered: boolean;
  selected: boolean;
  /** Excluded by the verdict filter, or no floor matches the type filter. */
  dimmed: boolean;
  /** Floors of another status are dimmed when set. */
  type: Exclude<Status, 'same'> | null;
}

export interface DirectionContext {
  city: City;
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  labels: LabelLayer;
  /** The point the camera orbits around. */
  target: Vector3;
  reducedMotion: boolean;
}

export interface DirectionScene {
  /** Meshes the pointer can hit: `userData.building` (id), `userData.floor` (index). */
  pickables: Object3D[];
  paint(building: CityBuilding, state: PaintState): void;
  /** Draws one frame; `time` in seconds. */
  render(time: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** True when the scene animates by itself and needs every frame. */
  animated: boolean;
}

export interface Direction extends DirectionMeta {
  toneMapping: ToneMapping;
  exposure: number;
  /** Shadow map type, or null for no shadows. */
  shadows: number | null;
  fov?: number;
  build(context: DirectionContext): DirectionScene;
}

interface Orbit {
  theta: number;
  phi: number;
  r: number;
}

const INTRO_MS = 2400;
const easeOutQuart = (k: number): number => 1 - (1 - k) ** 4;

export async function startDirection(direction: Direction): Promise<void> {
  await fontsReady();
  const root = document.getElementById('app');
  if (root === null) throw new Error('#app missing');
  root.dataset['direction'] = direction.id;

  const { report, sampleOverlay } = loadReport();
  const city = buildCity(report, sampleOverlay);
  const hud = createHud(root, city, direction);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new WebGLRenderer({ canvas: hud.canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = direction.toneMapping;
  renderer.toneMappingExposure = direction.exposure;
  if (direction.shadows !== null) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = direction.shadows as typeof renderer.shadowMap.type;
  }
  const pixelRatio = Math.min(devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);

  const scene = new Scene();
  const camera = new PerspectiveCamera(direction.fov ?? 32, 1, 0.1, 400);
  const labels = new LabelLayer(hud.city);
  const { bounds } = city;
  const target = new Vector3(bounds.cx, 0.4, bounds.cz + bounds.span * 0.03);
  const built = direction.build({ city, scene, camera, renderer, labels, target, reducedMotion });

  // ---------- camera ----------
  const home: Orbit = { theta: Math.PI * 0.22, phi: 0.98, r: bounds.span * 1.62 };
  const limits = { rMin: home.r * 0.42, rMax: home.r * 1.7, phiMin: 0.35, phiMax: 1.35 };
  const goal: Orbit = { ...home };
  const cam: Orbit = reducedMotion ? { ...home } : { theta: home.theta - 0.75, phi: home.phi - 0.42, r: home.r * 1.75 };
  let introStart: number | null = reducedMotion ? null : performance.now();
  const introFrom: Orbit = { ...cam };

  const applyCamera = (): void => {
    camera.position.set(
      target.x + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta),
      target.y + cam.r * Math.cos(cam.phi),
      target.z + cam.r * Math.sin(cam.phi) * Math.sin(cam.theta),
    );
    camera.lookAt(target);
  };
  applyCamera();

  // ---------- picking, hover, selection ----------
  const ray = new Raycaster();
  const pointer = new Vector2();
  let hovered: CityBuilding | null = null;
  let selected: CityBuilding | null = null;
  let filters: Filters = { verdict: null, type: null };
  let dirty = true;

  const pick = (event: PointerEvent): { building: CityBuilding; floor: CityFloor | undefined } | null => {
    const rect = hud.canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    for (const hit of ray.intersectObjects(built.pickables, false)) {
      const id = hit.object.userData['building'] as string | undefined;
      const building = id === undefined ? undefined : city.byId.get(id);
      if (building === undefined) continue;
      const index = hit.object.userData['floor'] as number | undefined;
      return { building, floor: index === undefined ? undefined : building.floors[index] };
    }
    return null;
  };

  const paint = (building: CityBuilding): void => {
    const dimmed =
      (filters.verdict !== null && building.verdict !== filters.verdict) || (filters.type !== null && building.counts[filters.type] === 0);
    const state: PaintState = { hovered: hovered === building, selected: selected === building, dimmed, type: filters.type };
    built.paint(building, state);
    labels.toggle(building.id, 'is-hover', state.hovered);
    labels.toggle(building.id, 'is-selected', state.selected);
    labels.toggle(building.id, 'is-dim', dimmed);
    dirty = true;
  };
  const paintAll = (): void => {
    for (const building of city.buildings) paint(building);
  };

  const setHover = (building: CityBuilding | null): void => {
    if (hovered === building) return;
    const previous = hovered;
    hovered = building;
    if (previous !== null) paint(previous);
    if (building !== null) paint(building);
    hud.canvas.style.cursor = building === null ? 'grab' : 'pointer';
  };
  const select = (building: CityBuilding | null): void => {
    const previous = selected;
    selected = building;
    if (previous !== null) paint(previous);
    if (building !== null) paint(building);
    hud.showSelection(building);
  };

  hud.onFilters((next) => {
    filters = next;
    paintAll();
  });

  // ---------- orbit (ported from the mockup) ----------
  let drag: { x: number; y: number; moved: boolean } | null = null;
  const stopIntro = (): void => {
    if (introStart === null) return;
    introStart = null;
    Object.assign(goal, cam);
  };
  hud.canvas.addEventListener('pointerdown', (event) => {
    stopIntro();
    drag = { x: event.clientX, y: event.clientY, moved: false };
    hud.canvas.setPointerCapture(event.pointerId);
  });
  hud.canvas.addEventListener('pointermove', (event) => {
    if (drag !== null) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      goal.theta -= dx * 0.006;
      goal.phi = Math.max(limits.phiMin, Math.min(limits.phiMax, goal.phi - dy * 0.005));
      drag.x = event.clientX;
      drag.y = event.clientY;
      hud.hideTip();
      return;
    }
    const hit = pick(event);
    setHover(hit?.building ?? null);
    if (hit === null) hud.hideTip();
    else hud.showTip(hit.building, hit.floor, event.clientX, event.clientY);
  });
  hud.canvas.addEventListener('pointerup', (event) => {
    if (drag !== null && !drag.moved) select(pick(event)?.building ?? null);
    drag = null;
  });
  hud.canvas.addEventListener('pointerleave', () => {
    drag = null;
    setHover(null);
    hud.hideTip();
  });
  hud.canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      stopIntro();
      goal.r = Math.max(limits.rMin, Math.min(limits.rMax, goal.r * (1 + event.deltaY * 0.0012)));
    },
    { passive: false },
  );
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'r') {
      stopIntro();
      Object.assign(goal, home);
    } else if (key === 'escape') {
      select(null);
    } else if ((key === 'j' || key === 'k') && city.path.length > 0) {
      const current = city.path.findIndex((stop) => stop.building === selected);
      const next = Math.max(0, Math.min(city.path.length - 1, current + (key === 'j' ? 1 : -1)));
      select(city.path[next]?.building ?? null);
    }
  });

  // ---------- size ----------
  const resize = (): void => {
    const rect = hud.city.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    built.setSize(width, height, pixelRatio);
    labels.setSize(width, height);
    dirty = true;
  };
  new ResizeObserver(resize).observe(hud.city);
  resize();

  // Default selection, as in the mockup: the first tier 1 stop.
  const firstTier = city.path.find((stop) => stop.building.tier1)?.building ?? null;
  paintAll();
  select(firstTier);

  // ---------- loop ----------
  let last = performance.now();
  let settled = false;
  let benchUntil = 0;
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    let moving = false;
    if (introStart !== null) {
      const k = Math.min(1, (now - introStart) / INTRO_MS);
      const e = easeOutQuart(k);
      cam.theta = introFrom.theta + (home.theta - introFrom.theta) * e;
      cam.phi = introFrom.phi + (home.phi - introFrom.phi) * e;
      cam.r = introFrom.r + (home.r - introFrom.r) * e;
      moving = true;
      if (k >= 1) {
        introStart = null;
        Object.assign(goal, home);
      }
    } else {
      // Light damping towards the goal; instant under reduced motion.
      const a = reducedMotion ? 1 : 1 - Math.exp(-dt * 14);
      for (const key of ['theta', 'phi', 'r'] as const) {
        const delta = goal[key] - cam[key];
        if (Math.abs(delta) > 1e-4) {
          cam[key] += delta * a;
          moving = true;
        } else cam[key] = goal[key];
      }
    }
    if (moving) {
      applyCamera();
      settled = false;
      dirty = true;
    } else if (!settled) {
      // Occlusion tests once the camera rests (and on the first frame).
      labels.updateOcclusion(camera, built.pickables);
      settled = true;
      dirty = true;
    }
    if (!dirty && !built.animated && now > benchUntil) return;
    built.render(now / 1000);
    labels.render(scene, camera);
    dirty = false;
  };
  requestAnimationFrame(frame);
  // Exposed for the screenshot script: where a building is on screen, and a
  // frame-rate probe that renders every frame for `ms` milliseconds.
  Object.assign(window, {
    diffcityDirections: {
      bench(ms: number): Promise<number> {
        benchUntil = performance.now() + ms;
        return new Promise((resolve) => {
          let frames = 0;
          const start = performance.now();
          const tick = (now: number): void => {
            frames += 1;
            if (now - start < ms) requestAnimationFrame(tick);
            else resolve(Math.round((frames * 1000) / (now - start)));
          };
          requestAnimationFrame(tick);
        });
      },
      hover(id: string): { x: number; y: number } | null {
        const building = city.byId.get(id);
        if (building === undefined) return null;
        const point = new Vector3(building.x, building.height * 0.6, building.z).project(camera);
        const rect = hud.canvas.getBoundingClientRect();
        return { x: rect.left + ((point.x + 1) / 2) * rect.width, y: rect.top + ((1 - point.y) / 2) * rect.height };
      },
    },
  });
}
