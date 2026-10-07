import type { File, Finding, Report, Verdict } from '../report/types.js';
import { fileVerdict } from '../verdict/index.js';
import { findFile, reanchor, symbolAtLine, unanchored } from './anchor.js';
import { dedup } from './dedup.js';
import { isRuleSource } from './normalize.js';
import type { FindingState, StoredFinding } from './types.js';

/** `Finding.source` of a finding computed by a rule (ADR-030). */
export function isRuleFinding(finding: Pick<Finding, 'source'>): boolean {
  return isRuleSource(finding.source);
}

/**
 * The Report as served: its rule findings plus the stored imported ones, each
 * re-anchored on this Report, with the states applied, the file verdicts
 * recomputed by `fileVerdict` (only the findings input changes) and
 * `summary.byVerdict` recounted. `checks` and everything else are untouched.
 * Pure: the input is not modified, so the HTML export can call it too.
 *
 * `ruleStates` maps a rule finding's id to its state ("Mark as intended").
 * A stored finding whose file is not in the Report is left out.
 */
export function overlay(
  report: Report,
  stored: readonly StoredFinding[],
  ruleStates: Readonly<Record<string, FindingState>>,
): Report {
  const rules: Finding[] = report.findings.filter(isRuleFinding).map((finding) => {
    const state = ruleStates[finding.id];
    const file = finding.file === '' ? undefined : findFile(report, finding.file);
    const symbol = file === undefined ? undefined : symbolAtLine(file, finding.line);
    const rest = unanchored(finding);
    const anchored: Finding =
      file === undefined ? { ...finding } : { ...rest, ...(symbol === undefined ? {} : { symbolId: symbol.id }) };
    return state === undefined ? anchored : { ...anchored, state };
  });

  const reanchored: StoredFinding[] = [];
  for (const entry of stored) {
    const finding = reanchor(entry, report);
    if (finding !== null) reanchored.push({ ...entry, finding });
  }
  const findings = [...rules, ...dedup(reanchored).map((entry) => entry.finding)];

  const tier1 = new Set(report.summary.tier1Files);
  const byVerdict: Record<Verdict, number> = { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 };
  const packages = report.packages.map((pkg) => ({
    ...pkg,
    files: pkg.files.map((file): File => {
      const verdict = fileVerdict({
        status: file.status,
        symbolStatuses: file.symbols.map((symbol) => symbol.status),
        tier1: tier1.has(file.path),
        findings: findings.filter((finding) => finding.file === file.path),
        inSpec: file.inSpec,
      });
      byVerdict[verdict] += 1;
      return { ...file, verdict };
    }),
  }));

  return { ...report, packages, findings, summary: { ...report.summary, byVerdict } };
}
