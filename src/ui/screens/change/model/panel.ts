// What the reading panel shows, as plain data from the Report (ADR-026): the
// stops of the execution path, findings grouped by file, the files outside the
// spec, the touched symbols, the counters of the tabs, the order J and K walk,
// and the file view's header. Presentation only: nothing here decides a
// status, a verdict, a path or where a finding sits; it all comes from the
// Report. Pure: no DOM, no three.js.

import { VERDICT_LABEL } from '../../../shared/format.js';
import type { File, Finding, Report, Status, Step, Symbol as ReportSymbol } from '../../../../core/report/types.js';

export type TabId = 'order' | 'findings' | 'outside' | 'symbols';

/** The tabs in the mockup's order; Session (phase 4) is not here. */
export const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'order', label: 'Execution order' },
  { id: 'findings', label: 'Findings' },
  { id: 'outside', label: 'Outside the spec' },
  { id: 'symbols', label: 'Symbols' },
];

/** The Execution order tab's text when the Report has no steps at all. */
export const EMPTY_STEPS = 'No execution path: nothing in this change reaches an entry point';
export const EMPTY_FINDINGS = 'No findings on this change';
export const EMPTY_OUTSIDE_NO_SPEC = 'This change has no spec to compare against';
export const EMPTY_OUTSIDE_ALL_IN = 'Every file is in the spec';
export const EMPTY_SYMBOLS = 'No symbol was touched by this change';
export const DIFF_IN_APP = 'Full diff is available in the app';
export const LATER_VERSION = 'Arrives in a later version';

/** A file of the Report with the path of its package. */
export interface PlacedFile {
  file: File;
  /** The package's path. */
  pkg: string;
  tier1: boolean;
}

export const placedFiles = (report: Report): PlacedFile[] =>
  report.packages.flatMap((pkg) => pkg.files.map((file) => ({ file, pkg: pkg.path, tier1: pkg.tier1 })));

export const fileIndex = (report: Report): Map<string, PlacedFile> => new Map(placedFiles(report).map((placed) => [placed.file.id, placed]));

// ---------- stops ----------

const STATE_RANK = { open: 0, intended: 1, fixed: 2 } as const;
const SEVERITY_RANK = { high: 0, med: 1, low: 2 } as const;

/** Open findings first, then intended, then fixed; within a state the more severe first; otherwise the Report's order. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        STATE_RANK[a.finding.state] - STATE_RANK[b.finding.state] ||
        SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
        a.index - b.index,
    )
    .map(({ finding }) => finding);
}

export interface Stop {
  /** The step's number, as drawn on the city's path. */
  order: number;
  step: Step;
  placed: PlacedFile;
  /** Null when the Report does not have the step's symbol. */
  symbol: ReportSymbol | null;
  /** Findings the Report anchored to the step's symbol (`symbolId`), open first. */
  findings: Finding[];
}

export type SectionId = NonNullable<Step['section']>;

/** The sections of the Execution order tab, in the order they are read (SPEC.md section 5.4): their heading and one line on what they hold. */
export const SECTIONS: readonly { id: SectionId; label: string; note: string }[] = [
  { id: 'path', label: 'Execution path', note: 'From each entry point, in the order the code runs' },
  { id: 'migration', label: 'Migrations', note: 'Touched SQL migrations, read after the execution path' },
  { id: 'unconnected', label: 'Unconnected', note: 'Touched symbols no entry point reaches' },
];

const SECTION_RANK: Record<SectionId, number> = { path: 0, migration: 1, unconnected: 2 };

/** The section a step is listed in: the Report's, `path` when it has none (Reports written before phase 4) or one this UI does not know. */
export const sectionOf = (step: Step): SectionId => (step.section !== undefined && Object.hasOwn(SECTION_RANK, step.section) ? step.section : 'path');

/** The steps whose file is in the Report, in reading order: by section (path, migrations, unconnected), then by `order`. */
export function stopsOf(report: Report): Stop[] {
  const files = fileIndex(report);
  const stops: Stop[] = [];
  const sorted = [...report.steps].sort((a, b) => SECTION_RANK[sectionOf(a)] - SECTION_RANK[sectionOf(b)] || a.order - b.order);
  for (const step of sorted) {
    const placed = files.get(step.fileId);
    if (placed === undefined) continue;
    stops.push({
      order: step.order,
      step,
      placed,
      symbol: placed.file.symbols.find((symbol) => symbol.id === step.symbolId) ?? null,
      findings: sortFindings(report.findings.filter((finding) => finding.symbolId === step.symbolId && finding.file === placed.file.path)),
    });
  }
  return stops;
}

