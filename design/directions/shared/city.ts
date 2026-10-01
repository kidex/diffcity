// From a Report to a city: lots per package, a building per file, a floor per
// symbol. Presentational only: status, verdict, tier 1 and the path are read
// from the Report as they are. The layout is deterministic: the same Report
// always gives the same coordinates, so live updates would not make it jump.

import type { File, Finding, Package, Report, Status, Symbol, Verdict } from '../../../src/core/report/types.js';

export type { Status, Verdict };

/** Floor height and the gap between floors, in world units (from the mockup). */
export const FLOOR_H = 0.5;
export const FLOOR_GAP = 0.06;
const FLOOR_STEP = FLOOR_H + FLOOR_GAP;

/** Spacing, in world units. */
const LOT_PAD = 0.75;
const LOT_LABEL_STRIP = 0.7;
const BUILDING_GAP = 0.8;
const STREET = 1.6;

export const STATUSES: readonly Status[] = ['add', 'mod', 'sig', 'del', 'same'];
export const CHANGE_STATUSES: readonly Exclude<Status, 'same'>[] = ['add', 'mod', 'sig', 'del'];
export const VERDICTS: readonly Verdict[] = ['eyes', 'risky', 'spec', 'ok', 'same'];

export const VERDICT_LABEL: Readonly<Record<Verdict, string>> = {
  eyes: 'Needs your eyes',
  risky: 'Risky',
  spec: 'Outside the spec',
  ok: 'Reviewed, fine',
  same: 'Untouched',
};

export const STATUS_LABEL: Readonly<Record<Status, string>> = {
  add: 'Added',
  mod: 'Modified',
  sig: 'Signature changed',
  del: 'Removed',
  same: 'Untouched',
};

export interface CityFloor {
  index: number;
  symbol: Symbol;
  status: Status;
  /** Bottom and top of the floor slab. */
  y0: number;
  y1: number;
}

export interface CityBuilding {
  id: string;
  file: File;
  pkg: Package;
  /** The file name without its directory. */
  name: string;
  touched: boolean;
  verdict: Verdict;
  tier1: boolean;
  /** Centre of the footprint on the ground. */
  x: number;
  z: number;
  /** Square footprint side. */
  side: number;
  height: number;
  floors: CityFloor[];
  findings: Finding[];
  counts: Record<Status, number>;
  /** Execution-path stops that land in this file. */
  stops: number[];
}

export interface CityLot {
  id: string;
  pkg: Package;
  tier1: boolean;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  buildings: CityBuilding[];
}

export interface CityStop {
  order: number;
  building: CityBuilding;
  floor: CityFloor | undefined;
}

export interface City {
  report: Report;
  sampleOverlay: boolean;
  lots: CityLot[];
  buildings: CityBuilding[];
  byId: ReadonlyMap<string, CityBuilding>;
  path: CityStop[];
  bounds: { x0: number; z0: number; x1: number; z1: number; cx: number; cz: number; span: number };
}

/** Footprint side from the number of symbols: a bigger file is a wider tower. */
function sideOf(file: File): number {
  return 1.15 + 0.28 * Math.min(Math.max(file.symbols.length, 1), 6);
}

interface Rect {
  w: number;
  d: number;
}
interface Placed {
  x: number;
  z: number;
}

/**
 * Shelf packing in input order: items fill rows up to `rowWidth`. Returns the
 * top-left corner of each item and the packed size. Input order is kept so a
 * file never swaps place with a neighbour.
 */
function shelf(items: readonly Rect[], rowWidth: number, gap: number): { at: Placed[]; w: number; d: number; rows: number[][] } {
  const at: Placed[] = [];
  const rows: number[][] = [];
  let x = 0;
  let z = 0;
  let rowDepth = 0;
  let width = 0;
  let row: number[] = [];
  items.forEach((item, i) => {
    if (row.length > 0 && x + item.w > rowWidth + 1e-6) {
      rows.push(row);
      row = [];
      z += rowDepth + gap;
      x = 0;
      rowDepth = 0;
    }
    at.push({ x, z });
    row.push(i);
    width = Math.max(width, x + item.w);
    x += item.w + gap;
    rowDepth = Math.max(rowDepth, item.d);
  });
  if (row.length > 0) rows.push(row);
  return { at, w: width, d: z + rowDepth, rows };
}

/**
 * Tries every row width from the widest item to a single row and keeps the
 * packing closest to `aspect` (width / depth) with the least wasted area.
 */
