// sameLayout and samePath (DC-110): a Report that only changes a finding's
// state or a verdict lays out as the city on screen, so the scene repaints it
// in place; anything that moves a building, a floor, a lot or a step does not.

import { describe, expect, it } from 'vitest';
import type { File, Finding, Package, Report, Step, Symbol } from '../../../src/core/report/types.js';
import { buildCity, sameLayout } from '../../../src/ui/screens/change/model/city.js';
import { pathStops, samePath } from '../../../src/ui/screens/change/model/path.js';

const sym = (file: string, name: string, start: number): Symbol => ({ id: `${file}#${name}`, name, kind: 'function', status: 'add', range: { start, end: start + 2 } });
const file = (path: string, names: string[], verdict: File['verdict'] = 'ok'): File => ({
  id: path,
  path,
  language: 'typescript',
  status: 'add',
  verdict,
  inSpec: null,
  symbols: names.map((name, i) => sym(path, name, i * 5 + 1)),
});
const report = (packages: Package[], findings: Finding[] = [], steps: Step[] = []): Report => ({
  meta: { repo: 'r', base: 'main', head: 'h', commits: 1, generatedAt: '2026-01-01T00:00:00.000Z' },
  packages,
  steps,
  findings,
  summary: { files: 0, byStatus: { add: 0, mod: 0, sig: 0, del: 0, same: 0 }, byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 }, tier1Files: [] },
});
const pkg = (path: string, files: File[], tier1 = false): Package => ({ id: path, path, tier1, files });
const finding = (state: Finding['state']): Finding => ({
  id: 'f:1',
  file: 'src/a.ts',
  line: 2,
  severity: 'high',
  category: 'correctness',
  title: 'Rounds too early',
  message: 'm',
  source: 'claude',
  state,
});

describe('sameLayout', () => {
  const base = (verdict: File['verdict'], state: Finding['state']): Report =>
    report([pkg('src', [file('src/a.ts', ['one', 'two'], verdict), file('src/b.ts', ['x'])]), pkg('lib', [file('lib/c.ts', ['y'])])], [finding(state)]);

  it('holds when only a finding state and a verdict change', () => {
    expect(sameLayout(buildCity(base('risky', 'open')), buildCity(base('ok', 'intended')))).toBe(true);
  });

  it('fails when a building gains a floor', () => {
    const next = report([pkg('src', [file('src/a.ts', ['one', 'two', 'three']), file('src/b.ts', ['x'])]), pkg('lib', [file('lib/c.ts', ['y'])])]);
    expect(sameLayout(buildCity(base('ok', 'open')), buildCity(next))).toBe(false);
  });

  it('fails when a floor is another symbol', () => {
    const next = report([pkg('src', [file('src/a.ts', ['one', 'other']), file('src/b.ts', ['x'])]), pkg('lib', [file('lib/c.ts', ['y'])])]);
    expect(sameLayout(buildCity(base('ok', 'open')), buildCity(next))).toBe(false);
  });

  it('fails when a file is added or a lot turns tier 1', () => {
    const added = report([pkg('src', [file('src/a.ts', ['one', 'two']), file('src/b.ts', ['x']), file('src/d.ts', ['z'])]), pkg('lib', [file('lib/c.ts', ['y'])])]);
    expect(sameLayout(buildCity(base('ok', 'open')), buildCity(added))).toBe(false);
    const tier = report([pkg('src', [file('src/a.ts', ['one', 'two']), file('src/b.ts', ['x'])]), pkg('lib', [file('lib/c.ts', ['y'])], true)]);
    expect(sameLayout(buildCity(base('ok', 'open')), buildCity(tier))).toBe(false);
  });
});

describe('samePath', () => {
  const city = buildCity(report([pkg('src', [file('src/a.ts', ['one']), file('src/b.ts', ['x'])])]));
  const step = (order: number, fileId: string): Step => ({ order, fileId, symbolId: `${fileId}#one`, why: '', diff: [] });

  it('holds for the same steps on the same buildings and fails when one moves', () => {
    const steps = [step(1, 'src/a.ts'), step(2, 'src/b.ts')];
    expect(samePath(pathStops(city, steps), pathStops(city, [...steps]))).toBe(true);
    expect(samePath(pathStops(city, steps), pathStops(city, [step(1, 'src/b.ts'), step(2, 'src/a.ts')]))).toBe(false);
    expect(samePath(pathStops(city, steps), pathStops(city, steps.slice(0, 1)))).toBe(false);
  });
});
