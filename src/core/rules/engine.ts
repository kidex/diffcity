// The rules engine (ADR-030): runs the merged rules over the touched files of
// a change and gives the rule findings and one RuleCheck per configured rule.
// Runs in the snapshot worker as part of buildReport. Pure and deterministic:
// the same rules, files and time give the same output, in the same order.

import { createHash } from 'node:crypto';
import { symbolAtLine } from '../findings/anchor.js';
import { RULE_SOURCE_PREFIX } from '../findings/normalize.js';
import type { Finding, RuleCheck, Status, Symbol } from '../report/types.js';
import { checkFileSize, FILE_SIZE_DEFAULT_SEVERITY, fileSizeNeeds } from './file-size.js';
import { UNKNOWN_KIND_FALLBACK, type MergedRule } from './merge.js';

/** A file as the rules see it. */
export interface RuleFile {
  /** Repo-relative, `/` separators. */
  path: string;
  status: Status;
  /** The Report's symbols; ranges of symbols other than `del` are after-version lines. */
  symbols: readonly Symbol[];
  /**
   * The after version's size in bytes and its line count (null when it was
   * not counted: binary, or no rule asked for it). Null for a deleted file.
   */
  after: { bytes: number; lines: number | null } | null;
}

/** One violation, before it becomes a Finding. */
export interface RuleViolation {
  file: string;
  /** 1-based after-version line; 0 for the whole file. */
  line: number;
  /** Plain English; part of the finding id, so it must not change while the violation stays the same. */
  title: string;
  message: string;
}

export interface RuleRun {
  /** Sorted by file, line, source and id. */
  findings: Finding[];
  /** One per merged rule, sorted by rule id. */
  checks: RuleCheck[];
}

/**
 * `rule:<id>:` + sha256(file + "\n" + line + "\n" + title), stable across
 * snapshots (ADR-030). The separators keep `a.ts1` line 2 apart from `a.ts` line 12.
 */
export function ruleFindingId(ruleId: string, file: string, line: number, title: string): string {
  const digest = createHash('sha256').update(`${file}\n${String(line)}\n${title}`).digest('hex');
  return `${RULE_SOURCE_PREFIX}${ruleId}:${digest}`;
}

/** Only touched files are checked: an untouched file (`same`) is not part of the change's review. */
export function isRuleTarget(file: Pick<RuleFile, 'status'>): boolean {
  return file.status !== 'same';
}

/**
 * Whether the rules need the after version's size of `path`, and its line
 * count: buildReport measures only what some rule asks for. Null when no rule
 * looks at the file.
 */
export function measureNeeds(rules: readonly MergedRule[], path: string): { lines: boolean } | null {
  let measured = false;
  let lines = false;
  for (const entry of rules) {
    if (!entry.ok || entry.rule.kind !== 'file-size') continue;
    const own = fileSizeNeeds(entry.rule, path);
    if (own === null) continue;
    measured = true;
    lines ||= own.lines;
  }
  return measured ? { lines } : null;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Runs `rules` over `files` (untouched ones are skipped). `checkedAt` is the
 * Report's own time (meta.generatedAt), never read from the clock here: the
 * content hash leaves it out, like generatedAt.
 *
 * Kinds this version does not evaluate yet (layers, pipeline, cve) get
 * `not-checked`, never `passed`.
 */
export function runRules(rules: readonly MergedRule[], files: readonly RuleFile[], checkedAt: string): RuleRun {
  const targets = files.filter(isRuleTarget);
  const symbolsOf = new Map(targets.map((file) => [file.path, file.symbols]));
  const findings: Finding[] = [];
  const checks: RuleCheck[] = [];

  for (const entry of rules) {
    if (!entry.ok) {
      checks.push({ ruleId: entry.ruleId, kind: entry.kind ?? UNKNOWN_KIND_FALLBACK, state: 'error', reason: entry.reason, findings: 0, checkedAt });
      continue;
    }
    const { rule } = entry;
    if (rule.kind !== 'file-size') {
      checks.push({ ruleId: rule.id, kind: rule.kind, state: 'not-checked', findings: 0, checkedAt });
      continue;
    }
    const severity = rule.severity ?? FILE_SIZE_DEFAULT_SEVERITY;
    const violations = checkFileSize(rule, targets);
    for (const violation of violations) {
      const symbol = symbolAtLine({ symbols: [...(symbolsOf.get(violation.file) ?? [])] }, violation.line);
      findings.push({
        id: ruleFindingId(rule.id, violation.file, violation.line, violation.title),
        source: `${RULE_SOURCE_PREFIX}${rule.id}`,
        severity,
        category: 'style',
        file: violation.file,
        line: violation.line,
        ...(symbol === undefined ? {} : { symbolId: symbol.id }),
        title: violation.title,
        message: violation.message,
        state: 'open',
      });
    }
    checks.push({ ruleId: rule.id, kind: rule.kind, state: violations.length > 0 ? 'violations' : 'passed', findings: violations.length, checkedAt });
  }

  findings.sort(
    (a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.source, b.source) || compareStrings(a.id, b.id),
  );
  return { findings, checks };
}
