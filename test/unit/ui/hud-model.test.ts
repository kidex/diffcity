// hud/* (ADR-026): what the HUD shows, as data from the Report. Counters come
// from the summary, the Rules row counts rule findings, a check that is not
// passed is never shown as passed, and change-level findings read "CI failed"
// or a count.

import { describe, expect, it } from 'vitest';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { buildCity } from '../../../src/ui/screens/change/model/city.js';
import {
  cardData,
  changeLevel,
  checkChips,
  checksOf,
  findingsIndex,
  ruleChips,
  tipData,
  topBar,
  typeChips,
  verdictChips,
} from '../../../src/ui/screens/change/model/hud.js';
import goldenJson from '../../fixtures/scenarios/order-discounts/expected.json';

const golden = (): Report => structuredClone(goldenJson) as unknown as Report;

function finding(id: string, source: string, file: string, severity: Finding['severity'] = 'med'): Finding {
  return { id, source, severity, category: 'scope', file, line: file === '' ? 0 : 3, title: id, message: id, state: 'open' };
}

describe('hud model', () => {
  it('top bar and chips take their counters from the summary', () => {
    const report = golden();
    expect(topBar(report)).toEqual({
      files: 17,
      statuses: [
        { key: 'add', count: 14 },
        { key: 'mod', count: 8 },
        { key: 'sig', count: 1 },
        { key: 'del', count: 1 },
      ],
      eyes: 2,
    });
    expect(verdictChips(report).map((chip) => [chip.key, chip.count])).toEqual([
      ['eyes', 2],
      ['risky', 0],
      ['spec', 0],
      ['ok', 9],
      ['same', 6],
    ]);
    expect(typeChips(report).map((chip) => chip.count)).toEqual([14, 8, 1, 1]);
  });

  it('the Rules row has a chip per rule with findings on files, none without them', () => {
    const report = golden();
    expect(ruleChips(report)).toEqual([]);
    report.findings = [
      finding('a', 'rule:layers', 'src/auth/order.guard.ts'),
      finding('b', 'rule:file-size', 'src/repo/orders.repo.ts'),
      finding('c', 'rule:layers', 'src/repo/orders.repo.ts'),
      finding('d', 'claude', 'src/repo/orders.repo.ts'),
      finding('e', 'rule:ci', ''),
    ];
    expect(ruleChips(report)).toEqual([
      { key: 'layers', count: 2 },
      { key: 'file-size', count: 1 },
    ]);
  });

  it('a check that is missing, unknown or not run is never passed', () => {
    const report = golden();
    expect(checkChips(report)).toEqual([]);
    (report as unknown as { checks: unknown }).checks = [
      { ruleId: 'file-size', kind: 'file-size', state: 'passed', findings: 0, checkedAt: '2026-01-01T00:00:00.000Z' },
      { ruleId: 'layers', kind: 'layers', state: 'violations', findings: 1, checkedAt: '2026-01-01T00:00:00.000Z' },
      { ruleId: 'deps', kind: 'cve', state: 'not-checked', reason: 'offline', findings: 0, checkedAt: '2026-01-01T00:00:00.000Z' },
      { ruleId: 'build', kind: 'pipeline', state: 'pending', findings: 0, checkedAt: '2026-01-01T00:00:00.000Z' },
      { ruleId: 'odd', kind: 'layers', state: 'green', findings: 0 },
      { ruleId: '', kind: 'layers', state: 'passed', findings: 0 },
      'nonsense',
    ];
    expect(checkChips(report).map((chip) => [chip.ruleId, chip.state, chip.text])).toEqual([
      ['file-size', 'passed', 'file-size: passed'],
      ['layers', 'violations', 'layers: 1 violation'],
      ['deps', 'not-checked', 'deps: not checked (offline)'],
      ['build', 'pending', 'build: pending'],
      ['odd', 'not-checked', 'odd: not checked'],
    ]);
    expect(checksOf(report)).toHaveLength(5);
  });

  it('change-level findings read CI failed for a pipeline rule, a count for the rest', () => {
    const report = golden();
    expect(changeLevel(report)).toBeNull();
    report.findings = [finding('a', 'rule:layers', 'src/auth/order.guard.ts')];
    expect(changeLevel(report)).toBeNull();
    report.findings = [finding('b', 'claude', ''), finding('c', 'semgrep', '')];
    expect(changeLevel(report)).toEqual({ ciFailed: false, others: 2 });
    (report as unknown as { checks: unknown }).checks = [{ ruleId: 'build', kind: 'pipeline', state: 'violations', findings: 1 }];
    report.findings = [finding('d', 'rule:build', '')];
    expect(changeLevel(report)).toEqual({ ciFailed: true, others: 0 });
    report.findings.push(finding('e', 'claude', ''));
    expect(changeLevel(report)).toEqual({ ciFailed: true, others: 1 });
  });

  it('tooltip and card fields come from the building, the floor and the findings of its file', () => {
    const report = golden();
    report.findings = [finding('a', 'rule:layers', 'src/auth/order.guard.ts'), finding('b', 'claude', 'src/auth/order.guard.ts'), finding('c', 'claude', '')];
    const city = buildCity(report);
    const guard = city.byId.get('src/auth/order.guard.ts');
    if (guard === undefined) throw new Error('no guard');
    const index = findingsIndex(report);
    expect(index.get('src/auth/order.guard.ts')).toEqual({ total: 2, rules: 1 });
    expect(index.has('')).toBe(false);
    const tip = tipData(city, guard, guard.floors[1], index);
    expect(tip).toMatchObject({ verdict: 'eyes', file: 'order.guard.ts', pkg: 'src/auth', floor: guard.floors[1]?.name, findings: 2, violations: 1 });
    expect(tipData(city, guard, undefined, new Map())).toMatchObject({ floor: null, findings: 0, violations: 0 });
    const card = cardData(guard);
    expect(card).toMatchObject({ verdict: 'eyes', tier1: true, path: 'src/auth/order.guard.ts' });
    expect(card.floors.map((floor) => floor.name)).toEqual([...guard.floors].reverse().map((floor) => floor.name));
  });
});
