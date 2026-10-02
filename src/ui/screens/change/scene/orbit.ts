// The orbit camera of design/mockup.html, ported as plain math (no three.js,
// so it is unit-tested in Node) plus the DOM listeners that drive it.
//
// Spherical coordinates around the city centre: home theta 0.22π, phi 0.98;
// drag turns theta by 0.006 rad and phi by 0.005 rad per pixel, phi stays in
// [0.35, 1.35]; the wheel scales r by (1 + deltaY * 0.0012) within limits; R
// goes home. The mockup's absolute distances (home 30, limits 14 to 48 for a
// city about 22 wide) are scaled to the city's span. The intro move eases r
// in from 46/30 of home over 1.4 s, ease-out cubic, and is skipped under
// prefers-reduced-motion.

export interface OrbitState {
  theta: number;
  phi: number;
  r: number;
}

export interface OrbitLimits {
  phiMin: number;
  phiMax: number;
  rMin: number;
  rMax: number;
}

export const HOME_THETA = Math.PI * 0.22;
export const HOME_PHI = 0.98;
export const PHI_MIN = 0.35;
export const PHI_MAX = 1.35;
/** Home distance per unit of city span. */
export const HOME_R_PER_SPAN = 1.45;
/** The mockup's 14 / 30 and 48 / 30. */
export const R_MIN_RATIO = 14 / 30;
export const R_MAX_RATIO = 48 / 30;
/** Closest the camera gets on a large city, in world units. */
export const R_MIN_ABSOLUTE = 14;
export const INTRO_MS = 1400;
export const INTRO_FROM_RATIO = 46 / 30;
const DRAG_THETA = 0.006;
const DRAG_PHI = 0.005;
const WHEEL = 0.0012;
/** A pointer that moves more than this many pixels is a drag, not a click. */
export const CLICK_SLOP = 3;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const easeOutCubic = (k: number): number => 1 - (1 - k) ** 3;

/** Home view for a city whose larger side is `span`. */
export function homeFor(span: number): OrbitState {
  return { theta: HOME_THETA, phi: HOME_PHI, r: Math.max(span, 4) * HOME_R_PER_SPAN };
}

export function limitsFor(home: OrbitState): OrbitLimits {
  return {
    phiMin: PHI_MIN,
    phiMax: PHI_MAX,
    rMin: Math.min(home.r * R_MIN_RATIO, R_MIN_ABSOLUTE),
    rMax: home.r * R_MAX_RATIO,
  };
}

/** Camera position for `state` around `target`. */
export function orbitPosition(target: { x: number; y: number; z: number }, state: OrbitState): { x: number; y: number; z: number } {
  return {
    x: target.x + state.r * Math.sin(state.phi) * Math.cos(state.theta),
    y: target.y + state.r * Math.cos(state.phi),
    z: target.z + state.r * Math.sin(state.phi) * Math.sin(state.theta),
  };
}

export class Orbit {
  home: OrbitState;
  limits: OrbitLimits;
  readonly state: OrbitState;
  private intro: { start: number; from: OrbitState } | null = null;

  constructor(home: OrbitState) {
    this.home = { ...home };
    this.limits = limitsFor(home);
    this.state = { ...home };
  }

  /** Starts the intro move at `now` (ms); the camera begins far out. */
  startIntro(now: number): void {
    const from = { ...this.home, r: this.home.r * INTRO_FROM_RATIO };
    Object.assign(this.state, from);
    this.intro = { start: now, from };
  }

  get introRunning(): boolean {
    return this.intro !== null;
  }

  /** Any user input ends the intro where it is. */
  stopIntro(): void {
    this.intro = null;
  }

  /** Advances the intro; true while the camera is still moving. */
  step(now: number): boolean {
    if (this.intro === null) return false;
    const k = clamp((now - this.intro.start) / INTRO_MS, 0, 1);
    this.state.r = this.intro.from.r + (this.home.r - this.intro.from.r) * easeOutCubic(k);
    if (k >= 1) {
      this.intro = null;
      return false;
    }
    return true;
  }

  drag(dx: number, dy: number): void {
    this.stopIntro();
    this.state.theta -= dx * DRAG_THETA;
    this.state.phi = clamp(this.state.phi - dy * DRAG_PHI, this.limits.phiMin, this.limits.phiMax);
  }

  zoom(deltaY: number): void {
    this.stopIntro();
    this.state.r = clamp(this.state.r * (1 + deltaY * WHEEL), this.limits.rMin, this.limits.rMax);
  }

  reset(): void {
    this.stopIntro();
    Object.assign(this.state, this.home);
  }

  /** A new home (the city grew or shrank); the current view is kept within the new limits. */
  setHome(home: OrbitState): void {
    this.home = { ...home };
    this.limits = limitsFor(home);
    if (this.intro !== null) this.intro.from = { ...home, r: home.r * INTRO_FROM_RATIO };
    else this.state.r = clamp(this.state.r, this.limits.rMin, this.limits.rMax);
  }
}

export interface OrbitInput {
  /** The camera moved: render. */
  changed(): void;
  /** Pointer at client coordinates, or null when it left the canvas. */
  hover(clientX: number, clientY: number): void;
  leave(): void;
  click(clientX: number, clientY: number): void;
  /** Escape. */
  clear(): void;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/**
 * Drag to orbit, wheel to zoom (non-passive), R to reset, Escape to clear,
 * hover and click on `canvas`. Returns the function that removes every listener.
 */
export function bindOrbit(canvas: HTMLElement, orbit: Orbit, input: OrbitInput): () => void {
  let drag: { x: number; y: number; moved: boolean } | null = null;
  const controller = new AbortController();
  const { signal } = controller;

  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, moved: false };
      canvas.setPointerCapture(event.pointerId);
    },
    { signal },
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      if (drag !== null) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > CLICK_SLOP) drag.moved = true;
        orbit.drag(dx, dy);
        drag.x = event.clientX;
        drag.y = event.clientY;
        input.changed();
        return;
      }
      input.hover(event.clientX, event.clientY);
    },
    { signal },
  );
  canvas.addEventListener(
    'pointerup',
    (event) => {
      if (drag !== null && !drag.moved) input.click(event.clientX, event.clientY);
      drag = null;
    },
    { signal },
  );
  canvas.addEventListener(
    'pointerleave',
    () => {
      drag = null;
      input.leave();
    },
    { signal },
  );
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      orbit.zoom(event.deltaY);
      input.changed();
    },
    { passive: false, signal },
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
      if (event.key === 'r' || event.key === 'R') {
        orbit.reset();
        input.changed();
      } else if (event.key === 'Escape') {
        input.clear();
      }
    },
    { signal },
  );
  return () => {
    controller.abort();
  };
}
