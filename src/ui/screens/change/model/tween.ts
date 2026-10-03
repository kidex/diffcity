// The live-update tween (ADR-026): buildings that exist in both Reports
// (same file id) move and grow from their old place to their new one, new
// buildings rise from the ground, removed ones sink. A pure function of two
// cities and a progress, so it is unit-tested in Node; the scene draws the
// city it returns on every frame of the 400 ms.

import type { City, CityBuilding } from './city.js';

/** Duration of a live-update tween, ms. */
export const TWEEN_MS = 400;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Ease-out cubic, as the camera intro. */
export const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** `building` with its height (and so every floor) scaled by `k`; at least a sliver, so no box collapses to nothing. */
function scaled(building: CityBuilding, k: number): CityBuilding {
  const s = Math.max(k, 0.001);
  return {
    ...building,
    height: building.height * s,
    floors: building.floors.map((floor) => ({ ...floor, y0: floor.y0 * s, y1: floor.y1 * s })),
  };
}

/**
 * The city at progress `t` (0 to 1, already eased) between `from` and `to`:
 * the buildings of `to`, moved and scaled; then the buildings only `from`
 * has, sinking. Indices follow the returned array. At 1 the result has the
 * buildings of `to` exactly as they are.
 */
export function tweenCity(from: City, to: City, t: number): City {
  if (t >= 1) return to;
  const buildings: CityBuilding[] = [];
  const add = (building: CityBuilding): void => {
    buildings.push({ ...building, index: buildings.length });
  };
  for (const target of to.buildings) {
    const before = from.byId.get(target.id);
    if (before === undefined) {
      add(scaled(target, t));
      continue;
    }
    const height = lerp(before.height, target.height, t);
    const grown = scaled(target, target.height === 0 ? 1 : height / target.height);
    add({ ...grown, x: lerp(before.x, target.x, t), z: lerp(before.z, target.z, t), side: lerp(before.side, target.side, t) });
  }
  for (const gone of from.buildings) {
    if (!to.byId.has(gone.id)) add(scaled(gone, 1 - t));
  }
  return { ...to, buildings, byId: new Map(buildings.map((building) => [building.id, building])) };
}

/** Whether `to` differs from `from` in a way the eye can see: another set of buildings, or one moved or resized. */
export function needsTween(from: City, to: City): boolean {
  if (from.buildings.length !== to.buildings.length) return true;
  return to.buildings.some((building) => {
    const before = from.byId.get(building.id);
    return (
      before === undefined ||
      Math.abs(before.x - building.x) > 1e-6 ||
      Math.abs(before.z - building.z) > 1e-6 ||
      Math.abs(before.side - building.side) > 1e-6 ||
      Math.abs(before.height - building.height) > 1e-6
    );
  });
}
