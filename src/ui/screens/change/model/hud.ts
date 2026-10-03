// What the HUD shows, as plain data from the Report (ADR-026): top-bar
// counters, filter chips with their counters, rule-check chips, change-level
// findings, and the tooltip and selection-card fields. Presentation only:
// counters come from Report.summary where it has them; the Rules row counts
// rule findings, which no summary carries. Pure: no DOM, no three.js.

import type { Report, Status, Verdict } from '../../../../core/report/types.js';
import { CHANGED_STATUSES, VERDICTS } from '../../../shared/format.js';
import type { City, CityBuilding, CityFloor } from './city.js';
import type { ChangedStatus } from './view.js';
import { ruleOf } from './view.js';

export interface Counted<T> {
  key: T;
  count: number;
}

export interface TopBar {
  files: number;
  /** Symbols by status, from `summary.byStatus`, in the mockup's order. */
  statuses: Counted<ChangedStatus>[];
  /** Files whose verdict is `eyes`: the "need your eyes" badge. */
  eyes: number;
}

export function topBar(report: Report): TopBar {
  const { summary } = report;
  return {
    files: summary.files,
    statuses: CHANGED_STATUSES.map((status) => ({ key: status, count: summary.byStatus[status] })),
    eyes: summary.byVerdict.eyes,
  };
}

/** Row 1: every verdict with its file count, in the table order. */
export const verdictChips = (report: Report): Counted<Verdict>[] => VERDICTS.map((verdict) => ({ key: verdict, count: report.summary.byVerdict[verdict] }));

/** Row 2: every changed status with its symbol count. */
export const typeChips = (report: Report): Counted<ChangedStatus>[] => topBar(report).statuses;

/**
 * Row 3: one chip per rule that has a finding on a file, with the number of
 * its findings; in order of first appearance. Empty when the Report has no
 * rule findings, which hides the row.
 */
export function ruleChips(report: Report): Counted<string>[] {
  const counts = new Map<string, number>();
  for (const finding of report.findings) {
    const rule = ruleOf(finding.source);
    if (rule === null || finding.file === '') continue;
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => ({ key, count }));
}

// ---------- rule checks (SPEC.md section 4.1: Report.checks, phase 4) ----------

export type CheckState = 'passed' | 'violations' | 'not-checked' | 'pending' | 'error';

/** One configured rule's check, as the daemon reports it. */
export interface RuleCheck {
  ruleId: string;
  kind: string;
  state: CheckState;
  reason?: string;
  findings: number;
  checkedAt?: string;
}

export interface CheckChip {
  ruleId: string;
  state: CheckState;
  /** Visible text: `file-size: passed`, `layers: 3 violations`, `cve: not checked (offline)`. */
  text: string;
  /** The reason a rule could not run, when the daemon gave one. */
  reason: string | null;
}

const CHECK_STATES: ReadonlySet<string> = new Set<CheckState>(['passed', 'violations', 'not-checked', 'pending', 'error']);

/**
 * The Report's checks. `checks` is optional in the data model, and the core
 * type does not declare it yet, so it is read defensively; an entry without
 * a rule id is dropped, and an unknown state counts as `not-checked`: a
 * check that cannot be read is never shown as passed.
 */
export function checksOf(report: Report): RuleCheck[] {
  const raw = (report as { checks?: unknown }).checks;
  if (!Array.isArray(raw)) return [];
  const checks: RuleCheck[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate['ruleId'] !== 'string' || candidate['ruleId'] === '') continue;
    const state = typeof candidate['state'] === 'string' && CHECK_STATES.has(candidate['state']) ? (candidate['state'] as CheckState) : 'not-checked';
    const findings = typeof candidate['findings'] === 'number' ? candidate['findings'] : 0;
    checks.push({
      ruleId: candidate['ruleId'],
      kind: typeof candidate['kind'] === 'string' ? candidate['kind'] : '',
      state,
      findings,
      ...(typeof candidate['reason'] === 'string' && candidate['reason'] !== '' ? { reason: candidate['reason'] } : {}),
    });
  }
  return checks;
}

