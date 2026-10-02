// From a Report to a city (ADR-026): a lot per package, a building per file, a
// floor per symbol. Presentational only: status, verdict and tier 1 are read
// from the Report as they are, nothing is computed here that belongs in
// src/core. No three.js and no DOM, so the layout is unit-tested in Node.
//
// The layout is deterministic: the same Report always gives the same
// coordinates. It is also stable under live updates, as far as a packing can
// be: a package's buildings depend only on that package, lots keep the
// Report's order, and the city's row width moves in coarse steps, so adding a
// file moves only its own lot and the lots after it.

import type { File, Package, Report, Status, Verdict } from '../../../../core/report/types.js';

/** Floor height and the gap between floors, in world units (from the mockup). */
export const FLOOR_H = 0.5;
export const FLOOR_GAP = 0.06;
export const FLOOR_STEP = FLOOR_H + FLOOR_GAP;
/** Space between a building's cell and its glass, on each side. */
export const INSET = 0.2;

/** Spacing, in world units. */
const LOT_PAD = 0.75;
/** The strip at the front of a lot that holds its name. */
export const LOT_LABEL_STRIP = 0.7;
const BUILDING_GAP = 0.8;
export const STREET = 1.6;
/** City rows are a multiple of this wide, so one more file rarely changes them. */
const ROW_QUANTUM = 8;
/** Width / depth the lots and the city aim for. */
const LOT_ASPECT = 1.25;
const CITY_ASPECT = 1.6;

/** Footprint side: grows with the symbol count up to six symbols. */
export const SIDE_MIN = 1.15;
export const SIDE_STEP = 0.28;
export const SIDE_MAX_SYMBOLS = 6;

export interface CityFloor {
  /** 0 is the ground floor. */
  index: number;
  /** Null for the single floor of a file without symbols (non-code, binary, import-only). */
  symbolId: string | null;
  name: string;
  status: Status;
  /** Bottom and top of the floor slab. */
  y0: number;
  y1: number;
}

export interface CityBuilding {
  id: string;
  /** Position in `City.buildings`. */
  index: number;
  file: File;
  lot: number;
  /** The file name without its directory. */
  name: string;
  touched: boolean;
  verdict: Verdict;
  tier1: boolean;
  /** Centre of the footprint on the ground. */
  x: number;
  z: number;
  /** Square cell side; the glass is `side - 2 * INSET`. */
  side: number;
  height: number;
  floors: CityFloor[];
  counts: Record<Status, number>;
  /** Floors whose status is not `same`. */
  changed: number;
}

export interface CityLot {
  id: string;
  /** Position in `City.lots`. */
  index: number;
  pkg: Package;
  tier1: boolean;
  /** The package has at least one touched file. */
  touched: boolean;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Row of the city, 0 at the back (far from the home camera). */
  row: number;
  buildings: CityBuilding[];
}

export interface CityBounds {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  cx: number;
  cz: number;
  /** The larger of the two sides. */
  span: number;
}

export interface City {
  lots: CityLot[];
  buildings: CityBuilding[];
  byId: ReadonlyMap<string, CityBuilding>;
  bounds: CityBounds;
  /** Width the lot rows were packed into. */
  rowWidth: number;
}

