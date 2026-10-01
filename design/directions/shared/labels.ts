// HTML labels pinned to 3D points (CSS2DRenderer): text stays as crisp as the
// rest of the page at any DPR and zoom, and each direction styles it in CSS.
// Labels hidden behind a building fade out, so the city does not get cluttered
// with names of towers you cannot see.

import { Raycaster, Vector3 } from 'three';
import type { Camera, Object3D, Scene } from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export interface LabelOptions {
  /** Building id, so hover, selection and filters can style the label. */
  building?: string;
  /** Which point of the element sits on the anchor: (0.5, 1) is bottom centre. */
  center?: readonly [number, number];
  /** Fade the label when a building stands between it and the camera. */
  occlude?: boolean;
}

interface Entry {
  object: CSS2DObject;
  element: HTMLElement;
  building: string | undefined;
  occlude: boolean;
}

export class LabelLayer {
  readonly renderer: CSS2DRenderer;
  private readonly entries: Entry[] = [];
  private readonly ray = new Raycaster();
  private readonly world = new Vector3();
  private readonly dir = new Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new CSS2DRenderer();
    const el = this.renderer.domElement;
    el.className = 'labels';
    container.appendChild(el);
  }

  /** Pins `element` at `position` in the parent's space. */
  add(parent: Object3D, element: HTMLElement, position: Vector3, options: LabelOptions = {}): CSS2DObject {
    const object = new CSS2DObject(element);
    object.position.copy(position);
    const [cx, cy] = options.center ?? [0.5, 0.5];
    object.center.set(cx, cy);
    if (options.building !== undefined) element.dataset['building'] = options.building;
    parent.add(object);
    this.entries.push({ object, element, building: options.building, occlude: options.occlude ?? false });
    return object;
  }

  /** Toggles a class on every label of a building. */
  toggle(building: string, className: string, on: boolean): void {
    for (const entry of this.entries) if (entry.building === building) entry.element.classList.toggle(className, on);
  }

  /** Marks labels whose anchor is hidden behind any of `blockers`. */
  updateOcclusion(camera: Camera, blockers: Object3D[]): void {
    for (const entry of this.entries) {
      if (!entry.occlude) continue;
      entry.object.getWorldPosition(this.world);
      this.dir.copy(this.world).sub(camera.position);
      const distance = this.dir.length();
      this.ray.set(camera.position, this.dir.normalize());
      this.ray.far = distance - 0.05;
      const hit = this.ray.intersectObjects(blockers, false)[0];
      const hidden = hit !== undefined && hit.object.userData['building'] !== entry.building;
      entry.element.classList.toggle('is-occluded', hidden);
    }
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }

  render(scene: Scene, camera: Camera): void {
    this.renderer.render(scene, camera);
  }
}

/** A tiny element factory: tag, class names, children (strings become text). */
export function h(tag: string, className: string, ...children: (Node | string)[]): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  for (const child of children) el.append(child);
  return el;
}
