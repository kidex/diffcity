// view/* (ADR-026): the mockup's filter rules as pure functions. A verdict
// filter dims the buildings of other verdicts; a type filter dims the floors
// of other types and the buildings with no matching floor; the rows combine
// with AND; clicking an active chip turns it off; "Show everything" clears
// every row; a Rules filter dims the buildings with no finding of that rule.

import { describe, expect, it } from 'vitest';
import type { File, Finding, Package, Report, Status, Symbol, Verdict } from '../../../src/core/report/types.js';
import { buildCity } from '../../../src/ui/screens/change/model/city.js';
import type { City } from '../../../src/ui/screens/change/model/city.js';
import type { Filters, PaintInput } from '../../../src/ui/screens/change/model/view.js';
import {
  clearFilters,
  focusPaint,
  NO_FILTERS,
  paintCity,
  pruneFilters,
  ruleIndex,
  ruleOf,
  toggleRule,
  toggleType,
  toggleVerdict,
} from '../../../src/ui/screens/change/model/view.js';

function symbol(file: string, name: string, status: Status, start: number): Symbol {
  return { id: `${file}#${name}`, name, kind: 'function', status, range: { start, end: start + 3 } };
}

function file(path: string, verdict: Verdict, status: Status, symbols: Symbol[]): File {
  return { id: path, path, language: 'typescript', status, verdict, inSpec: null, symbols };
}

function finding(id: string, source: string, path: string): Finding {
  return { id, source, severity: 'med', category: 'scope', file: path, line: 1, title: id, message: id, state: 'open' };
}

const GUARD = 'src/auth/guard.ts';
const TOTALS = 'src/orders/totals.ts';
const CART = 'src/orders/cart.ts';
const LOG = 'src/shared/log.ts';

function sample(findings: Finding[] = []): Report {
  const packages: Package[] = [
    {
      id: 'src/auth',
      path: 'src/auth',
      tier1: true,
      files: [file(GUARD, 'eyes', 'sig', [symbol(GUARD, 'check', 'sig', 1), symbol(GUARD, 'roles', 'same', 10)])],
    },
    {
      id: 'src/orders',
      path: 'src/orders',
      tier1: false,
      files: [
        file(TOTALS, 'ok', 'add', [symbol(TOTALS, 'sum', 'add', 1), symbol(TOTALS, 'tax', 'add', 10), symbol(TOTALS, 'old', 'del', 20)]),
        file(CART, 'ok', 'mod', [symbol(CART, 'add', 'mod', 1), symbol(CART, 'drop', 'same', 10)]),
      ],
    },
    { id: 'src/shared', path: 'src/shared', tier1: false, files: [file(LOG, 'same', 'same', [symbol(LOG, 'log', 'same', 1)])] },
  ];
  return {
    meta: { repo: 'sample-shop', base: 'main', head: 'feature/x', commits: 2, generatedAt: '2026-01-01T00:00:00.000Z' },
    packages,
    steps: [],
    findings,
    summary: { files: 4, byStatus: { add: 2, mod: 1, sig: 1, del: 1, same: 3 }, byVerdict: { eyes: 1, risky: 0, spec: 0, ok: 2, same: 1 }, tier1Files: [GUARD] },
  };
}

function input(city: City, filters: Filters, report: Report = sample()): PaintInput {
  return { city, filters, rules: ruleIndex(report), hover: null, selection: null };
}

function dimmedIds(city: City, filters: Filters, report: Report = sample()): string[] {
  const paint = paintCity(input(city, filters, report));
  return city.buildings.filter((building) => paint.buildings[building.index]?.dimmed === true).map((building) => building.id);
}

function dimmedFloors(city: City, filters: Filters, id: string): number[] {
  const building = city.byId.get(id);
  if (building === undefined) throw new Error(`no building ${id}`);
  const paint = paintCity(input(city, filters));
  return (paint.floors[building.index] ?? []).flatMap((floor, i) => (floor.dimmed ? [i] : []));
}

