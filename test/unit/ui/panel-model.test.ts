// panel/* (ADR-026): what the reading panel shows, as data from the Report.
// Stops by order, findings by file with the change-level ones first and open
// ones first, the files outside the spec (and why there may be none), the
// touched symbols, the counters, the order J and K walk, and the file view's
// header data.

import { describe, expect, it } from 'vitest';
import type { File, Finding, Report, Step, Symbol as ReportSymbol } from '../../../src/core/report/types.js';
import {
  counters,
  fileViewData,
  findingGroups,
  findingSources,
  navTargets,
  outsideSpec,
  sortFindings,
  stepTarget,
  stopIsCurrent,
  stopsOf,
  touchedSymbols,
} from '../../../src/ui/screens/change/model/panel.js';

function symbol(file: string, name: string, status: ReportSymbol['status'], start: number): ReportSymbol {
  return { id: `${file}#${name}`, name, kind: 'function', status, range: { start, end: start + 2 } };
}

function file(id: string, symbols: ReportSymbol[], inSpec: boolean | null = null): File {
  return { id, path: id, language: 'typescript', status: symbols.some((s) => s.status !== 'same') ? 'mod' : 'same', verdict: 'ok', inSpec, symbols };
}

function step(order: number, f: File, name: string): Step {
  return { order, symbolId: `${f.id}#${name}`, fileId: f.id, why: `why ${String(order)}`, diff: [{ kind: 'add', text: 'x' }] };
}

function finding(id: string, file: string, overrides: Partial<Finding> = {}): Finding {
  return { id, source: 'claude', severity: 'med', category: 'scope', file, line: 1, title: id, message: id, state: 'open', ...overrides };
}

const a = file('src/a.ts', [symbol('src/a.ts', 'late', 'mod', 30), symbol('src/a.ts', 'early', 'add', 1), symbol('src/a.ts', 'same', 'same', 10)], false);
const b = file('src/b.ts', [symbol('src/b.ts', 'only', 'sig', 1)], true);
const c = file('src/c.ts', [symbol('src/c.ts', 'quiet', 'same', 1)]);

function report(overrides: Partial<Report> = {}): Report {
  return {
    meta: { repo: 'sample', base: 'main', head: 'feature/x', commits: 1, generatedAt: '2026-10-01T10:00:00.000Z' },
    packages: [
      { id: 'src', path: 'src', tier1: false, files: [a, b, c] },
    ],
    steps: [step(2, b, 'only'), step(1, a, 'early'), step(3, a, 'late'), step(4, { ...c, id: 'src/gone.ts' }, 'x')],
    findings: [],
    summary: { files: 3, byStatus: { add: 1, mod: 1, sig: 1, del: 0, same: 2 }, byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 3, same: 0 }, tier1Files: [] },
    ...overrides,
  };
}

