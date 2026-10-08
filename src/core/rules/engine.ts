// The rules engine (ADR-030): runs the merged rules over the touched files of
// a change and gives the rule findings and one RuleCheck per configured rule.
// Runs in the snapshot worker as part of buildReport. Pure and deterministic:
// the same rules, files and time give the same output, in the same order.

import { createHash } from 'node:crypto';
import { symbolAtLine } from '../findings/anchor.js';
import { RULE_SOURCE_PREFIX } from '../findings/normalize.js';
import type { ImportRef } from '../parse/imports.js';
import type { Finding, RuleCheck, Status, Symbol } from '../report/types.js';
import type { Severity } from './config.js';
import { checkFileSize, FILE_SIZE_DEFAULT_SEVERITY, fileSizeNeeds } from './file-size.js';
import { checkLayers, LAYERS_DEFAULT_SEVERITY, layersReason, type LayersContext } from './layers.js';
import { UNKNOWN_KIND_FALLBACK, type MergedRule } from './merge.js';

/** A file as the rules see it. */
export interface RuleFile {
  /** Repo-relative, `/` separators. */
  path: string;
  /** The before version's path, for a rename. */
  oldPath?: string | undefined;
  status: Status;
  /** The Report's symbols; ranges of symbols other than `del` are after-version lines. */
  symbols: readonly Symbol[];
  /**
   * The after version's size in bytes and its line count (null when it was
   * not counted: binary, or no rule asked for it). Null for a deleted file.
   */
  after: { bytes: number; lines: number | null } | null;
  /**
   * The imports of each version (ADR-031), extracted only when a layers rule
   * runs; a side that was not parsed (absent, binary, too large) is null.
   */
  imports?: { before: readonly ImportRef[] | null; after: readonly ImportRef[] | null } | undefined;
}

/** What the rules know of the whole snapshot, beyond the touched files (the layers rule's file lists). */
export type RuleContext = LayersContext;

const EMPTY_CONTEXT: RuleContext = { afterFiles: new Set(), beforeFiles: new Set(), tsconfigPaths: null };

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

/** Whether a layers rule runs: buildReport extracts imports only then. */
export function rulesNeedImports(rules: readonly MergedRule[]): boolean {
  return rules.some((entry) => entry.ok && entry.rule.kind === 'layers');
}

/** Whether a layers rule reads the root tsconfig's `compilerOptions.paths`. */
export function rulesNeedTsconfigPaths(rules: readonly MergedRule[]): boolean {
  return rules.some((entry) => entry.ok && entry.rule.kind === 'layers' && entry.rule.useTsconfigPaths === true);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Runs `rules` over `files` (untouched ones are skipped). `checkedAt` is the
 * Report's own time (meta.generatedAt), never read from the clock here: the
 * content hash leaves it out, like generatedAt. `context` carries the
 * snapshot's file lists for the layers rule.
 *
 * Kinds this version does not evaluate yet (pipeline, cve) get
 * `not-checked`, never `passed`.
 */
export function runRules(rules: readonly MergedRule[], files: readonly RuleFile[], checkedAt: string, context: RuleContext = EMPTY_CONTEXT): RuleRun {
  const targets = files.filter(isRuleTarget);
  const symbolsOf = new Map(targets.map((file) => [file.path, file.symbols]));
  const findings: Finding[] = [];
  const checks: RuleCheck[] = [];

  /** Turns violations into findings, one per id (two statements on one line with one title are one finding). */
  const report = (ruleId: string, severity: Severity, category: Finding['category'], violations: readonly RuleViolation[]): number => {
    const ids = new Set<string>();
    for (const violation of violations) {
      const id = ruleFindingId(ruleId, violation.file, violation.line, violation.title);
      if (ids.has(id)) continue;
      ids.add(id);
      const symbol = symbolAtLine({ symbols: [...(symbolsOf.get(violation.file) ?? [])] }, violation.line);
      findings.push({
        id,
        source: `${RULE_SOURCE_PREFIX}${ruleId}`,
        severity,
        category,
        file: violation.file,
        line: violation.line,
        ...(symbol === undefined ? {} : { symbolId: symbol.id }),
        title: violation.title,
        message: violation.message,
        state: 'open',
      });
    }
    return ids.size;
  };

  for (const entry of rules) {
    if (!entry.ok) {
      checks.push({ ruleId: entry.ruleId, kind: entry.kind ?? UNKNOWN_KIND_FALLBACK, state: 'error', reason: entry.reason, findings: 0, checkedAt });
      continue;
    }
    const { rule } = entry;
    switch (rule.kind) {
      case 'file-size': {
        const count = report(rule.id, rule.severity ?? FILE_SIZE_DEFAULT_SEVERITY, 'style', checkFileSize(rule, targets));
        checks.push({ ruleId: rule.id, kind: rule.kind, state: count > 0 ? 'violations' : 'passed', findings: count, checkedAt });
        break;
      }
      case 'layers': {
        const { violations, unresolved } = checkLayers(rule, targets, context);
        const count = report(rule.id, rule.severity ?? LAYERS_DEFAULT_SEVERITY, 'architecture', violations);
        const reason = layersReason(unresolved);
        // Unresolved imports are never passing evidence: the reason says how many there were.
        checks.push({ ruleId: rule.id, kind: rule.kind, state: count > 0 ? 'violations' : 'passed', ...(reason === undefined ? {} : { reason }), findings: count, checkedAt });
        break;
      }
      default:
        checks.push({ ruleId: rule.id, kind: rule.kind, state: 'not-checked', findings: 0, checkedAt });
    }
  }

  findings.sort(
    (a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.source, b.source) || compareStrings(a.id, b.id),
  );
  return { findings, checks };
}
