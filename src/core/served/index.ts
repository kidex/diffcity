// The Report as the daemon serves it (ADR-036), its verdict counts for the
// change list (DC-106), and the finding a findings action names. Pure: the
// daemon reads the stored Report, the stored findings and the rule states, and
// caches the result per snapshot and findings version.

import {
  dedup,
  dedupIdentity,
  isRuleFinding,
  overlay,
  reanchor,
  type FindingState,
  type StoredFinding,
} from '../findings/index.js';
import type { ChangeStats } from '../model/types.js';
import type { Finding, Report, Verdict } from '../report/types.js';

export interface ServedFindings {
  /** The imported findings of the change, in import order (FindingsStore.list). */
  stored: readonly StoredFinding[];
  /** The states set on rule findings (FindingsStore.ruleStates). */
  ruleStates: Readonly<Record<string, FindingState>>;
}

/** Whether the served Report differs from the stored one: any imported finding or rule state. */
export function hasOverlay(findings: ServedFindings): boolean {
  return findings.stored.length > 0 || Object.keys(findings.ruleStates).length > 0;
}

/** The overlaid Report, or null when the stored Report is served as it is. */
function overlaid(reportJson: string, findings: ServedFindings): Report | null {
  if (!hasOverlay(findings)) return null;
  // The why overrides of imported findings (DC-97, `applyWhyOverrides` in
  // src/core/path/) are applied here, to the overlaid Report, once they are on main.
  return overlay(JSON.parse(reportJson) as Report, findings.stored, findings.ruleStates);
}

/** The served Report as text, and the verdict counts it carries. */
export interface ServedOverlay {
  body: string;
  /** Its `summary.byVerdict`; null when `body` is the stored string (the stored counts stand). */
  byVerdict: Record<Verdict, number> | null;
}

/**
 * The served Report and its counts in one overlay: with no imported finding
 * and no rule state, `reportJson` itself, unparsed; otherwise the stored
 * Report with the overlay applied (findings, `file.verdict`, `summary.byVerdict`).
 */
export function serveOverlay(reportJson: string, findings: ServedFindings): ServedOverlay {
  const served = overlaid(reportJson, findings);
  return served === null ? { body: reportJson, byVerdict: null } : { body: JSON.stringify(served), byVerdict: served.summary.byVerdict };
}

/** The served Report as JSON text (`serveOverlay(...).body`). */
export function serveReport(reportJson: string, findings: ServedFindings): string {
  return serveOverlay(reportJson, findings).body;
}

/**
 * The served Report's `summary.byVerdict` without serialising it (the change
 * list, DC-106); null when there is nothing to overlay, so the stored counts
 * stand and `reportJson` is not parsed.
 */
export function servedByVerdict(reportJson: string, findings: ServedFindings): Record<Verdict, number> | null {
  return overlaid(reportJson, findings)?.summary.byVerdict ?? null;
}

/** `stats` as listed for a served Report with counts `byVerdict` (DC-106): only `filesByVerdict` moves. */
export function servedStats(stats: ChangeStats, byVerdict: Readonly<Record<Verdict, number>>): ChangeStats {
  return { ...stats, filesByVerdict: { ...byVerdict } };
}

/** A part of a served finding: one stored imported finding and its state. */
export interface FindingPart {
  key: string;
  state: FindingState;
}

/** The finding a key names on the latest Report. */
export type ResolvedFinding =
  /** A rule finding of the Report, with its rule state applied. */
  | { origin: 'rule'; finding: Finding }
  /**
   * An imported finding: the entry as served (merged with the findings dedup
   * puts it with), and the stored findings that make it, in import order. A
   * finding whose file left the change is served nowhere; it is its own part.
   */
  | { origin: 'import'; finding: Finding; parts: FindingPart[] };

/**
 * Resolves `key` against the latest Report: the id of a rule finding of the
 * Report, or the key of a stored imported finding (the first key of a merged
 * entry or any of its other parts). Null when it names neither.
 */
export function resolveFinding(report: Report, findings: ServedFindings, key: string): ResolvedFinding | null {
  const rule = report.findings.find((finding) => isRuleFinding(finding) && finding.id === key);
  if (rule !== undefined) {
    const state = findings.ruleStates[key];
    return { origin: 'rule', finding: state === undefined ? rule : { ...rule, state } };
  }
  const target = findings.stored.find((entry) => entry.key === key);
  if (target === undefined) return null;
  const current = reanchor(target, report);
  if (current === null) return { origin: 'import', finding: target.finding, parts: [{ key, state: target.finding.state }] };

  const identity = dedupIdentity(current);
  const group: StoredFinding[] = [];
  for (const entry of findings.stored) {
    const finding = entry.key === key ? current : reanchor(entry, report);
    if (finding !== null && dedupIdentity(finding) === identity) group.push({ ...entry, finding });
  }
  const [merged] = dedup(group);
  if (merged === undefined) throw new Error(`finding ${key} has no merged entry`);
  return { origin: 'import', finding: merged.finding, parts: group.map((entry) => ({ key: entry.key, state: entry.finding.state })) };
}

/**
 * The stored findings a state write applies to, so the merged entry reads as
 * asked (dedup: `intended` if any part is, else `open` if any part is): every
 * part that is not `fixed`, or every part when all of them are `fixed`. A
 * part one source fixed stays fixed while another part is still reported.
 */
export function stateTargets(parts: readonly FindingPart[]): string[] {
  const live = parts.filter((part) => part.state !== 'fixed');
  return (live.length > 0 ? live : parts).map((part) => part.key);
}