describe('view', () => {
  const city = buildCity(sample());

  it('view/verdict-filter-dims: buildings of other verdicts are dimmed, the floors of dimmed buildings with them', () => {
    const filters = toggleVerdict(NO_FILTERS, 'eyes');
    expect(dimmedIds(city, filters).sort()).toEqual([CART, LOG, TOTALS].sort());
    expect(dimmedFloors(city, filters, TOTALS)).toEqual([0, 1, 2]);
    expect(dimmedFloors(city, filters, GUARD)).toEqual([]);
    expect(dimmedIds(city, NO_FILTERS)).toEqual([]);
  });

  it('view/type-filter-dims-floors: floors of other types are dimmed, and buildings with no matching floor', () => {
    const filters = toggleType(NO_FILTERS, 'add');
    const paint = paintCity(input(city, filters));
    // Totals has two `add` floors and one removed one: not dimmed as a building, its removed floor is.
    expect(dimmedIds(city, filters).sort()).toEqual([CART, GUARD, LOG].sort());
    const totals = city.byId.get(TOTALS);
    expect(totals && paint.floors[totals.index]?.map((floor) => floor.dimmed)).toEqual([false, false, true]);
    expect(totals && paint.floors[totals.index]?.map((floor) => floor.typeMatch)).toEqual([true, true, false]);
    expect(totals && paint.buildings[totals.index]?.typeMatch).toBe(true);
    const guard = city.byId.get(GUARD);
    expect(guard && paint.buildings[guard.index]).toMatchObject({ dimmed: true, typeMatch: false });
    // `del` is a type of its own.
    expect(dimmedIds(city, toggleType(NO_FILTERS, 'del')).sort()).toEqual([CART, GUARD, LOG].sort());
    expect(dimmedFloors(city, toggleType(NO_FILTERS, 'del'), TOTALS)).toEqual([0, 1]);
  });

  it('view/filters-and: verdict, type and rule rows combine with AND', () => {
    const report = sample([finding('f1', 'rule:file-size', TOTALS), finding('f2', 'rule:file-size', GUARD)]);
    const both = toggleType(toggleVerdict(NO_FILTERS, 'ok'), 'mod');
    // ok AND has a modified floor: only the cart.
    expect(dimmedIds(city, both, report).sort()).toEqual([GUARD, LOG, TOTALS].sort());
    const none = toggleType(toggleVerdict(NO_FILTERS, 'eyes'), 'add');
    // The guard is eyes but has no added floor; totals has one but is ok: everything is dimmed.
    expect(dimmedIds(city, none, report)).toHaveLength(city.buildings.length);
    const three = toggleRule(toggleType(toggleVerdict(NO_FILTERS, 'ok'), 'add'), 'file-size');
    expect(dimmedIds(city, three, report).sort()).toEqual([CART, GUARD, LOG].sort());
  });

  it('view/filter-toggle-off: clicking the active chip turns its row off, another chip switches it', () => {
    expect(toggleVerdict(toggleVerdict(NO_FILTERS, 'risky'), 'risky')).toEqual(NO_FILTERS);
    expect(toggleType(toggleType(NO_FILTERS, 'sig'), 'sig')).toEqual(NO_FILTERS);
    expect(toggleRule(toggleRule(NO_FILTERS, 'layers'), 'layers')).toEqual(NO_FILTERS);
    expect(toggleVerdict(toggleVerdict(NO_FILTERS, 'risky'), 'eyes').verdict).toBe('eyes');
    // Turning one row off leaves the others on.
    const both = toggleType(toggleVerdict(NO_FILTERS, 'eyes'), 'sig');
    expect(toggleVerdict(both, 'eyes')).toEqual({ verdict: null, type: 'sig', rule: null });
    // And the city is whole again.
    expect(dimmedIds(city, toggleVerdict(toggleVerdict(NO_FILTERS, 'eyes'), 'eyes'))).toEqual([]);
  });

  it('view/show-everything-clears: every row is cleared at once', () => {
    const all = toggleRule(toggleType(toggleVerdict(NO_FILTERS, 'eyes'), 'add'), 'file-size');
    expect(all).toEqual({ verdict: 'eyes', type: 'add', rule: 'file-size' });
    expect(clearFilters()).toEqual(NO_FILTERS);
    expect(dimmedIds(city, clearFilters())).toEqual([]);
    // A fresh object each time: nothing shares state.
    expect(clearFilters()).not.toBe(NO_FILTERS);
  });

  it('view/rules-filter-dims: buildings with no finding of the rule are dimmed; change-level findings belong to no building', () => {
    const report = sample([
      finding('f1', 'rule:file-size', TOTALS),
      finding('f2', 'rule:layers', CART),
      finding('f3', 'rule:layers', TOTALS),
      finding('f4', 'claude', GUARD),
      finding('f5', 'rule:pipeline', ''),
    ]);
    expect(ruleOf('rule:file-size')).toBe('file-size');
    expect(ruleOf('semgrep')).toBeNull();
    expect(ruleOf('rule:')).toBeNull();
    const index = ruleIndex(report);
    expect([...index.keys()].sort()).toEqual(['file-size', 'layers']);
    expect([...(index.get('layers') ?? [])].sort()).toEqual([CART, TOTALS]);
    expect(dimmedIds(city, toggleRule(NO_FILTERS, 'file-size'), report).sort()).toEqual([CART, GUARD, LOG].sort());
    expect(dimmedIds(city, toggleRule(NO_FILTERS, 'layers'), report).sort()).toEqual([GUARD, LOG].sort());
    // A rule filter dims whole buildings only; the floors of a matching building stay lit.
    const paint = paintCity(input(city, toggleRule(NO_FILTERS, 'file-size'), report));
    const totals = city.byId.get(TOTALS);
    expect(totals && paint.floors[totals.index]?.every((floor) => !floor.dimmed)).toBe(true);
    // A rule the Report no longer has is dropped from the filters.
    expect(pruneFilters(toggleRule(NO_FILTERS, 'gone'), index).rule).toBeNull();
    expect(pruneFilters(toggleRule(NO_FILTERS, 'layers'), index).rule).toBe('layers');
  });

  it('paint states carry hover and selection, and pulse and checked stay at their defaults without critical floors or marks', () => {
    const paint = paintCity({ ...input(city, NO_FILTERS), hover: TOTALS, selection: GUARD });
    const totals = city.byId.get(TOTALS);
    const guard = city.byId.get(GUARD);
    expect(totals && paint.buildings[totals.index]).toEqual({ dimmed: false, typeMatch: true, hovered: true, selected: false, focused: false, pulse: false, pulseColor: 'high', checked: 'none' });
    expect(guard && paint.buildings[guard.index]).toMatchObject({ hovered: false, selected: true });
    expect(guard && paint.floors[guard.index]?.every((floor) => floor.selected && !floor.pulse && floor.checked === 'none')).toBe(true);
    // focusPaint lays the same flags over a filters-only paint, without touching the others.
    const base = paintCity(input(city, toggleVerdict(NO_FILTERS, 'eyes')));
    const focused = focusPaint(base, city, TOTALS, GUARD);
    expect(totals && focused.buildings[totals.index]).toMatchObject({ hovered: true, dimmed: true });
    expect(guard && focused.buildings[guard.index]).toMatchObject({ selected: true, dimmed: false });
    const cart = city.byId.get(CART);
    expect(cart && focused.buildings[cart.index]).toBe(cart && base.buildings[cart.index]);
  });

  it('focusPaint lights one floor of an unselected building for the diff\'s hover', () => {
    const base = paintCity(input(city, NO_FILTERS));
    const guard = city.byId.get(GUARD);
    const symbolId = guard?.floors[0]?.symbolId;
    if (guard === undefined || typeof symbolId !== 'string') throw new Error('fixture has no guard floor');
    const lit = focusPaint(base, city, GUARD, null, null, { id: GUARD, symbolId });
    expect(lit.floors[guard.index]?.map((floor) => floor.focused)).toEqual(guard.floors.map((floor) => floor.symbolId === symbolId));
    expect(lit.buildings[guard.index]).toMatchObject({ hovered: true, selected: false });
  });
});
