// Picking against the buildings' boxes instead of the instanced meshes: one
// ray-box test per building (a few thousand at most) finds the building under
// the pointer and the floor from the hit height. The same boxes answer the
// label occlusion test.

import { Box3, Ray, Raycaster, Vector2, Vector3 } from 'three';
import type { Camera } from 'three';

import type { City, CityBuilding, CityFloor } from '../model/city.js';
import { FLOOR_STEP, INSET } from '../model/city.js';

export interface Pick {
  building: CityBuilding;
  floor: CityFloor | undefined;
}

export class Picker {
  private readonly boxes: Box3[];
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly hit = new Vector3();
  private readonly ray = new Ray();
  private readonly target = new Vector3();

  constructor(private readonly city: City) {
    this.boxes = city.buildings.map((building) => {
      const half = building.side / 2 - INSET;
      return new Box3(new Vector3(building.x - half, 0, building.z - half), new Vector3(building.x + half, building.height, building.z + half));
    });
  }

  /** The building and floor under the client point, or null. */
  pick(clientX: number, clientY: number, canvas: HTMLElement, camera: Camera): Pick | null {
    const rect = canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, camera);
    const { ray } = this.raycaster;
    let building: CityBuilding | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestY = 0;
    for (let i = 0; i < this.boxes.length; i += 1) {
      const box = this.boxes[i];
      if (box === undefined || ray.intersectBox(box, this.hit) === null) continue;
      const distance = this.hit.distanceToSquared(ray.origin);
      if (distance < bestDistance) {
        bestDistance = distance;
        building = this.city.buildings[i];
        bestY = this.hit.y;
      }
    }
    if (building === undefined) return null;
    const index = Math.min(building.floors.length - 1, Math.max(0, Math.floor(bestY / FLOOR_STEP)));
    return { building, floor: building.floors[index] };
  }

  /** True when a building other than `own` stands between `from` and `to`. */
  blocked(from: Vector3, to: Vector3, own: CityBuilding): boolean {
    this.target.copy(to).sub(from);
    const distance = this.target.length();
    this.ray.set(from, this.target.normalize());
    for (let i = 0; i < this.boxes.length; i += 1) {
      if (i === own.index) continue;
      const box = this.boxes[i];
      if (box === undefined || this.ray.intersectBox(box, this.hit) === null) continue;
      if (this.hit.distanceTo(from) < distance - 0.05) return true;
    }
    return false;
  }
}

/** Client coordinates of a world point, or null when it is behind the camera. */
export function projectToClient(point: Vector3, camera: Camera, canvas: HTMLElement): { x: number; y: number } | null {
  const projected = point.clone().project(camera);
  if (projected.z > 1) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + ((projected.x + 1) / 2) * rect.width, y: rect.top + ((1 - projected.y) / 2) * rect.height };
}
