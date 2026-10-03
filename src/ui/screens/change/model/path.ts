// The reading path (SPEC.md section 6): the Report's steps as stops on the
// city, in order. Pure: no three.js, no DOM.

import type { Step } from '../../../../core/report/types.js';
import type { City, CityBuilding } from './city.js';

export interface PathStop {
  /** The step's number, as drawn in its ring. */
  order: number;
  building: CityBuilding;
  /** How many earlier stops are on the same building: the rings of one building sit side by side. */
  nth: number;
}

/** The steps that land on a building of the city, by order. Steps on files the city does not have are left out. */
export function pathStops(city: City, steps: readonly Step[]): PathStop[] {
  const seen = new Map<string, number>();
  const stops: PathStop[] = [];
  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    const building = city.byId.get(step.fileId);
    if (building === undefined) continue;
    const nth = seen.get(building.id) ?? 0;
    seen.set(building.id, nth + 1);
    stops.push({ order: step.order, building, nth });
  }
  return stops;
}

/** The buildings the tube passes through: the stops, with a building that follows itself counted once. */
export function pathPoints(stops: readonly PathStop[]): CityBuilding[] {
  return stops.map((stop) => stop.building).filter((building, i, all) => i === 0 || all[i - 1] !== building);
}
