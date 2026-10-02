// city/* (ADR-026): the change screen's layout from a Report. Deterministic,
// stable when a file is added, quiet packages at the back, floors in source
// order, footprints from the symbol count. Nothing here reads a status or a
// verdict for any purpose but copying it.

import { describe, expect, it } from 'vitest';
import type { File, Package, Report, Status, Symbol } from '../../../src/core/report/types.js';
import type { City, CityBuilding, CityLot } from '../../../src/ui/screens/change/model/city.js';
import goldenJson from '../../fixtures/scenarios/order-discounts/expected.json';
import {
  buildCity,
  FLOOR_H,
  FLOOR_STEP,
  INSET,
  labelledBuildings,
  MAX_LABELS,
  SIDE_MAX_SYMBOLS,
  SIDE_MIN,
  SIDE_STEP,
  sideOf,
} from '../../../src/ui/screens/change/model/city.js';

// The JSON module is typed from its literal content; it is a Report by construction (the golden test).
const golden = (): Report => structuredClone(goldenJson) as unknown as Report;

function symbol(file: string, name: string, status: Status, start: number, end = start + 3): Symbol {
  return { id: `${file}#${name}`, name, kind: 'function', status, range: { start, end } };
}

function file(path: string, symbols: Symbol[], status: Status = symbols.some((s) => s.status !== 'same') ? 'mod' : 'same'): File {
  return { id: path, path, language: 'typescript', status, verdict: status === 'same' ? 'same' : 'ok', inSpec: null, symbols };
}

function pkg(path: string, files: File[], tier1 = false): Package {
  return { id: path, path, tier1, files };
}

function report(packages: Package[]): Report {
  return {
    meta: { repo: 'sample-shop', base: 'main', head: 'abc', commits: 1, generatedAt: '2026-01-01T00:00:00.000Z' },
    packages,
    steps: [],
    findings: [],
    summary: { files: 0, byStatus: { add: 0, mod: 0, sig: 0, del: 0, same: 0 }, byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 }, tier1Files: [] },
  };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}

function building(city: City, id: string): CityBuilding {
  const found = city.byId.get(id);
  if (found === undefined) throw new Error(`no building ${id}`);
  return found;
}

function lotOf(city: City, b: CityBuilding): CityLot {
  return at(city.lots, b.lot);
}

const overlaps = (a: CityBuilding, b: CityBuilding): boolean =>
  Math.abs(a.x - b.x) < (a.side + b.side) / 2 - 1e-6 && Math.abs(a.z - b.z) < (a.side + b.side) / 2 - 1e-6;