function bestShelf(items: readonly Rect[], gap: number, aspect: number): ReturnType<typeof shelf> {
  const widest = Math.max(...items.map((item) => item.w));
  const total = items.reduce((sum, item) => sum + item.w + gap, -gap);
  const area = items.reduce((sum, item) => sum + item.w * item.d, 0);
  let best = shelf(items, total, gap);
  let bestScore = Number.POSITIVE_INFINITY;
  for (let width = widest; width <= total + 1e-6; width += 0.25) {
    const packed = shelf(items, width, gap);
    const waste = (packed.w * packed.d) / area;
    const score = waste * (1 + Math.abs(Math.log(packed.w / packed.d / aspect)));
    if (score < bestScore - 1e-9) {
      best = packed;
      bestScore = score;
    }
  }
  return best;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function countStatuses(symbols: readonly Symbol[]): Record<Status, number> {
  const counts: Record<Status, number> = { add: 0, mod: 0, sig: 0, del: 0, same: 0 };
  for (const symbol of symbols) counts[symbol.status] += 1;
  return counts;
}

export function buildCity(report: Report, sampleOverlay: boolean): City {
  const findingsByFile = new Map<string, Finding[]>();
  for (const finding of report.findings) {
    const list = findingsByFile.get(finding.file) ?? [];
    list.push(finding);
    findingsByFile.set(finding.file, list);
  }

  // 1. Each lot packs its buildings; sizes only, positions come later.
  // Packages with no touched file go first: the first row is the back of the
  // city from the home camera, so quiet towers never stand in front of the
  // change. A stable sort, so the order stays the Report's otherwise.
  const quiet = (pkg: Package): number => (pkg.files.every((file) => file.status === 'same') ? 0 : 1);
  const packages = [...report.packages].sort((a, b) => quiet(a) - quiet(b));
  const lotPlans = packages.map((pkg) => {
    const sides = pkg.files.map(sideOf);
    const packed = bestShelf(
      sides.map((side) => ({ w: side, d: side })),
      BUILDING_GAP,
      1.25,
    );
    return {
      pkg,
      sides,
      packed,
      w: packed.w + LOT_PAD * 2,
      d: packed.d + LOT_PAD + LOT_LABEL_STRIP,
    };
  });

  // 2. Lots pack into city blocks; each row is stretched to the widest row and
  // each lot to its row's depth, so streets run straight.
  const city = bestShelf(
    lotPlans.map((plan) => ({ w: plan.w, d: plan.d })),
    STREET,
    1.6,
  );
  const lots: CityLot[] = [];
  const buildings: CityBuilding[] = [];
  for (const row of city.rows) {
    const plans = row.map((i) => ({ plan: lotPlans[i], at: city.at[i] }));
    const rowWidth = plans.reduce((sum, { plan }) => sum + (plan?.w ?? 0), STREET * (plans.length - 1));
    const extra = (city.w - rowWidth) / plans.length;
    const depth = Math.max(...plans.map(({ plan }) => plan?.d ?? 0));
    let x = 0;
    for (const { plan, at } of plans) {
      if (plan === undefined || at === undefined) continue;
      const w = plan.w + extra;
      const lot: CityLot = {
        id: plan.pkg.id,
        pkg: plan.pkg,
        tier1: plan.pkg.tier1,
        x0: x,
        z0: at.z,
        x1: x + w,
        z1: at.z + depth,
        buildings: [],
      };
      // Centre the packed buildings in the space above the label strip.
      const offX = lot.x0 + (w - plan.packed.w) / 2;
      const offZ = lot.z0 + (depth - LOT_LABEL_STRIP - plan.packed.d) / 2;
      plan.pkg.files.forEach((file, i) => {
        const side = plan.sides[i] ?? 1;
        const spot = plan.packed.at[i] ?? { x: 0, z: 0 };
        let y = 0;
        const floors = file.symbols.map((symbol, index) => {
          const floor: CityFloor = { index, symbol, status: symbol.status, y0: y, y1: y + FLOOR_H };
          y += FLOOR_STEP;
          return floor;
        });
        const building: CityBuilding = {
          id: file.id,
          file,
          pkg: plan.pkg,
          name: baseName(file.path),
          touched: file.status !== 'same',
          verdict: file.verdict,
          tier1: plan.pkg.tier1,
          x: offX + spot.x + side / 2,
          z: offZ + spot.z + side / 2,
          side,
          height: Math.max(floors.length * FLOOR_STEP - FLOOR_GAP, FLOOR_H),
          floors,
          findings: findingsByFile.get(file.path) ?? [],
          counts: countStatuses(file.symbols),
          stops: [],
        };
        lot.buildings.push(building);
        buildings.push(building);
      });
      lots.push(lot);
      x += w + STREET;
    }
  }

  const byId = new Map(buildings.map((building) => [building.id, building]));
  const path: CityStop[] = [];
  for (const step of [...report.steps].sort((a, b) => a.order - b.order)) {
    const building = byId.get(step.fileId);
    if (building === undefined) continue;
    building.stops.push(step.order);
    path.push({ order: step.order, building, floor: building.floors.find((floor) => floor.symbol.id === step.symbolId) });
  }

  const x0 = Math.min(...lots.map((lot) => lot.x0));
  const x1 = Math.max(...lots.map((lot) => lot.x1));
  const z0 = Math.min(...lots.map((lot) => lot.z0));
  const z1 = Math.max(...lots.map((lot) => lot.z1));
  return {
    report,
    sampleOverlay,
    lots,
    buildings,
    byId,
    path,
    bounds: { x0, z0, x1, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, span: Math.max(x1 - x0, z1 - z0) },
  };
}

/** The floor that holds a finding's symbol, or the roof when it has none. */
export function findingFloor(building: CityBuilding, finding: Finding): CityFloor | undefined {
  return finding.symbolId === undefined ? undefined : building.floors.find((floor) => floor.symbol.id === finding.symbolId);
}