export interface StopSection {
  id: SectionId;
  label: string;
  note: string;
  /** By `order`; never empty. */
  stops: Stop[];
}

/** The stops under their section headings; a section without stops is left out. */
export function stopSections(report: Report): StopSection[] {
  const stops = stopsOf(report);
  return SECTIONS.map((section) => ({ ...section, stops: stops.filter((stop) => sectionOf(stop.step) === section.id) })).filter(
    (section) => section.stops.length > 0,
  );
}

/** The Execution order tab's empty text: only when the Report has no step to list; null otherwise. */
export const emptyStepsText = (report: Report): string | null => (stopsOf(report).length === 0 ? EMPTY_STEPS : null);

// ---------- findings ----------

export interface FindingGroup {
  /** Null for the change-level findings (`file === ''`). */
  placed: PlacedFile | null;
  /** The finding's path; '' for the change-level group. */
  path: string;
  findings: Finding[];
}

/** Findings by file: the change-level ones first, then the files in the Report's order, then paths the Report has no file for. */
export function findingGroups(report: Report): FindingGroup[] {
  const byPath = new Map<string, Finding[]>();
  for (const finding of report.findings) byPath.set(finding.file, [...(byPath.get(finding.file) ?? []), finding]);
  const groups: FindingGroup[] = [];
  const changeLevel = byPath.get('');
  if (changeLevel !== undefined) groups.push({ placed: null, path: '', findings: sortFindings(changeLevel) });
  const seen = new Set<string>(['']);
  for (const placed of placedFiles(report)) {
    const found = byPath.get(placed.file.path);
    if (found === undefined || seen.has(placed.file.path)) continue;
    seen.add(placed.file.path);
    groups.push({ placed, path: placed.file.path, findings: sortFindings(found) });
  }
  for (const [path, found] of byPath) if (!seen.has(path)) groups.push({ placed: null, path, findings: sortFindings(found) });
  return groups;
}

/** The sources of the Report's findings, in order of first appearance: "Claude, semgrep, eslint" in the mockup's footer. */
export function findingSources(report: Report): string[] {
  return [...new Set(report.findings.map((finding) => finding.source))];
}

// ---------- outside the spec ----------

export interface OutsideSpec {
  files: PlacedFile[];
  /** False when no file has a spec verdict: the Report has no spec (`inSpec` null everywhere). */
  specKnown: boolean;
}

export function outsideSpec(report: Report): OutsideSpec {
  const all = placedFiles(report);
  return { files: all.filter((placed) => placed.file.inSpec === false), specKnown: all.some((placed) => placed.file.inSpec !== null) };
}

// ---------- symbols ----------

export interface SymbolGroup {
  placed: PlacedFile;
  symbols: ReportSymbol[];
}

/** The floors' order: source order. */
const bySource = (a: ReportSymbol, b: ReportSymbol): number => a.range.start - b.range.start || a.range.end - b.range.end || a.id.localeCompare(b.id);

/** Every touched symbol (status other than `same`) by file, in the Report's file order. */
export function touchedSymbols(report: Report): SymbolGroup[] {
  const groups: SymbolGroup[] = [];
  for (const placed of placedFiles(report)) {
    const symbols = placed.file.symbols.filter((symbol) => symbol.status !== 'same').sort(bySource);
    if (symbols.length > 0) groups.push({ placed, symbols });
  }
  return groups;
}

// ---------- counters and navigation ----------

export type Counters = Record<TabId, number>;

export function counters(report: Report): Counters {
  return {
    order: stopsOf(report).length,
    findings: report.findings.length,
    outside: outsideSpec(report).files.length,
    symbols: touchedSymbols(report).reduce((sum, group) => sum + group.symbols.length, 0),
  };
}

/** A building and, when known, one of its floors (a symbol id). */
export interface Target {
  fileId: string;
  symbolId: string | null;
}