/** Footprint side from the number of symbols: a bigger file is a wider tower. */
export function sideOf(symbolCount: number): number {
  return SIDE_MIN + SIDE_STEP * Math.min(Math.max(symbolCount, 1), SIDE_MAX_SYMBOLS);
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Floors bottom to top in source order: by range start, then end, then id. */
export function floorsOf(file: File): CityFloor[] {
  if (file.symbols.length === 0) {
    return [{ index: 0, symbolId: null, name: baseName(file.path), status: file.status, y0: 0, y1: FLOOR_H }];
  }
  const symbols = [...file.symbols].sort(
    (a, b) => a.range.start - b.range.start || a.range.end - b.range.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return symbols.map((symbol, index) => ({
    index,
    symbolId: symbol.id,
    name: symbol.name,
    status: symbol.status,
    y0: index * FLOOR_STEP,
    y1: index * FLOOR_STEP + FLOOR_H,
  }));
}

interface Shelf {
  /** Top-left corner of each item. */
  at: { x: number; z: number }[];
  /** Row of each item. */
  rows: number[];
  w: number;
  d: number;
}

/** Shelf packing in input order into rows of at most `rowWidth`. */
function shelf(sizes: readonly { w: number; d: number }[], rowWidth: number, gap: number, breakBefore = -1): Shelf {
  const at: Shelf['at'] = [];
  const rows: number[] = [];
  let x = 0;
  let z = 0;
  let row = 0;
  let rowDepth = 0;
  let width = 0;
  let inRow = 0;
  sizes.forEach((size, i) => {
    if (inRow > 0 && (x + size.w > rowWidth + 1e-6 || i === breakBefore)) {
      z += rowDepth + gap;
      x = 0;
      rowDepth = 0;
      inRow = 0;
      row += 1;
    }
    at.push({ x, z });
    rows.push(row);
    width = Math.max(width, x + size.w);
    x += size.w + gap;
    rowDepth = Math.max(rowDepth, size.d);
    inRow += 1;
  });
  return { at, rows, w: width, d: z + rowDepth };
}

/** Row width for `sizes`: the side of a rectangle of the target aspect, rounded up to `quantum`. */
function rowWidthFor(sizes: readonly { w: number; d: number }[], gap: number, aspect: number, quantum: number): number {
  const widest = Math.max(...sizes.map((size) => size.w));
  const area = sizes.reduce((sum, size) => sum + (size.w + gap) * (size.d + gap), 0);
  const ideal = Math.sqrt(area * aspect);
  return Math.max(widest, Math.ceil(ideal / quantum - 1e-9) * quantum);
}

function countStatuses(floors: readonly CityFloor[]): Record<Status, number> {
  const counts: Record<Status, number> = { add: 0, mod: 0, sig: 0, del: 0, same: 0 };
  for (const floor of floors) counts[floor.status] += 1;
  return counts;
}

interface LotPlan {
  pkg: Package;
  touched: boolean;
  sides: number[];
  floors: CityFloor[][];
  packed: Shelf;
  w: number;
  d: number;
}

function planLot(pkg: Package): LotPlan {
  const floors = pkg.files.map(floorsOf);
  const sides = pkg.files.map((file) => sideOf(file.symbols.length));
  const sizes = sides.map((side) => ({ w: side, d: side }));
  const packed =
    sizes.length === 0 ? { at: [], rows: [], w: 0, d: 0 } : shelf(sizes, rowWidthFor(sizes, BUILDING_GAP, LOT_ASPECT, 1), BUILDING_GAP);
  return {
    pkg,
    touched: pkg.files.some((file) => file.status !== 'same'),
    sides,
    floors,
    packed,
    w: Math.max(packed.w, SIDE_MIN) + LOT_PAD * 2,
    d: Math.max(packed.d, SIDE_MIN) + LOT_PAD + LOT_LABEL_STRIP,
  };
}

const EMPTY_BOUNDS: CityBounds = { x0: 0, z0: 0, x1: 0, z1: 0, cx: 0, cz: 0, span: 1 };

/**
 * Lays the Report out. Packages with no touched file come first and fill
 * their own rows at the back of the city (low z, far from the home camera),
 * so quiet towers never stand in front of the change; the rest keep the
 * Report's order. Buildings fill their lot in the Report's file order.
 */
export function buildCity(report: Report): City {
  const plans = report.packages.map(planLot);
  const ordered = [...plans.filter((plan) => !plan.touched), ...plans.filter((plan) => plan.touched)];
  const quietCount = plans.length - plans.filter((plan) => plan.touched).length;
  if (ordered.length === 0) return { lots: [], buildings: [], byId: new Map(), bounds: EMPTY_BOUNDS, rowWidth: 0 };

  const sizes = ordered.map((plan) => ({ w: plan.w, d: plan.d }));
  const rowWidth = rowWidthFor(sizes, STREET, CITY_ASPECT, ROW_QUANTUM);
  const city = shelf(sizes, rowWidth, STREET, quietCount > 0 && quietCount < ordered.length ? quietCount : -1);

  // Each lot is stretched to its row's depth, so the streets between rows run straight.
  const rowDepth = new Map<number, number>();
  ordered.forEach((plan, i) => {
    const row = city.rows[i] ?? 0;
    rowDepth.set(row, Math.max(rowDepth.get(row) ?? 0, plan.d));
  });

  const lots: CityLot[] = [];
  const buildings: CityBuilding[] = [];
  ordered.forEach((plan, i) => {
    const at = city.at[i] ?? { x: 0, z: 0 };
    const row = city.rows[i] ?? 0;
    const lot: CityLot = {
      id: plan.pkg.id,
      index: lots.length,
      pkg: plan.pkg,
      tier1: plan.pkg.tier1,
      touched: plan.touched,
      x0: at.x,
      z0: at.z,
      x1: at.x + plan.w,
      z1: at.z + (rowDepth.get(row) ?? plan.d),
      row,
      buildings: [],
    };
    // Buildings start at the back-left corner; the stretch goes to the label strip.
    const offX = lot.x0 + LOT_PAD;
    const offZ = lot.z0 + LOT_PAD;
    plan.pkg.files.forEach((file, f) => {
      const side = plan.sides[f] ?? SIDE_MIN;
      const spot = plan.packed.at[f] ?? { x: 0, z: 0 };
      const floors = plan.floors[f] ?? [];
      const counts = countStatuses(floors);
      const building: CityBuilding = {
        id: file.id,
        index: buildings.length,
        file,
        lot: lot.index,
        name: baseName(file.path),
        touched: file.status !== 'same',
        verdict: file.verdict,
        tier1: plan.pkg.tier1,
        x: offX + spot.x + side / 2,
        z: offZ + spot.z + side / 2,
        side,
        height: floors.length * FLOOR_STEP - FLOOR_GAP,
        floors,
        counts,
        changed: floors.length - counts.same,
      };
      lot.buildings.push(building);
      buildings.push(building);
    });
    lots.push(lot);
  });

  const x0 = Math.min(...lots.map((lot) => lot.x0));
  const x1 = Math.max(...lots.map((lot) => lot.x1));
  const z0 = Math.min(...lots.map((lot) => lot.z0));
  const z1 = Math.max(...lots.map((lot) => lot.z1));
  return {
    lots,
    buildings,
    byId: new Map(buildings.map((building) => [building.id, building])),
    bounds: { x0, z0, x1, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, span: Math.max(x1 - x0, z1 - z0, 1) },
    rowWidth,
  };
}

/** Labels shown at most, whatever the size of the change (ADR-026). */
export const MAX_LABELS = 120;

const VERDICT_RANK: Readonly<Record<Verdict, number>> = { eyes: 0, risky: 1, spec: 2, ok: 3, same: 4 };

/**
 * The touched buildings that get a label, most important first: verdict
 * (eyes, risky, outside the spec, fine), then tier 1, then the number of
 * changed floors, then the Report's order. Untouched buildings never get one.
 */
export function labelledBuildings(city: City, max = MAX_LABELS): CityBuilding[] {
  return city.buildings
    .filter((building) => building.touched)
    .sort(
      (a, b) =>
        VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
        Number(b.tier1) - Number(a.tier1) ||
        b.changed - a.changed ||
        a.index - b.index,
    )
    .slice(0, max);
}
