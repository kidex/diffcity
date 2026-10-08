// The file-size rule (ADR-030): a touched file over `maxLines` or `maxBytes`,
// and a symbol of a touched file over `maxSymbolLines`, in the after version.
// Pure: the sizes come in with the file.

import type { Symbol } from '../report/types.js';
import { scopeOf, type FileSizeRule, type Severity } from './config.js';
import type { RuleFile, RuleViolation } from './engine.js';

export const FILE_SIZE_DEFAULT_SEVERITY: Severity = 'low';

const KIND_LABEL: Record<Symbol['kind'], string> = {
  class: 'Class',
  function: 'Function',
  method: 'Method',
  export: 'Export',
  sql: 'SQL statement',
};

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** What the rule needs to know about the after version of `path`; null when the file is out of its scope. */
export function fileSizeNeeds(rule: FileSizeRule, path: string): { lines: boolean } | null {
  if (!scopeOf(rule.include, rule.exclude)(path)) return null;
  return { lines: rule.maxLines !== undefined };
}

/**
 * The violations of one file-size rule over the touched files. Titles name the
 * limit, not the measure, so a finding keeps its id while the file grows;
 * the measure is in the message. A whole-file violation is on line 0, which
 * no symbol range contains: it stays at file level (SPEC.md 5.6). A symbol
 * violation is on the symbol's first line.
 */
export function checkFileSize(rule: FileSizeRule, files: readonly RuleFile[]): RuleViolation[] {
  const inScope = scopeOf(rule.include, rule.exclude);
  const violations: RuleViolation[] = [];
  for (const file of files) {
    if (file.after === null || !inScope(file.path)) continue;
    const { lines, bytes } = file.after;
    if (rule.maxLines !== undefined && lines !== null && lines > rule.maxLines) {
      violations.push({
        file: file.path,
        line: 0,
        title: `File over ${plural(rule.maxLines, 'line')}`,
        message: `${file.path} has ${plural(lines, 'line')}; the limit is ${plural(rule.maxLines, 'line')}.`,
      });
    }
    if (rule.maxBytes !== undefined && bytes > rule.maxBytes) {
      violations.push({
        file: file.path,
        line: 0,
        title: `File over ${plural(rule.maxBytes, 'byte')}`,
        message: `${file.path} is ${plural(bytes, 'byte')}; the limit is ${plural(rule.maxBytes, 'byte')}.`,
      });
    }
    if (rule.maxSymbolLines !== undefined) {
      for (const symbol of file.symbols) {
        // A deleted symbol has no after version to measure.
        if (symbol.status === 'del') continue;
        const span = symbol.range.end - symbol.range.start + 1;
        if (span <= rule.maxSymbolLines) continue;
        violations.push({
          file: file.path,
          line: symbol.range.start,
          title: `${KIND_LABEL[symbol.kind]} ${symbol.name} over ${plural(rule.maxSymbolLines, 'line')}`,
          message: `${symbol.name} spans ${plural(span, 'line')} (lines ${String(symbol.range.start)}-${String(symbol.range.end)}); the limit is ${plural(rule.maxSymbolLines, 'line')}.`,
        });
      }
    }
  }
  return violations;
}
