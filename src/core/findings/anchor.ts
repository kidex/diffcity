// Anchoring a finding to the symbols of the Report (SPEC.md 5.6, ADR-036). Pure.

import type { Fingerprints } from '../model/types.js';
import type { File, Finding, Report, Symbol } from '../report/types.js';
import { findingKey } from './normalize.js';
import type { AnchorResult, FindingInput, StoredFinding } from './types.js';

/** A copy of the finding without its `symbolId`. */
export function unanchored(finding: Finding): Finding {
  const copy = { ...finding };
  delete copy.symbolId;
  return copy;
}

export function findFile(report: Report, path: string): File | undefined {
  for (const pkg of report.packages) {
    const file = pkg.files.find((candidate) => candidate.path === path);
    if (file !== undefined) return file;
  }
  return undefined;
}

/**
 * The symbol of the after version whose range contains the line: the innermost
 * one when ranges nest (a method inside its class). A `del` symbol is never
 * matched, a finding line is an after line.
 */
export function symbolAtLine(file: File, line: number): Symbol | undefined {
  let best: Symbol | undefined;
  for (const symbol of file.symbols) {
    if (symbol.status === 'del') continue;
    if (line < symbol.range.start || line > symbol.range.end) continue;
    if (best === undefined || symbol.range.end - symbol.range.start < best.range.end - best.range.start) best = symbol;
  }
  return best;
}

/** The after-version symbol with this name and kind; the one nearest `near` when several share them. */
export function symbolByName(file: File, name: string, kind: Symbol['kind'], near: number): Symbol | undefined {
  let best: Symbol | undefined;
  for (const symbol of file.symbols) {
    if (symbol.status === 'del' || symbol.name !== name || symbol.kind !== kind) continue;
    if (best === undefined || Math.abs(symbol.range.start - near) < Math.abs(best.range.start - near)) best = symbol;
  }
  return best;
}

/** What the fingerprints say about an anchor: the symbol's hash, or the file's after hash at file level. */
export function fingerprintOf(file: File, symbol: Symbol | undefined, fingerprints: Fingerprints | undefined): string | null {
  if (fingerprints === undefined) return null;
  if (symbol !== undefined) return fingerprints.symbols[symbol.id] ?? null;
  return fingerprints.files[file.id]?.after ?? null;
}

/**
 * Resolves an import to a stored finding: the symbol it falls in, or the file
 * level. A file that is not part of the change is `skipped-not-in-change`.
 * `fingerprints` are the snapshot's (ADR-027); they are recorded for `fixed`.
 */
export function anchor(input: FindingInput, report: Report, fingerprints?: Fingerprints): AnchorResult {
  const file = findFile(report, input.file);
  if (file === undefined) return { ok: false, reason: 'skipped-not-in-change' };
  const symbol = symbolAtLine(file, input.line);
  const key = findingKey(input.source, input.file, input.title, input.line);
  const finding: Finding = {
    id: key,
    source: input.source,
    sources: [input.source],
    severity: input.severity,
    category: input.category,
    file: input.file,
    line: input.line,
    ...(symbol === undefined ? {} : { symbolId: symbol.id }),
    title: input.title,
    message: input.message,
    ...(input.fix === undefined ? {} : { fix: input.fix }),
    state: input.state ?? 'open',
  };
  const stored: StoredFinding = {
    key,
    ...(input.id === undefined ? {} : { alias: input.id }),
    ...(input.why === undefined ? {} : { why: input.why }),
    finding,
    anchor: {
      ...(symbol === undefined ? {} : { symbolName: symbol.name, symbolKind: symbol.kind, symbolStart: symbol.range.start }),
      fingerprint: fingerprintOf(file, symbol, fingerprints),
    },
  };
  return { ok: true, stored };
}

/**
 * The finding as it reads on this Report (a later head, ADR-036): found again
 * by `(file, symbol name, kind)`, its line carried by the symbol's shift; when
 * the symbol is gone, by its line clamped to the file's last symbol. `null`
 * when the file is not in the Report (the finding stays in the table).
 */
export function reanchor(stored: StoredFinding, report: Report): Finding | null {
  const { finding, anchor: a } = stored;
  const file = findFile(report, finding.file);
  if (file === undefined) return null;
  const rest = unanchored(finding);

  if (a.symbolName === undefined || a.symbolKind === undefined) return rest;

  const start = a.symbolStart ?? finding.line;
  const same = symbolByName(file, a.symbolName, a.symbolKind, start);
  if (same !== undefined) {
    const line = Math.max(1, finding.line + (same.range.start - start));
    return { ...rest, line, symbolId: same.id };
  }
  const last = file.symbols.reduce((max, symbol) => (symbol.status === 'del' ? max : Math.max(max, symbol.range.end)), 0);
  const line = Math.max(1, last > 0 ? Math.min(finding.line, last) : finding.line);
  const byLine = symbolAtLine(file, line);
  return { ...rest, line, ...(byLine === undefined ? {} : { symbolId: byLine.id }) };
}