/** What J and K walk: the stops in reading order, across the sections, or the touched symbols (as the Symbols tab lists them) when the Report has no steps. */
export function navTargets(report: Report): Target[] {
  const stops = stopsOf(report);
  if (stops.length > 0) return stops.map((stop) => ({ fileId: stop.step.fileId, symbolId: stop.step.symbolId }));
  return touchedSymbols(report).flatMap((group) => group.symbols.map((symbol) => ({ fileId: group.placed.file.id, symbolId: symbol.id })));
}

/**
 * The target after (`next`) or before (`prev`) `current`, never past either end.
 * `current` is found by file and symbol, or, when the symbol is not a target, by
 * file alone; with nothing current, either key goes to the first target.
 */
export function stepTarget(targets: readonly Target[], current: Target | null, direction: 'next' | 'prev'): Target | null {
  if (targets.length === 0) return null;
  let index = current === null ? -1 : targets.findIndex((target) => target.fileId === current.fileId && target.symbolId === current.symbolId);
  if (index < 0 && current !== null) index = targets.findIndex((target) => target.fileId === current.fileId);
  if (index < 0) return targets[0] ?? null;
  const next = Math.max(0, Math.min(targets.length - 1, index + (direction === 'next' ? 1 : -1)));
  return targets[next] ?? null;
}

/** What `[` and `]` walk: the touched buildings (status other than `same`, SPEC.md section 5.1), in the Report's order; no floor. */
export const touchedTargets = (report: Report): Target[] =>
  placedFiles(report)
    .filter((placed) => placed.file.status !== 'same')
    .map((placed) => ({ fileId: placed.file.id, symbolId: null }));

/** The polite live region's text for a selection: "Selected src/auth/guard.ts, Needs your eyes, tier 1"; null when the Report does not have the file. */
export function selectionAnnouncement(report: Report, fileId: string): string | null {
  const placed = fileIndex(report).get(fileId);
  if (placed === undefined) return null;
  return `Selected ${placed.file.path}, ${VERDICT_LABEL[placed.file.verdict]}${placed.tier1 ? ', tier 1' : ''}`;
}

/** Whether a stop is the current one: the focused symbol's, or, without a focus or a stop for it, any stop of the selected file. */
export function stopIsCurrent(stops: readonly Stop[], stop: Stop, current: Target | null): boolean {
  if (current === null || current.fileId !== stop.step.fileId) return false;
  const focused = stops.some((other) => other.step.fileId === current.fileId && other.step.symbolId === current.symbolId);
  return !focused || stop.step.symbolId === current.symbolId;
}

// ---------- file view ----------

export interface FileViewData {
  placed: PlacedFile;
  /** Symbols by status, the floors of the building: a file without symbols counts once, by its own status. */
  counts: Record<Status, number>;
  /** The file's stops, in reading order. */
  stops: Stop[];
  /** Findings of the file that are not on one of its stops. */
  loose: Finding[];
}

export function fileViewData(report: Report, fileId: string): FileViewData | null {
  const placed = fileIndex(report).get(fileId);
  if (placed === undefined) return null;
  const counts: Record<Status, number> = { add: 0, mod: 0, sig: 0, del: 0, same: 0 };
  if (placed.file.symbols.length === 0) counts[placed.file.status] += 1;
  for (const symbol of placed.file.symbols) counts[symbol.status] += 1;
  const stops = stopsOf(report).filter((stop) => stop.step.fileId === fileId);
  const onStops = new Set(stops.flatMap((stop) => stop.findings.map((finding) => finding.id)));
  const loose = sortFindings(report.findings.filter((finding) => finding.file === placed.file.path && !onStops.has(finding.id)));
  return { placed, counts, stops, loose };
}

/**
 * The reading-time-free summary under the title: "6 stops, in the order the
 * code runs" when every stop is on the execution path, "24 stops, in reading
 * order" when migrations or unconnected symbols follow it.
 */
export function summaryLine(report: Report): string {
  const stops = stopsOf(report);
  if (stops.length > 0) {
    const count = `${String(stops.length)} ${stops.length === 1 ? 'stop' : 'stops'}`;
    return stops.every((stop) => sectionOf(stop.step) === 'path') ? `${count}, in the order the code runs` : `${count}, in reading order`;
  }
  return 'No execution path';
}