describe('city/layout-deterministic', () => {
  it('gives the same city for the same Report, and for a structural copy of it', () => {
    const a = buildCity(golden());
    const b = buildCity(golden());
    const strip = (city: City) => ({
      lots: city.lots.map((lot) => [lot.id, lot.x0, lot.z0, lot.x1, lot.z1, lot.row]),
      buildings: city.buildings.map((item) => [item.id, item.x, item.z, item.side, item.height, item.floors.map((floor) => floor.symbolId)]),
      bounds: city.bounds,
    });
    expect(strip(a)).toEqual(strip(b));
  });

  it('has one lot per package and one building per file, every building inside its lot, none overlapping', () => {
    const source = golden();
    const city = buildCity(source);
    expect(city.lots.map((lot) => lot.id).sort()).toEqual(source.packages.map((p) => p.id).sort());
    expect(city.buildings).toHaveLength(source.packages.reduce((sum, p) => sum + p.files.length, 0));
    for (const item of city.buildings) {
      const lot = lotOf(city, item);
      expect(item.x - item.side / 2).toBeGreaterThanOrEqual(lot.x0);
      expect(item.x + item.side / 2).toBeLessThanOrEqual(lot.x1);
      expect(item.z - item.side / 2).toBeGreaterThanOrEqual(lot.z0);
      expect(item.z + item.side / 2).toBeLessThanOrEqual(lot.z1);
    }
    for (const [i, a] of city.buildings.entries()) {
      for (const b of city.buildings.slice(i + 1)) expect(overlaps(a, b), `${a.id} / ${b.id}`).toBe(false);
    }
    for (const [i, a] of city.lots.entries()) {
      for (const b of city.lots.slice(i + 1)) {
        const apart = a.x1 <= b.x0 || b.x1 <= a.x0 || a.z1 <= b.z0 || b.z1 <= a.z0;
        expect(apart, `${a.id} / ${b.id}`).toBe(true);
      }
    }
  });

  it('copies status, verdict and tier 1 from the Report as they are', () => {
    const source = golden();
    const city = buildCity(source);
    for (const p of source.packages) {
      for (const f of p.files) {
        const item = building(city, f.id);
        expect(item.verdict).toBe(f.verdict);
        expect(item.touched).toBe(f.status !== 'same');
        expect(item.tier1).toBe(p.tier1);
        expect(item.floors.map((floor) => floor.status).sort()).toEqual(f.symbols.map((s) => s.status).sort());
      }
    }
  });

  it('labels touched buildings only, eyes first, at most MAX_LABELS', () => {
    const city = buildCity(golden());
    const labelled = labelledBuildings(city);
    expect(labelled.every((item) => item.touched)).toBe(true);
    expect(labelled).toHaveLength(city.buildings.filter((item) => item.touched).length);
    expect(labelled.slice(0, 2).map((item) => item.verdict)).toEqual(['eyes', 'eyes']);
    expect(labelledBuildings(city, 3)).toHaveLength(3);
    expect(MAX_LABELS).toBe(120);
  });

  it('is empty for a Report without packages', () => {
    const city = buildCity(report([]));
    expect(city.lots).toEqual([]);
    expect(city.buildings).toEqual([]);
  });
});

describe('city/layout-stable-on-add', () => {
  it('adding a file moves no building of another package within its lot, and no lot before the changed one', () => {
    const before = golden();
    const after = golden();
    const target = after.packages.find((p) => p.path === 'src/repo');
    if (target === undefined) throw new Error('src/repo missing from the golden');
    target.files.push(file('src/repo/orders.audit.ts', [symbol('src/repo/orders.audit.ts', 'audit', 'add', 1)], 'add'));

    const a = buildCity(before);
    const b = buildCity(after);
    expect(b.rowWidth).toBe(a.rowWidth);
    expect(b.lots.map((lot) => lot.id)).toEqual(a.lots.map((lot) => lot.id));

    const changedIndex = a.lots.findIndex((lot) => lot.id === 'src/repo');
    for (const lot of a.lots) {
      const next = at(b.lots, lot.index);
      if (lot.index < changedIndex) expect([next.x0, next.z0, next.x1, next.z1]).toEqual([lot.x0, lot.z0, lot.x1, lot.z1]);
      if (lot.id === 'src/repo') continue;
      for (const item of lot.buildings) {
        const moved = building(b, item.id);
        expect([moved.x - next.x0, moved.z - next.z0]).toEqual([item.x - lot.x0, item.z - lot.z0]);
      }
    }
    // Inside the changed lot the old files keep their order.
    const order = (city: City) =>
      at(city.lots, changedIndex)
        .buildings.filter((item) => item.id !== 'src/repo/orders.audit.ts')
        .map((item) => item.id);
    expect(order(b)).toEqual(order(a));
  });
});

