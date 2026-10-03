// tween/* (ADR-026): live updates move the buildings of both Reports from
// their old place to the new one, raise the new ones from the ground and sink
// the removed ones; the end of the tween is the new city exactly.

import { describe, expect, it } from 'vitest';
import type { File, Package, Report, Symbol } from '../../../src/core/report/types.js';
import { buildCity } from '../../../src/ui/screens/change/model/city.js';
import { easeOut, needsTween, tweenCity } from '../../../src/ui/screens/change/model/tween.js';

const sym = (file: string, name: string, start: number): Symbol => ({ id: `${file}#${name}`, name, kind: 'function', status: 'add', range: { start, end: start + 2 } });
const file = (path: string, names: string[]): File => ({
  id: path,
  path,
  language: 'typescript',
  status: 'add',
  verdict: 'ok',
  inSpec: null,
  symbols: names.map((name, i) => sym(path, name, i * 5 + 1)),
});
const report = (files: File[]): Report => {
  const pkg: Package = { id: 'src', path: 'src', tier1: false, files };
  return {
    meta: { repo: 'r', base: 'main', head: 'h', commits: 1, generatedAt: '2026-01-01T00:00:00.000Z' },
    packages: [pkg],
    steps: [],
    findings: [],
    summary: { files: files.length, byStatus: { add: 0, mod: 0, sig: 0, del: 0, same: 0 }, byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 }, tier1Files: [] },
  };
};

describe('tween', () => {
  const before = buildCity(report([file('src/a.ts', ['one']), file('src/b.ts', ['one', 'two']), file('src/gone.ts', ['x'])]));
  const after = buildCity(report([file('src/a.ts', ['one', 'two', 'three']), file('src/b.ts', ['one', 'two']), file('src/new.ts', ['y', 'z'])]));
  const get = (city: typeof before, id: string) => {
    const building = city.byId.get(id);
    if (building === undefined) throw new Error(`no ${id}`);
    return building;
  };

  it('buildings in both Reports grow and move between their old and new place', () => {
    const half = tweenCity(before, after, 0.5);
    const a0 = get(before, 'src/a.ts');
    const a1 = get(after, 'src/a.ts');
    const a = get(half, 'src/a.ts');
    expect(a1.height).toBeGreaterThan(a0.height);
    expect(a.height).toBeCloseTo((a0.height + a1.height) / 2);
    expect(a.floors.at(-1)?.y1).toBeCloseTo(a.height);
    expect(a.side).toBeCloseTo((a0.side + a1.side) / 2);
    const b0 = get(before, 'src/b.ts');
    const b1 = get(after, 'src/b.ts');
    expect(get(half, 'src/b.ts').x).toBeCloseTo((b0.x + b1.x) / 2);
  });

  it('new buildings rise from the ground and removed ones sink', () => {
    const start = tweenCity(before, after, 0);
    expect(get(start, 'src/new.ts').height).toBeLessThan(0.01);
    expect(get(start, 'src/gone.ts').height).toBeCloseTo(get(before, 'src/gone.ts').height);
    const half = tweenCity(before, after, 0.5);
    expect(get(half, 'src/new.ts').height).toBeCloseTo(get(after, 'src/new.ts').height / 2);
    expect(get(half, 'src/gone.ts').height).toBeCloseTo(get(before, 'src/gone.ts').height / 2);
    expect(half.buildings.map((building) => building.index)).toEqual(half.buildings.map((_, i) => i));
    expect(half.byId.size).toBe(half.buildings.length);
  });

  it('progress 1 is the new city, and an unchanged city needs no tween', () => {
    expect(tweenCity(before, after, 1)).toBe(after);
    expect(tweenCity(before, after, 0.5).buildings.some((building) => building.id === 'src/gone.ts')).toBe(true);
    expect(needsTween(before, after)).toBe(true);
    expect(needsTween(after, buildCity(report([file('src/a.ts', ['one', 'two', 'three']), file('src/b.ts', ['one', 'two']), file('src/new.ts', ['y', 'z'])])))).toBe(false);
  });

  it('eases out and clamps', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(2)).toBe(1);
  });
});
