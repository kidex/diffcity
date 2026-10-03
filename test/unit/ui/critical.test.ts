// critical/* (ADR-026, DC-50): which floors pulse, from Report fields alone,
// and what a review mark changes. Also the pulse's own numbers and the finding
// markers' and the reading path's placement.

import { describe, expect, it } from 'vitest';
import type { File, Finding, Package, Report, Status, Step, Symbol, Verdict } from '../../../src/core/report/types.js';
import { buildCity } from '../../../src/ui/screens/change/model/city.js';
import type { Marks } from '../../../src/ui/screens/change/model/critical.js';
import { criticalFloors, phaseOf, PULSE_MAX, PULSE_MIN, PULSE_PERIOD, pulseGain } from '../../../src/ui/screens/change/model/critical.js';
import { findingMarkers } from '../../../src/ui/screens/change/model/markers.js';
import { pathPoints, pathStops } from '../../../src/ui/screens/change/model/path.js';
import { NO_FILTERS, paintCity, ruleIndex } from '../../../src/ui/screens/change/model/view.js';

function symbol(file: string, name: string, status: Status, start: number): Symbol {
  return { id: `${file}#${name}`, name, kind: 'function', status, range: { start, end: start + 3 } };
}

function file(path: string, verdict: Verdict, status: Status, symbols: Symbol[]): File {
  return { id: path, path, language: 'typescript', status, verdict, inSpec: null, symbols };
}

function finding(id: string, path: string, overrides: Partial<Finding> = {}): Finding {
  return { id, source: 'claude', severity: 'high', category: 'security', file: path, line: 1, title: id, message: id, state: 'open', ...overrides };
}

const EYES = 'src/pay/charge.ts';
const RISKY = 'src/pay/refund.ts';
const TIER = 'src/vault/keys.ts';
const OK = 'src/menu/list.ts';
const OK_TWO = 'src/menu/sort.ts';

function report(findings: Finding[] = [], steps: Step[] = []): Report {
  const packages: Package[] = [
    {
      id: 'src/pay',
      path: 'src/pay',
      tier1: false,
      files: [
        file(EYES, 'eyes', 'mod', [symbol(EYES, 'charge', 'mod', 1), symbol(EYES, 'round', 'same', 10), symbol(EYES, 'split', 'add', 20)]),
        file(RISKY, 'risky', 'add', [symbol(RISKY, 'refund', 'add', 1), symbol(RISKY, 'audit', 'same', 10)]),
      ],
    },
    {
      id: 'src/vault',
      path: 'src/vault',
      tier1: true,
      // A tier 1 file that is neither eyes nor risky: `spec` is the nearest verdict ADR-009 allows.
      files: [file(TIER, 'spec', 'sig', [symbol(TIER, 'seal', 'sig', 1), symbol(TIER, 'peek', 'same', 10)])],
    },
    {
      id: 'src/menu',
      path: 'src/menu',
      tier1: false,
      files: [
        file(OK, 'ok', 'add', [symbol(OK, 'list', 'add', 1), symbol(OK, 'trim', 'same', 10)]),
        file(OK_TWO, 'ok', 'mod', [symbol(OK_TWO, 'sort', 'mod', 1)]),
      ],
    },
  ];
  return {
    meta: { repo: 'sample', base: 'main', head: 'feature', commits: 1, generatedAt: '2026-05-04T11:19:30.000Z' },
    packages,
    steps,
    findings,
    summary: {
      files: 5,
      byStatus: { add: 0, mod: 0, sig: 0, del: 0, same: 0 },
      byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 },
      tier1Files: [TIER],
    },
  };
}

const floorsOf = (map: ReturnType<typeof criticalFloors>, id: string): number[] => [...(map.get(id)?.floors ?? [])];

