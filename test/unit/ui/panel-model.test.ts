// panel/* (ADR-026): what the reading panel shows, as data from the Report.
// Stops by order, findings by file with the change-level ones first and open
// ones first, the files outside the spec (and why there may be none), the
// touched symbols, the counters, the order J and K walk, and the file view's
// header data. The sections of the execution path (DC-105): path, migrations,
// unconnected, a missing section read as path, and the empty text.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { File, Finding, Report, Step, Symbol as ReportSymbol } from '../../../src/core/report/types.js';
import {
  counters,
  EMPTY_STEPS,
  emptyStepsText,
  fileViewData,
  findingGroups,
  findingSources,
  navTargets,
  outsideSpec,
  sectionOf,
  sortFindings,
  stepTarget,
  stopIsCurrent,
  stopSections,
  stopsOf,
  touchedSymbols,
} from '../../../src/ui/screens/change/model/panel.js';

function symbol(file: string, name: string, status: ReportSymbol['status'], start: number): ReportSymbol {
  return { id: `${file}#${name}`, name, kind: 'function', status, range: { start, end: start + 2 } };
}

function file(id: string, symbols: ReportSymbol[], inSpec: boolean | null = null): File {
  return { id, path: id, language: 'typescript', status: symbols.some((s) => s.status !== 'same') ? 'mod' : 'same', verdict: 'ok', inSpec, symbols };
}

function step(order: number, f: File, name: string, section?: Step['section']): Step {
  const made: Step = { order, symbolId: `${f.id}#${name}`, fileId: f.id, why: `why ${String(order)}`, diff: [{ kind: 'add', text: 'x' }] };
  if (section !== undefined) made.section = section;
  return made;
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

const fixturesDir = join(import.meta.dirname, '../../fixtures/ui');
const withSteps = (): Report => JSON.parse(readFileSync(join(fixturesDir, 'report-order-discounts-with-steps.json'), 'utf8')) as Report;

describe('panel model: sections of the execution path', () => {
  it('panel-model/stops-sections-order: Execution path, Migrations, Unconnected, each by order; J and K walk them in that order', () => {
    // Out of order on purpose: an unconnected step first, a migration before a path step.
    const steps = [step(5, b, 'only', 'unconnected'), step(4, a, 'late', 'migration'), step(2, a, 'early', 'path'), step(3, c, 'quiet', 'unconnected'), step(1, b, 'only', 'path')];
    const sections = stopSections(report({ steps }));
    expect(sections.map((section) => section.label)).toEqual(['Execution path', 'Migrations', 'Unconnected']);
    expect(sections.map((section) => section.stops.map((stop) => stop.order))).toEqual([[1, 2], [4], [3, 5]]);
    expect(stopsOf(report({ steps })).map((stop) => stop.order)).toEqual([1, 2, 4, 3, 5]);
    expect(navTargets(report({ steps })).map((target) => target.symbolId)).toEqual(['src/b.ts#only', 'src/a.ts#early', 'src/a.ts#late', 'src/c.ts#quiet', 'src/b.ts#only']);
    // A section with no stop has no heading.
    expect(stopSections(report({ steps: [step(1, a, 'early', 'unconnected')] })).map((section) => section.id)).toEqual(['unconnected']);

    // The fixture is the golden order-discounts Report, real steps included.
    const golden = JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/scenarios/order-discounts/expected.json'), 'utf8')) as Report;
    const fixture = withSteps();
    expect(fixture.steps).toEqual(golden.steps);
    const real = stopSections(fixture);
    expect(real.map((section) => section.id)).toEqual(['path', 'migration', 'unconnected']);
    const orders = real.flatMap((section) => section.stops.map((stop) => stop.order));
    expect(orders).toEqual(fixture.steps.map((one) => one.order).sort((x, y) => x - y));
    // Each section's findings sit under the stop of their symbol.
    expect(real.map((section) => section.stops.flatMap((stop) => stop.findings.map((found) => found.id)))).toEqual([['ws-place'], ['ws-alter'], ['ws-mark']]);
  });

  it('panel-model/section-default-path: a step without a section, or with one this UI does not know, is on the execution path', () => {
    const plain = step(1, a, 'early');
    expect(sectionOf(plain)).toBe('path');
    expect(sectionOf({ ...plain, section: 'elsewhere' as NonNullable<Step['section']> })).toBe('path');
    expect(sectionOf({ ...plain, section: 'toString' as NonNullable<Step['section']> })).toBe('path');
    expect(sectionOf({ ...plain, section: 'migration' })).toBe('migration');
    const sections = stopSections(report({ steps: [step(2, b, 'only'), step(1, a, 'early'), step(3, a, 'late', 'unconnected')] }));
    expect(sections.map((section) => [section.id, section.stops.map((stop) => stop.order)])).toEqual([
      ['path', [1, 2]],
      ['unconnected', [3]],
    ]);
  });

  it('panel-model/empty-steps-text: the empty text names the missing execution path, and only when the Report has no steps', () => {
    expect(EMPTY_STEPS).toBe('No execution path: nothing in this change reaches an entry point');
    expect(emptyStepsText(report({ steps: [] }))).toBe(EMPTY_STEPS);
    // Steps only on files the Report does not have: nothing to list either.
    expect(emptyStepsText(report({ steps: [step(1, { ...c, id: 'src/gone.ts' }, 'x')] }))).toBe(EMPTY_STEPS);
    // Only unconnected steps: they are listed, under their heading, without the empty text.
    expect(emptyStepsText(report({ steps: [step(1, a, 'early', 'unconnected')] }))).toBeNull();
    expect(emptyStepsText(withSteps())).toBeNull();
  });

  it('panel-model/fixture-generated: report-order-discounts-with-steps.json is what its generator writes from the golden', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'diffcity-steps-')), 'report.json');
    execFileSync(process.execPath, [join(fixturesDir, 'gen-report-with-steps.mjs'), '--out', out]);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(join(fixturesDir, 'report-order-discounts-with-steps.json'), 'utf8'));
  });
});
