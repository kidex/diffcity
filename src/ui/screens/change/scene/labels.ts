// Roof labels as HTML pinned to 3D points (CSS2DRenderer, ADR-026): the
// holographic verdict tag over the file name, above touched buildings, as
// crisp as the page at any zoom. At most MAX_LABELS, in ADR-026's priority
// (labelledBuildings): selected and hovered, then eyes and risky, then the
// other touched files nearest the camera. Labels live in their own scene so
// the CSS renderer never walks the city. Once the camera rests, the set is
// re-ranked by distance, a label whose anchor is hidden behind another
// building fades out, and so does a label that would overlap one of higher
// priority on screen; hover and selection always show theirs.

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
  /** In priority order. */
  private entries: Entry[] = [];
  private city: City | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  /** Ids of the buildings the filters dim. */
  private dimmed: ReadonlySet<string> = new Set();
  private tweening = false;
  private eye: Vector3 | null = null;
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

  /** Ids of the labelled buildings, in priority order. */
  get ids(): string[] {
    return this.entries.map((entry) => entry.building.id);
  }

  /** Replaces the labels with those of `city`, ranked from the last camera position. */
  setCity(city: City): void {
    this.clear();
    this.city = city;
    this.arrange();
  }

  get dimmedIds(): ReadonlySet<string> {
    return this.dimmed;
  }

  /** Fades the labels of the buildings the filters dim (ids), and shows or hides every label while a live-update tween plays. */
  setDimmed(ids: ReadonlySet<string>, tweening: boolean): void {
    this.dimmed = ids;
    this.tweening = tweening;
    for (const entry of this.entries) this.mark(entry);
  }

  private mark(entry: Entry): void {
    entry.element.classList.toggle('is-dim', this.dimmed.has(entry.building.id));
    entry.element.classList.toggle('is-tweening', this.tweening);
  }

  /**
   * Sets the selected and hovered buildings. Returns true when the labelled
   * set or its order changed, so the caller re-runs updateOcclusion.
   */
  setFocus(selected: string | null, hovered: string | null): boolean {
    this.selected = selected;
    this.hovered = hovered;
    return this.arrange();
  }

  /**
   * Re-ranks the labels from `camera` (call it when the camera rests), then
   * fades those whose anchor another building hides and those that overlap a
   * label of higher priority on screen. Call it after a render, so the labels
   * are in place.
   */
  updateOcclusion(camera: Camera, picker: Picker): void {
    this.eye = (this.eye ?? new Vector3()).copy(camera.position);
    if (this.arrange()) this.render(camera);
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

  /** Brings the entries in line with labelledBuildings, reusing the labels that stay. Returns true on a change. */
  private arrange(): boolean {
    if (this.city === null) return false;
    const next = labelledBuildings(this.city, { selected: this.selected, hovered: this.hovered, eye: this.eye });
    const old = new Map(this.entries.map((entry) => [entry.building.id, entry]));
    const entries = next.map((building) => {
      const kept = old.get(building.id);
      if (kept !== undefined) {
        old.delete(building.id);
        return kept;
      }
      const element = roofLabel(building);
      const object = new CSS2DObject(element);
      object.position.set(building.x, building.height + labelLift(building), building.z);
      object.center.set(0.5, 1);
      this.scene.add(object);
      return { building, object, element };
    });
    for (const entry of old.values()) {
      entry.object.removeFromParent();
      entry.element.remove();
    }
    const changed = old.size > 0 || entries.length !== this.entries.length || entries.some((entry, i) => entry !== this.entries[i]);
    this.entries = entries;
    for (const entry of entries) {
      entry.element.classList.toggle('is-selected', entry.building.id === this.selected);
      entry.element.classList.toggle('is-hover', entry.building.id === this.hovered);
      this.mark(entry);
    }
    return changed;
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
    this.city = null;
    this.renderer.domElement.remove();
  }
}
