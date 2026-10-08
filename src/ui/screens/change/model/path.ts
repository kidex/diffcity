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

/** Whether two lists of stops draw the same path: the same steps on the same buildings, in the same order. */
export function samePath(a: readonly PathStop[], b: readonly PathStop[]): boolean {
  return (
    a.length === b.length &&
    a.every((stop, i) => {
      const other = b[i];
      return other !== undefined && stop.order === other.order && stop.building.id === other.building.id && stop.nth === other.nth;
    })
  );
}

/** The buildings the tube passes through: the stops, with a building that follows itself counted once. */
export function pathPoints(stops: readonly PathStop[]): CityBuilding[] {
  return stops.map((stop) => stop.building).filter((building, i, all) => i === 0 || all[i - 1] !== building);
}

/** The grid of the stop-number atlas: `columns` x `rows` cells of `cell` px, never wider or taller than `maxTexture`. */
export interface AtlasGrid {
  columns: number;
  rows: number;
  cell: number;
}

/** Fits `count` numbers into a texture of at most `maxTexture` px a side: wide rows first, smaller cells only when even a square grid is too big. */
export function atlasGrid(count: number, maxTexture: number, cell = 128): AtlasGrid {
  const n = Math.max(count, 1);
  for (let size = cell; size > 1; size = Math.floor(size * 0.8)) {
    const columns = Math.min(n, Math.max(1, Math.floor(maxTexture / size)));
    const rows = Math.ceil(n / columns);
    if (rows * size <= maxTexture) return { columns, rows, cell: size };
  }
  const columns = Math.min(n, maxTexture);
  return { columns, rows: Math.ceil(n / columns), cell: 1 };
}
