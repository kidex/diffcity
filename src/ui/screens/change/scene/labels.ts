// Roof labels as HTML pinned to 3D points (CSS2DRenderer, ADR-026): the
// holographic verdict tag over the file name, above touched buildings, as
// crisp as the page at any zoom. At most MAX_LABELS, the most important first
// (labelledBuildings). Labels live in their own scene so the CSS renderer
// never walks the city. Once the camera rests, a label whose anchor is hidden
// behind another building fades out, and so does a label that would overlap
// a more important one on screen; hover and selection always show theirs.

import { Scene, Vector3 } from 'three';
import type { Camera } from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

import { h } from '../../../shared/dom.js';
import { VERDICT_LABEL } from '../../../shared/format.js';
import { verdictToken } from '../../../shared/tokens.js';
import type { City, CityBuilding } from '../model/city.js';
import { labelledBuildings } from '../model/city.js';
import type { Picker } from './picking.js';

/** Height of the label anchor above the roof: higher on a beam for eyes and risky. */
export function labelLift(building: CityBuilding): number {
  return building.verdict === 'eyes' || building.verdict === 'risky' ? 1.05 : 0.3;
}

function roofLabel(building: CityBuilding): HTMLElement {
  const root = h(
    'div',
    {
      class: `roof v-${building.verdict}${building.tier1 ? ' tier1' : ''}`,
      'data-testid': 'roof-label',
      'data-building': building.id,
    },
    h('div', { class: 'badge' }, h('i', { 'aria-hidden': 'true' }), h('span', null, VERDICT_LABEL[building.verdict])),
    h('div', { class: 'file' }, building.name),
  );
  root.style.setProperty('--c', `var(${verdictToken(building.verdict)})`);
  return root;
}

interface Entry {
  building: CityBuilding;
  object: CSS2DObject;
  element: HTMLElement;
}

export class LabelLayer {
  private readonly renderer = new CSS2DRenderer();
  private readonly scene = new Scene();
  private entries: Entry[] = [];
  private readonly anchor = new Vector3();

  constructor(container: HTMLElement) {
    const element = this.renderer.domElement;
    element.className = 'labels';
    element.setAttribute('aria-hidden', 'true');
    container.append(element);
  }

  get count(): number {
    return this.entries.length;
  }

  /** Replaces the labels with those of `city`. */
  setCity(city: City): void {
    this.clear();
    for (const building of labelledBuildings(city)) {
      const element = roofLabel(building);
      const object = new CSS2DObject(element);
      object.position.set(building.x, building.height + labelLift(building), building.z);
      object.center.set(0.5, 1);
      this.scene.add(object);
      this.entries.push({ building, object, element });
    }
  }

  /** Toggles a state class (is-hover, is-selected) on a building's label. */
  toggle(id: string | null, className: string, on: boolean): void {
    if (id === null) return;
    for (const entry of this.entries) if (entry.building.id === id) entry.element.classList.toggle(className, on);
  }

  /**
   * Fades the labels whose anchor another building hides from `camera`, and
   * those that overlap a more important label on screen. Call it after a
   * render, when the labels are in place.
   */
  updateOcclusion(camera: Camera, picker: Picker): void {
    const kept: DOMRect[] = [];
    for (const entry of this.entries) {
      this.anchor.copy(entry.object.position);
      const occluded = picker.blocked(camera.position, this.anchor, entry.building);
      entry.element.classList.toggle('is-occluded', occluded);
      if (occluded || entry.element.style.display === 'none') {
        entry.element.classList.remove('is-crowded');
        continue;
      }
      const rect = entry.element.getBoundingClientRect();
      const crowded = kept.some((other) => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top);
      entry.element.classList.toggle('is-crowded', crowded);
      if (!crowded) kept.push(rect);
    }
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }

  render(camera: Camera): void {
    this.renderer.render(this.scene, camera);
  }

  private clear(): void {
    for (const entry of this.entries) {
      entry.object.removeFromParent();
      entry.element.remove();
    }
    this.entries = [];
  }

  dispose(): void {
    this.clear();
    this.renderer.domElement.remove();
  }
}