describe('city/quiet-packages-back-row', () => {
  it('puts packages without a touched file in rows behind every touched package', () => {
    const city = buildCity(golden());
    const quiet = city.lots.filter((lot) => !lot.touched);
    const touched = city.lots.filter((lot) => lot.touched);
    expect(quiet.map((lot) => lot.id)).toEqual(['src/shared']);
    const front = Math.min(...touched.map((lot) => lot.z0));
    for (const lot of quiet) expect(lot.z1).toBeLessThanOrEqual(front);
    expect(Math.max(...quiet.map((lot) => lot.row))).toBeLessThan(Math.min(...touched.map((lot) => lot.row)));
  });

  it('keeps the Report order among quiet packages and among touched ones', () => {
    const quietA = pkg('lib/a', [file('lib/a/a.ts', [symbol('lib/a/a.ts', 'a', 'same', 1)])]);
    const touched = pkg('app', [file('app/main.ts', [symbol('app/main.ts', 'main', 'mod', 1)])]);
    const quietB = pkg('lib/b', [file('lib/b/b.ts', [symbol('lib/b/b.ts', 'b', 'same', 1)])]);
    const city = buildCity(report([quietA, touched, quietB]));
    expect(city.lots.map((lot) => lot.id)).toEqual(['lib/a', 'lib/b', 'app']);
    expect(at(city.lots, 2).z0).toBeGreaterThanOrEqual(Math.max(at(city.lots, 0).z1, at(city.lots, 1).z1));
  });
});

describe('city/floor-order-by-range', () => {
  it('stacks floors from the ground up in source order: range start, then end, then id', () => {
    const path = 'src/a.ts';
    const shuffled = [
      symbol(path, 'late', 'add', 40),
      symbol(path, 'first', 'same', 1),
      symbol(path, 'zeta', 'mod', 10, 20),
      symbol(path, 'alpha', 'mod', 10, 20),
      symbol(path, 'short', 'del', 10, 12),
    ];
    const city = buildCity(report([pkg('src', [file(path, shuffled)])]));
    const item = building(city, path);
    expect(item.floors.map((floor) => floor.name)).toEqual(['first', 'short', 'alpha', 'zeta', 'late']);
    expect(item.floors.map((floor) => floor.index)).toEqual([0, 1, 2, 3, 4]);
    expect(at(item.floors, 0).y0).toBe(0);
    for (const floor of item.floors) {
      expect(floor.y0).toBeCloseTo(floor.index * FLOOR_STEP);
      expect(floor.y1 - floor.y0).toBeCloseTo(FLOOR_H);
    }
    expect(item.height).toBeCloseTo(5 * FLOOR_STEP - (FLOOR_STEP - FLOOR_H));
  });

  it('gives a file without symbols a single floor in the file status', () => {
    const city = buildCity(report([pkg('assets', [file('assets/logo.svg', [], 'add')])]));
    const item = building(city, 'assets/logo.svg');
    expect(item.floors).toHaveLength(1);
    expect(at(item.floors, 0)).toMatchObject({ symbolId: null, status: 'add', y0: 0, y1: FLOOR_H });
  });
});

describe('city/footprint-from-symbol-count', () => {
  it('widens with each symbol up to the cap, then stays', () => {
    expect(sideOf(0)).toBe(SIDE_MIN + SIDE_STEP);
    expect(sideOf(1)).toBe(SIDE_MIN + SIDE_STEP);
    for (let n = 2; n <= SIDE_MAX_SYMBOLS; n += 1) expect(sideOf(n)).toBeGreaterThan(sideOf(n - 1));
    expect(sideOf(SIDE_MAX_SYMBOLS + 1)).toBe(sideOf(SIDE_MAX_SYMBOLS));
    expect(sideOf(500)).toBe(sideOf(SIDE_MAX_SYMBOLS));
  });

  it('sizes each building from its file’s symbol count, glass inset inside the cell', () => {
    const city = buildCity(golden());
    for (const item of city.buildings) {
      expect(item.side).toBe(sideOf(item.file.symbols.length));
      expect(item.side - INSET * 2).toBeGreaterThan(0);
    }
    expect(building(city, 'src/services/orders/orders.service.ts').side).toBeGreaterThan(building(city, 'src/auth/roles.ts').side);
  });
});