describe('critical/*', () => {
  it('critical/eyes-floors-pulse: the changed floors of an eyes file pulse in the eyes colour', () => {
    const critical = criticalFloors(report());
    expect(floorsOf(critical, EYES)).toEqual([0, 2]);
    expect(critical.get(EYES)?.color).toBe('eyes');
    expect(critical.get(EYES)?.roof).toBe(false);
  });

  it('critical/risky-floors-pulse: the changed floors of a risky file pulse in the risky colour', () => {
    const critical = criticalFloors(report());
    expect(floorsOf(critical, RISKY)).toEqual([0]);
    expect(critical.get(RISKY)?.color).toBe('risky');
  });

  it('critical/tier1-changed-floors-pulse: a tier 1 file pulses on its changed floors, in the high severity colour when its verdict is neither eyes nor risky', () => {
    const critical = criticalFloors(report());
    expect(floorsOf(critical, TIER)).toEqual([0]);
    expect(critical.get(TIER)?.color).toBe('high');
  });

  it('critical/high-finding-floor-pulse: an open high finding makes its own floor pulse, even on a file that is ok', () => {
    const critical = criticalFloors(report([finding('h1', OK, { symbolId: `${OK}#trim` })]));
    expect(floorsOf(critical, OK)).toEqual([1]);
    expect(critical.get(OK)?.color).toBe('high');
    expect(critical.get(OK)?.roof).toBe(false);
  });

  it('critical/high-finding-no-symbol-pulses-roof: a high finding with no symbol pulses the roof strip and no floor', () => {
    const critical = criticalFloors(report([finding('h1', OK_TWO)]));
    expect(critical.get(OK_TWO)).toEqual({ color: 'high', floors: new Set(), roof: true });
    // A symbol the file does not have falls back to the roof too.
    expect(criticalFloors(report([finding('h2', OK_TWO, { symbolId: `${OK_TWO}#gone` })])).get(OK_TWO)?.roof).toBe(true);
  });

  it('critical/same-floor-never-pulses: an unchanged floor stays quiet in an eyes, risky or tier 1 file', () => {
    const critical = criticalFloors(report());
    expect(floorsOf(critical, EYES)).not.toContain(1);
    expect(floorsOf(critical, RISKY)).not.toContain(1);
    expect(floorsOf(critical, TIER)).not.toContain(1);
  });

  it('critical/ok-file-without-high-finding-quiet: an ok file pulses for neither its changes nor lower findings, and a closed high finding does not count', () => {
    const findings = [
      finding('m1', OK, { severity: 'med' }),
      finding('l1', OK_TWO, { severity: 'low', symbolId: `${OK_TWO}#sort` }),
      finding('c1', OK, { state: 'fixed', symbolId: `${OK}#list` }),
      finding('c2', OK_TWO, { state: 'intended' }),
    ];
    const critical = criticalFloors(report(findings));
    expect(critical.has(OK)).toBe(false);
    expect(critical.has(OK_TWO)).toBe(false);
  });

  it('critical/checked-stops-pulse: a floor or a file with a current mark stops pulsing; an outdated mark does not', () => {
    const marks: Marks = {
      symbols: new Map([
        [`${EYES}#charge`, 'checked' as const],
        [`${TIER}#seal`, 'outdated' as const],
      ]),
      files: new Map([[RISKY, 'rewrite' as const]]),
    };
    const critical = criticalFloors(report([finding('h1', RISKY)]), marks);
    // One floor of the eyes file is checked, the other still pulses.
    expect(floorsOf(critical, EYES)).toEqual([2]);
    // The whole risky file is marked: no floor, and the roof stops too.
    expect(critical.has(RISKY)).toBe(false);
    // Outdated looks unchecked.
    expect(floorsOf(critical, TIER)).toEqual([0]);
    for (const kind of ['checked', 'good', 'rewrite'] as const) {
      expect(criticalFloors(report(), { files: new Map([[EYES, kind]]) }).has(EYES)).toBe(false);
    }
  });
});

describe('critical/paint', () => {
  it('maps the critical floors and the marks to the PaintState of buildings and floors', () => {
    const data = report([finding('h1', OK_TWO)]);
    const city = buildCity(data);
    const marks: Marks = {
      symbols: new Map([
        [`${EYES}#charge`, 'good' as const],
        [`${EYES}#split`, 'rewrite' as const],
      ]),
      files: new Map([[OK, 'outdated' as const]]),
    };
    const paint = paintCity({ city, filters: NO_FILTERS, rules: ruleIndex(data), hover: null, selection: null, critical: criticalFloors(data, marks), marks });
    const eyes = city.byId.get(EYES);
    const risky = city.byId.get(RISKY);
    const okTwo = city.byId.get(OK_TWO);
    const ok = city.byId.get(OK);
    if (eyes === undefined || risky === undefined || okTwo === undefined || ok === undefined) throw new Error('building missing');
    expect(paint.floors[eyes.index]?.map((floor) => [floor.pulse, floor.checked])).toEqual([
      [false, 'good'],
      [false, 'none'],
      [false, 'rewrite'],
    ]);
    expect(paint.buildings[eyes.index]?.checked).toBe('rewrite');
    expect(paint.floors[risky.index]?.[0]?.pulse).toBe(true);
    expect(paint.floors[risky.index]?.[0]?.pulseColor).toBe('risky');
    expect(paint.buildings[okTwo.index]?.pulse).toBe(true);
    expect(paint.buildings[risky.index]?.pulse).toBe(false);
    expect(paint.buildings[ok.index]?.checked).toBe('outdated');
  });

  it('a building is checked when every changed floor is checked or good, good when all are good', () => {
    const data = report();
    const city = buildCity(data);
    const eyes = city.byId.get(EYES);
    if (eyes === undefined) throw new Error('building missing');
    const paintOf = (marks: Marks): string | undefined =>
      paintCity({ city, filters: NO_FILTERS, rules: ruleIndex(data), hover: null, selection: null, marks }).buildings[eyes.index]?.checked;
    expect(paintOf({ symbols: new Map([[`${EYES}#charge`, 'checked' as const]]) })).toBe('none');
    expect(
      paintOf({
        symbols: new Map([
          [`${EYES}#charge`, 'checked' as const],
          [`${EYES}#split`, 'good' as const],
        ]),
      }),
    ).toBe('checked');
    expect(
      paintOf({
        symbols: new Map([
          [`${EYES}#charge`, 'good' as const],
          [`${EYES}#split`, 'good' as const],
        ]),
      }),
    ).toBe('good');
    expect(paintOf({ files: new Map([[EYES, 'good' as const]]) })).toBe('good');
  });
});