export function checkChips(report: Report): CheckChip[] {
  return checksOf(report).map((check) => {
    const reason = check.reason ?? null;
    let text: string;
    switch (check.state) {
      case 'passed':
        text = `${check.ruleId}: passed`;
        break;
      case 'violations':
        text = `${check.ruleId}: ${plural(check.findings, 'violation')}`;
        break;
      case 'pending':
        text = `${check.ruleId}: pending`;
        break;
      case 'error':
        text = `${check.ruleId}: could not run`;
        break;
      case 'not-checked':
        text = `${check.ruleId}: not checked${reason === null ? '' : ` (${reason})`}`;
        break;
    }
    return { ruleId: check.ruleId, state: check.state, text, reason };
  });
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

// ---------- change-level findings ----------

export interface ChangeLevel {
  /** A change-level finding of a pipeline rule: the CI run failed. */
  ciFailed: boolean;
  /** Change-level findings that are not the CI failure. */
  others: number;
}

/**
 * Findings with no file (`file === ''`, SPEC.md section 4.1) belong to the
 * change as a whole. One of a `pipeline` rule reads "CI failed"; the rest are
 * counted. Null when there is none.
 */
export function changeLevel(report: Report): ChangeLevel | null {
  const pipelines = new Set(checksOf(report).filter((check) => check.kind === 'pipeline').map((check) => check.ruleId));
  let ciFailed = false;
  let others = 0;
  for (const finding of report.findings) {
    if (finding.file !== '') continue;
    const rule = ruleOf(finding.source);
    if (rule !== null && pipelines.has(rule)) ciFailed = true;
    else others += 1;
  }
  return ciFailed || others > 0 ? { ciFailed, others } : null;
}

export const changeLevelText = (count: number): string => `${String(count)} change-level ${count === 1 ? 'finding' : 'findings'}`;

// ---------- crumb (standalone screen, without the SPA's own breadcrumb) ----------

/** `4 commits` as the mockup writes it; the caller adds the relative time. */
export const commitsText = (commits: number): string => plural(commits, 'commit');

// ---------- tooltip and selection card ----------

/** Findings of a file by path: all, and the rule violations among them. */
export interface FileFindings {
  total: number;
  rules: number;
}

export type FindingsIndex = ReadonlyMap<string, FileFindings>;

export function findingsIndex(report: Pick<Report, 'findings'>): FindingsIndex {
  const index = new Map<string, FileFindings>();
  for (const finding of report.findings) {
    if (finding.file === '') continue;
    const entry = index.get(finding.file) ?? { total: 0, rules: 0 };
    entry.total += 1;
    if (ruleOf(finding.source) !== null) entry.rules += 1;
    index.set(finding.file, entry);
  }
  return index;
}

export interface TipData {
  verdict: Verdict;
  file: string;
  /** The lot's package path. */
  pkg: string;
  /** Floors by status. */
  counts: Record<Status, number>;
  /** The floor under the cursor: its symbol name; null when there is none. */
  floor: string | null;
  /** Findings of the file, rule violations included. */
  findings: number;
  /** Rule violations among them; 0 hides the line. */
  violations: number;
}

export function tipData(city: City, building: CityBuilding, floor: CityFloor | undefined, findings: FindingsIndex): TipData {
  const found = findings.get(building.file.path);
  return {
    verdict: building.verdict,
    file: building.name,
    pkg: city.lots[building.lot]?.pkg.path ?? '',
    counts: building.counts,
    floor: floor === undefined ? null : floor.name,
    findings: found?.total ?? 0,
    violations: found?.rules ?? 0,
  };
}

export interface CardFloor {
  name: string;
  status: Status;
}

export interface CardData {
  verdict: Verdict;
  tier1: boolean;
  /** The file's path, whole. */
  path: string;
  counts: Record<Status, number>;
  /** Symbols from the top floor down, with their status. */
  floors: CardFloor[];
}

export function cardData(building: CityBuilding): CardData {
  return {
    verdict: building.verdict,
    tier1: building.tier1,
    path: building.file.path,
    counts: building.counts,
    floors: [...building.floors].reverse().map((floor) => ({ name: floor.name, status: floor.status })),
  };
}

/** The mockup's counter line: `+3 added`, `1 modified`, `0 sig`, `0 removed`. */
export function countLine(counts: Record<Status, number>): { status: ChangedStatus; text: string; count: number }[] {
  return [
    { status: 'add', count: counts.add, text: 'added' },
    { status: 'mod', count: counts.mod, text: 'modified' },
    { status: 'sig', count: counts.sig, text: 'sig' },
    { status: 'del', count: counts.del, text: 'removed' },
  ];
}