describe('panel model', () => {
  it('stops are the steps by order, without those whose file is not in the Report', () => {
    const stops = stopsOf(report());
    expect(stops.map((stop) => stop.order)).toEqual([1, 2, 3]);
    expect(stops[0]?.symbol?.name).toBe('early');
    expect(stops[0]?.placed.pkg).toBe('src');
  });

  it('a stop carries the findings the Report anchored to its symbol, open first', () => {
    const findings = [
      finding('fixed', 'src/a.ts', { symbolId: 'src/a.ts#early', state: 'fixed' }),
      finding('open-low', 'src/a.ts', { symbolId: 'src/a.ts#early', severity: 'low' }),
      finding('open-high', 'src/a.ts', { symbolId: 'src/a.ts#early', severity: 'high' }),
      finding('file-level', 'src/a.ts'),
    ];
    const stop = stopsOf(report({ findings }))[0];
    expect(stop?.findings.map((f) => f.id)).toEqual(['open-high', 'open-low', 'fixed']);
  });

  it('sorts findings open, intended, fixed, then by severity, keeping the Report order otherwise', () => {
    const sorted = sortFindings([
      finding('f', 'x', { state: 'fixed', severity: 'high' }),
      finding('i', 'x', { state: 'intended' }),
      finding('o1', 'x', { severity: 'low' }),
      finding('o2', 'x', { severity: 'low' }),
      finding('o3', 'x', { severity: 'high' }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(['o3', 'o1', 'o2', 'i', 'f']);
  });

  it('groups findings by file, change-level first, then the Report file order, then unknown paths', () => {
    const findings = [
      finding('1', 'src/b.ts'),
      finding('2', 'elsewhere.ts'),
      finding('3', ''),
      finding('4', 'src/a.ts', { state: 'fixed' }),
      finding('5', 'src/a.ts'),
    ];
    const groups = findingGroups(report({ findings }));
    expect(groups.map((g) => g.path)).toEqual(['', 'src/a.ts', 'src/b.ts', 'elsewhere.ts']);
    expect(groups[0]?.placed).toBeNull();
    expect(groups[1]?.findings.map((f) => f.id)).toEqual(['5', '4']);
    expect(groups[3]?.placed).toBeNull();
    expect(findingGroups(report())).toEqual([]);
  });

  it('lists the sources of the findings once, in order of appearance', () => {
    const findings = [finding('1', 'x', { source: 'semgrep' }), finding('2', 'x', { source: 'claude' }), finding('3', 'x', { source: 'semgrep' })];
    expect(findingSources(report({ findings }))).toEqual(['semgrep', 'claude']);
  });

  it('outside the spec lists files with inSpec false; no spec at all is told apart from none outside', () => {
    expect(outsideSpec(report()).files.map((p) => p.file.id)).toEqual(['src/a.ts']);
    const none = report({ packages: [{ id: 'src', path: 'src', tier1: false, files: [file('src/a.ts', [], null), file('src/b.ts', [], null)] }] });
    expect(outsideSpec(none)).toEqual({ files: [], specKnown: false });
    const allIn = report({ packages: [{ id: 'src', path: 'src', tier1: false, files: [file('src/a.ts', [], true), file('src/b.ts', [], null)] }] });
    expect(outsideSpec(allIn)).toEqual({ files: [], specKnown: true });
  });

  it('touched symbols are grouped by file in source order and leave the untouched out', () => {
    const groups = touchedSymbols(report());
    expect(groups.map((g) => g.placed.file.id)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(groups[0]?.symbols.map((s) => s.name)).toEqual(['early', 'late']);
  });

  it('counters: stops, findings, files outside the spec, touched symbols', () => {
    expect(counters(report({ findings: [finding('1', ''), finding('2', 'src/a.ts')] }))).toEqual({ order: 3, findings: 2, outside: 1, symbols: 3 });
    expect(counters(report({ steps: [], findings: [] }))).toEqual({ order: 0, findings: 0, outside: 1, symbols: 3 });
  });

  it('J and K walk the stops by order, or the touched symbols without steps', () => {
    const targets = navTargets(report());
    expect(targets.map((t) => t.symbolId)).toEqual(['src/a.ts#early', 'src/b.ts#only', 'src/a.ts#late']);
    expect(navTargets(report({ steps: [] })).map((t) => t.symbolId)).toEqual(['src/a.ts#early', 'src/a.ts#late', 'src/b.ts#only']);
    expect(navTargets(report({ steps: [], packages: [] }))).toEqual([]);
  });

  it('steps from nothing to the first, never past either end, and finds the current by file when its symbol is no stop', () => {
    const targets = navTargets(report());
    const [first, second, third] = targets;
    expect(stepTarget(targets, null, 'next')).toEqual(first);
    expect(stepTarget(targets, null, 'prev')).toEqual(first);
    expect(stepTarget(targets, first ?? null, 'next')).toEqual(second);
    expect(stepTarget(targets, second ?? null, 'prev')).toEqual(first);
    expect(stepTarget(targets, first ?? null, 'prev')).toEqual(first);
    expect(stepTarget(targets, third ?? null, 'next')).toEqual(third);
    // A floor of src/b.ts that has no stop: the file's stop is current.
    expect(stepTarget(targets, { fileId: 'src/b.ts', symbolId: 'src/b.ts#other' }, 'next')).toEqual(third);
    expect(stepTarget([], first ?? null, 'next')).toBeNull();
  });

  it('a stop is current for the focused symbol, or for every stop of the selected file when none matches', () => {
    const stops = stopsOf(report());
    const [early, , late] = stops;
    if (early === undefined || late === undefined) throw new Error('stops missing');
    expect(stopIsCurrent(stops, early, { fileId: 'src/a.ts', symbolId: 'src/a.ts#early' })).toBe(true);
    expect(stopIsCurrent(stops, late, { fileId: 'src/a.ts', symbolId: 'src/a.ts#early' })).toBe(false);
    expect(stopIsCurrent(stops, late, { fileId: 'src/a.ts', symbolId: 'src/a.ts#same' })).toBe(true);
    expect(stopIsCurrent(stops, late, { fileId: 'src/b.ts', symbolId: null })).toBe(false);
    expect(stopIsCurrent(stops, late, null)).toBe(false);
  });

  it('file view data: counts by status, the file stops, and findings that are on no stop', () => {
    const findings = [finding('on-stop', 'src/a.ts', { symbolId: 'src/a.ts#late' }), finding('loose', 'src/a.ts'), finding('other', 'src/b.ts')];
    const data = fileViewData(report({ findings }), 'src/a.ts');
    expect(data?.counts).toEqual({ add: 1, mod: 1, sig: 0, del: 0, same: 1 });
    expect(data?.stops.map((s) => s.order)).toEqual([1, 3]);
    expect(data?.loose.map((f) => f.id)).toEqual(['loose']);
    expect(fileViewData(report(), 'src/missing.ts')).toBeNull();
    const bare = report({ packages: [{ id: 'src', path: 'src', tier1: false, files: [{ ...file('src/n.sql', []), status: 'add' }] }] });
    expect(fileViewData(bare, 'src/n.sql')?.counts.add).toBe(1);
  });
});