describe('critical/pulse', () => {
  it('runs a 1.6 s sine between 1.0x and 2.4x of the base gain', () => {
    let low = Infinity;
    let high = -Infinity;
    for (let t = 0; t < PULSE_PERIOD; t += 0.01) {
      const gain = pulseGain(t, 0.7);
      low = Math.min(low, gain);
      high = Math.max(high, gain);
      expect(pulseGain(t + PULSE_PERIOD, 0.7)).toBeCloseTo(gain, 9);
    }
    expect(low).toBeGreaterThanOrEqual(PULSE_MIN - 1e-9);
    expect(low).toBeCloseTo(PULSE_MIN, 2);
    expect(high).toBeLessThanOrEqual(PULSE_MAX + 1e-9);
    expect(high).toBeCloseTo(PULSE_MAX, 2);
  });

  it('gives each building its own phase, the same one every time', () => {
    expect(phaseOf(EYES)).toBe(phaseOf(EYES));
    const phases = new Set([EYES, RISKY, TIER, OK, OK_TWO].map((id) => phaseOf(id).toFixed(4)));
    expect(phases.size).toBe(5);
    for (const id of [EYES, RISKY, TIER]) {
      expect(phaseOf(id)).toBeGreaterThanOrEqual(0);
      expect(phaseOf(id)).toBeLessThan(2 * Math.PI);
    }
  });
});

describe('critical/markers', () => {
  it('puts a pin on the roof for a finding, an X on the floor of a rule finding with a symbol, an X on the roof for one without, and nothing for a change-level finding', () => {
    const findings = [
      finding('p1', EYES, { severity: 'med' }),
      finding('x1', EYES, { source: 'rule:file-size', symbolId: `${EYES}#round`, severity: 'low' }),
      finding('x2', RISKY, { source: 'rule:layers', severity: 'high' }),
      finding('p2', EYES, { severity: 'high', symbolId: `${EYES}#charge` }),
      finding('c1', '', { source: 'rule:pipeline' }),
      finding('gone', 'src/nowhere.ts'),
    ];
    const markers = findingMarkers(buildCity(report(findings)), findings);
    expect(markers.map((marker) => [marker.findingId, marker.kind, marker.floor, marker.slot])).toEqual([
      ['p1', 'pin', null, 0],
      ['x1', 'x', 1, 0],
      ['x2', 'x', null, 0],
      ['p2', 'pin', null, 1],
    ]);
    expect(markers.map((marker) => marker.severity)).toEqual(['med', 'low', 'high', 'high']);
  });
});

describe('critical/path', () => {
  const step = (order: number, fileId: string, symbol: string): Step => ({ order, symbolId: `${fileId}#${symbol}`, fileId, why: 'because', diff: [] });

  it('lists the stops by order and joins a building that follows itself', () => {
    const steps = [step(3, OK, 'trim'), step(1, EYES, 'charge'), step(2, EYES, 'split'), step(4, 'src/nowhere.ts', 'x')];
    const city = buildCity(report([], steps));
    const stops = pathStops(city, steps);
    expect(stops.map((stop) => [stop.order, stop.building.id, stop.nth])).toEqual([
      [1, EYES, 0],
      [2, EYES, 1],
      [3, OK, 0],
    ]);
    expect(pathPoints(stops).map((building) => building.id)).toEqual([EYES, OK]);
    expect(pathStops(city, [])).toEqual([]);
  });
});
