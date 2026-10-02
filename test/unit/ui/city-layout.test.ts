// city/* (ADR-026): the change screen's layout from a Report. Deterministic,
// stable when a file is added (the row width is kept by the view), quiet
// packages at the back, floors in source order, footprints from the symbol
// count, labels in the ADR's priority. Nothing here reads a status or a
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
  REFLOW_FACTOR,
  ROW_QUANTUM,
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

  it('keeps the same coordinates for the same Report when no previous row width is given', () => {
    const a = buildCity(golden());
    const b = buildCity(golden(), {});
    const c = buildCity(golden(), { rowWidth: undefined });
    for (const city of [b, c]) {
      expect(city.rowWidth).toBe(a.rowWidth);
      expect(city.buildings.map((item) => [item.x, item.z])).toEqual(a.buildings.map((item) => [item.x, item.z]));
    }
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
    const b = buildCity(after, { rowWidth: a.rowWidth });
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

describe('city/row-width-sticky', () => {
  const lastLot = (source: Report): Package => {
    const last = source.packages.find((p) => p.path === 'src/services/orders');
    if (last === undefined) throw new Error('src/services/orders missing from the golden');
    return last;
  };
  const box = (lot: CityLot) => [lot.id, lot.x0, lot.z0, lot.x1, lot.z1, lot.row];
  // A lot in the changed lot's row keeps its place and buildings; only its plate deepens with the row.
  const place = (lot: CityLot) => [lot.id, lot.x0, lot.z0, lot.x1, lot.row];

  /** Lots before `index`: those in earlier rows are untouched, those in its row keep their place. */
  function expectEarlierLotsKept(before: City, after: City, index: number): void {
    const row = at(before.lots, index).row;
    for (const lot of before.lots.slice(0, index)) {
      const next = at(after.lots, lot.index);
      expect(lot.row < row ? box(next) : place(next)).toEqual(lot.row < row ? box(lot) : place(lot));
      for (const item of lot.buildings) expect([building(after, item.id).x, building(after, item.id).z]).toEqual([item.x, item.z]);
    }
  }

  it('moves no earlier lot while files are added to the last lot across several row-width steps', () => {
    const first = buildCity(golden());
    const lastIndex = first.lots.findIndex((lot) => lot.id === 'src/services/orders');
    expect(lastIndex).toBe(first.lots.length - 1);
    const grown = golden();
    let previous = first;
    let crossed = 0;
    for (let n = 0; crossed < 2; n += 1) {
      const path = `src/services/orders/extra-${String(n)}.ts`;
      lastLot(grown).files.push(file(path, [symbol(path, `extra${String(n)}`, 'add', 1)], 'add'));
      const city = buildCity(grown, { rowWidth: previous.rowWidth });
      expect(city.rowWidth).toBe(first.rowWidth);
      expectEarlierLotsKept(first, city, lastIndex);
      // What a fresh layout of the same Report would pick: it has crossed `crossed` steps.
      crossed = (buildCity(grown).rowWidth - first.rowWidth) / ROW_QUANTUM;
      previous = city;
      expect(n).toBeLessThan(500);
    }
    expect(crossed).toBeGreaterThanOrEqual(2);
  });

  it('keeps the earlier lots in place when files go to src/services/orders (the review probe)', () => {
    const before = buildCity(golden());
    const grown = golden();
    for (const name of ['refunds', 'returns']) {
      const path = `src/services/orders/${name}.ts`;
      lastLot(grown).files.push(file(path, [symbol(path, name, 'add', 1)], 'add'));
    }
    const after = buildCity(grown, { rowWidth: before.rowWidth });
    expect(after.rowWidth).toBe(before.rowWidth);
    expectEarlierLotsKept(before, after, before.lots.findIndex((lot) => lot.id === 'src/services/orders'));
  });

  it('puts a lot wider than the kept rows alone in its own row instead of widening them', () => {
    const one = (path: string): Package => pkg(path, [file(`${path}/a.ts`, [symbol(`${path}/a.ts`, 'a', 'mod', 1)])]);
    const kept = 3 * ROW_QUANTUM;
    const wide = pkg(
      'c',
      Array.from({ length: 130 }, (_, i) => file(`c/f${String(i)}.ts`, [symbol(`c/f${String(i)}.ts`, 'f', 'mod', 1)])),
    );
    const next = buildCity(report([one('a'), one('b'), wide]), { rowWidth: kept });
    expect(next.rowWidth).toBe(kept);
    const c = at(next.lots, 2);
    expect(c.x1 - c.x0).toBeGreaterThan(kept);
    expect(c.x0).toBe(0);
    expect(at(next.lots, 0).row).toBe(at(next.lots, 1).row);
    expect(c.row).toBeGreaterThan(at(next.lots, 1).row);
    expect(next.lots.slice(0, 2).map(box)).toEqual(buildCity(report([one('a'), one('b')]), { rowWidth: kept }).lots.map(box));
  });

  it('chooses the width afresh once the city is REFLOW_FACTOR times wider than its rows', () => {
    const one = (path: string): Package => pkg(path, [file(`${path}/a.ts`, [symbol(`${path}/a.ts`, 'a', 'mod', 1)])]);
    const small = buildCity(report([one('p0')]));
    const many = report(Array.from({ length: 80 }, (_, i) => one(`p${String(i)}`)));
    const fresh = buildCity(many).rowWidth;
    expect(fresh).toBeGreaterThanOrEqual(small.rowWidth * REFLOW_FACTOR);
    expect(buildCity(many, { rowWidth: small.rowWidth }).rowWidth).toBe(fresh);
  });
});

describe('city/quiet-package-joins-touched-block', () => {
  it('moves a quiet package from the back rows into the touched block when it gets its first touched file (ADR-026)', () => {
    const before = golden();
    const a = buildCity(before);
    const quietLot = a.lots.find((lot) => lot.id === 'src/shared');
    expect(quietLot?.touched).toBe(false);
    expect(quietLot?.row).toBe(0);

    const after = golden();
    const shared = after.packages.find((p) => p.path === 'src/shared');
    if (shared === undefined) throw new Error('src/shared missing from the golden');
    const path = 'src/shared/money.format.ts';
    shared.files.push(file(path, [symbol(path, 'formatMoney', 'add', 1)], 'add'));
    const b = buildCity(after, { rowWidth: a.rowWidth });

    const moved = b.lots.find((lot) => lot.id === 'src/shared');
    expect(moved?.touched).toBe(true);
    // No quiet package is left, so it now follows the Report's order among the touched ones.
    expect(b.lots.map((lot) => lot.id)).toEqual(after.packages.map((p) => p.id));
    expect(moved?.row).toBeGreaterThan(0);
    expect(b.rowWidth).toBe(a.rowWidth);
  });
});

describe('city/label-priority', () => {
  const lbl = (path: string, verdict: 'eyes' | 'risky' | 'spec' | 'ok', status: Status = 'mod'): File => ({
    ...file(path, [symbol(path, 'f', status, 1)], status),
    verdict,
  });
  const city = buildCity(
    report([
      pkg('a', [lbl('a/ok-1.ts', 'ok'), lbl('a/risky.ts', 'risky'), lbl('a/spec.ts', 'spec'), file('a/quiet.ts', [symbol('a/quiet.ts', 'q', 'same', 1)])]),
      pkg('b', [lbl('b/ok-2.ts', 'ok'), lbl('b/eyes.ts', 'eyes')]),
    ]),
  );
  const ids = (list: CityBuilding[]) => list.map((item) => item.id);
  const near = (id: string) => {
    const item = building(city, id);
    return { x: item.x, y: item.height + 1, z: item.z };
  };

  it('labels touched buildings only, at most MAX_LABELS', () => {
    expect(MAX_LABELS).toBe(120);
    const labelled = labelledBuildings(city);
    expect(labelled.every((item) => item.touched)).toBe(true);
    expect(labelled).toHaveLength(5);
    expect(labelledBuildings(city, {}, 3)).toHaveLength(3);
    expect(labelledBuildings(buildCity(golden())).slice(0, 2).map((item) => item.verdict)).toEqual(['eyes', 'eyes']);
  });

  it('puts eyes and risky first, then the other touched files; Report order without a camera', () => {
    expect(ids(labelledBuildings(city))).toEqual(['a/risky.ts', 'b/eyes.ts', 'a/ok-1.ts', 'a/spec.ts', 'b/ok-2.ts']);
  });

  it('orders each group by distance to the camera', () => {
    for (const id of ['b/ok-2.ts', 'a/ok-1.ts', 'a/spec.ts']) {
      const eye = near(id);
      const order = labelledBuildings(city, { eye });
      const sq = (item: CityBuilding) => (item.x - eye.x) ** 2 + (item.height - eye.y) ** 2 + (item.z - eye.z) ** 2;
      expect(ids(order.slice(0, 2)).sort()).toEqual(['a/risky.ts', 'b/eyes.ts']);
      expect(at(order, 2).id).toBe(id);
      for (const group of [order.slice(0, 2), order.slice(2)]) {
        for (let i = 1; i < group.length; i += 1) expect(sq(at(group, i))).toBeGreaterThanOrEqual(sq(at(group, i - 1)));
      }
    }
    // The risky roof is nearer than the eyes one from its own spot: distance beats the verdict inside the group.
    expect(at(labelledBuildings(city, { eye: near('a/risky.ts') }), 0).id).toBe('a/risky.ts');
    expect(at(labelledBuildings(city, { eye: near('b/eyes.ts') }), 0).id).toBe('b/eyes.ts');
  });

  it('puts the selected, then the hovered building before everything else', () => {
    const order = ids(labelledBuildings(city, { selected: 'b/ok-2.ts', hovered: 'a/spec.ts', eye: near('a/risky.ts') }));
    expect(order.slice(0, 4)).toEqual(['b/ok-2.ts', 'a/spec.ts', 'a/risky.ts', 'b/eyes.ts']);
    expect(ids(labelledBuildings(city, { selected: 'b/ok-2.ts', hovered: 'a/spec.ts' }, 2))).toEqual(['b/ok-2.ts', 'a/spec.ts']);
  });

  it('never labels an untouched building, even selected or hovered', () => {
    expect(ids(labelledBuildings(city, { selected: 'a/quiet.ts', hovered: 'a/quiet.ts' }))).not.toContain('a/quiet.ts');
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
