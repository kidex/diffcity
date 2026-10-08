import { createHash } from 'node:crypto';
import { parseFile } from '../parse/file.js';
import type { ParsedFile } from '../parse/file.js';
import type { ImportRef } from '../parse/imports.js';
import { languageForPath } from '../parse/language.js';
import type { ParsedSymbol } from '../parse/types.js';
import type { Status, Symbol } from '../report/types.js';

// Symbol and file status, SPEC.md section 5.1 with ADR-005, ADR-006 and ADR-008.

/** How git saw the file between base and head. */
export type GitChange = 'add' | 'del' | 'mod' | 'rename';

/** One changed file, with the contents of both versions. */
export interface FileChange {
  /** Path in the after version (the new path of a rename); symbol ids use it (ADR-011). */
  path: string;
  /** Path in the before version, for renames. Defaults to `path`. */
  oldPath?: string;
  change: GitChange;
  binary: boolean;
  /** Before content; `null` when the file did not exist or was not read (binary). */
  before: string | null;
  /** After content; `null` when the file no longer exists or was not read (binary). */
  after: string | null;
}

export interface FileStatus {
  status: Status;
  /** Ordered by range start, then id. Empty for binary and non-code files. */
  symbols: Symbol[];
}

/** Where a symbol sits in each version; a side it does not exist on is absent. */
export interface SymbolRanges {
  before?: Symbol['range'];
  after?: Symbol['range'];
}

/** FileStatus, plus each symbol's fingerprint: its id to sha256 of before slice + `\0` + after slice (ADR-027). */
export interface FileStatusWithFingerprints extends FileStatus {
  symbolFingerprints: Record<string, string>;
  /** Symbol id to its before and after ranges (the step diff slices them, ADR-034). */
  ranges: Record<string, SymbolRanges>;
  /** The imports of each parsed version, when asked for (ADR-031); a side that was not parsed is null. */
  imports?: { before: ImportRef[] | null; after: ImportRef[] | null };
}

export interface CompareOptions {
  /** Also extract the imports of both versions, from the trees the symbols come from. */
  imports?: boolean;
}

/** Lines `range.start`..`range.end` (1-based, inclusive) of `source`, joined with `\n`; empty for no source. */
function sliceOf(source: string | null, range: { start: number; end: number } | undefined): string {
  if (source === null || range === undefined) return '';
  return source.split('\n').slice(range.start - 1, range.end).join('\n');
}

function sliceHash(before: string, after: string): string {
  return createHash('sha256').update(before).update('\0').update(after).digest('hex');
}

/** Heaviest first (SPEC.md 5.1). */
const WEIGHT: Readonly<Record<Status, number>> = { sig: 4, add: 3, del: 2, mod: 1, same: 0 };

/** The heaviest status in the order sig > add > del > mod > same; `same` for none. */
export function heaviestStatus(statuses: Iterable<Status>): Status {
  let heaviest: Status = 'same';
  for (const status of statuses) if (WEIGHT[status] > WEIGHT[heaviest]) heaviest = status;
  return heaviest;
}

/** File status taken from git when no symbol decides it (ADR-008): a rename is `mod`. */
function gitStatus(change: GitChange): Status {
  return change === 'rename' ? 'mod' : change;
}

/**
 * Compares the before and after versions of one file and returns the status
 * of every symbol and of the file itself. Pure over the given contents.
 */
export async function compareFile(file: FileChange): Promise<FileStatus> {
  const { status, symbols } = await compareFileWithFingerprints(file);
  return { status, symbols };
}

/** compareFile, plus the fingerprint of every symbol (and, with `options.imports`, the imports of both versions). */
export async function compareFileWithFingerprints(file: FileChange, options: CompareOptions = {}): Promise<FileStatusWithFingerprints> {
  const noImports = options.imports === true ? { imports: { before: null, after: null } } : {};
  if (file.binary) return { status: gitStatus(file.change), symbols: [], symbolFingerprints: {}, ranges: {}, ...noImports };

  const beforeLanguage = languageForPath(file.oldPath ?? file.path);
  const afterLanguage = languageForPath(file.path);
  if (beforeLanguage === null && afterLanguage === null) return { status: gitStatus(file.change), symbols: [], symbolFingerprints: {}, ranges: {}, ...noImports };

  const parseOptions = { imports: options.imports === true };
  const [before, after] = await Promise.all([
    file.before === null || beforeLanguage === null ? null : parseFile(file.before, beforeLanguage, parseOptions),
    file.after === null || afterLanguage === null ? null : parseFile(file.after, afterLanguage, parseOptions),
  ]);
  const detailed = compareSymbols(file.path, before?.symbols ?? [], after?.symbols ?? []);
  const symbols = detailed.map((entry) => entry.symbol);
  const symbolFingerprints: Record<string, string> = {};
  const ranges: Record<string, SymbolRanges> = {};
  for (const entry of detailed) {
    symbolFingerprints[entry.symbol.id] = sliceHash(sliceOf(file.before, entry.beforeRange), sliceOf(file.after, entry.afterRange));
    const sides: SymbolRanges = {};
    if (entry.beforeRange !== undefined) sides.before = entry.beforeRange;
    if (entry.afterRange !== undefined) sides.after = entry.afterRange;
    ranges[entry.symbol.id] = sides;
  }
  const result: FileStatusWithFingerprints = { status: fileStatus(file, before, after, symbols), symbols, symbolFingerprints, ranges };
  if (options.imports === true) result.imports = { before: before?.imports ?? null, after: after?.imports ?? null };
  return result;
}

/**
 * Symbols of a file that did not change between before and after, all `same`,
 * with the same ids and order `compareFile` gives when both versions are
 * `source`. Parses once. Empty for unsupported languages.
 */
export async function unchangedSymbols(path: string, source: string): Promise<Symbol[]> {
  return (await unchangedSymbolsWithFingerprints(path, source)).symbols;
}

/** unchangedSymbols, plus each symbol's fingerprint (before slice equals after slice). */
export async function unchangedSymbolsWithFingerprints(
  path: string,
  source: string,
): Promise<{ symbols: Symbol[]; symbolFingerprints: Record<string, string> }> {
  const language = languageForPath(path);
  if (language === null) return { symbols: [], symbolFingerprints: {} };
  const { symbols } = await parseFile(source, language);
  const detailed = compareSymbols(path, symbols, symbols);
  const symbolFingerprints: Record<string, string> = {};
  for (const entry of detailed) {
    const slice = sliceOf(source, entry.afterRange);
    symbolFingerprints[entry.symbol.id] = sliceHash(slice, slice);
  }
  return { symbols: detailed.map((entry) => entry.symbol), symbolFingerprints };
}

function fileStatus(file: FileChange, before: ParsedFile | null, after: ParsedFile | null, symbols: Symbol[]): Status {
  const heaviest = heaviestStatus(symbols.map((s) => s.status));
  if (heaviest !== 'same') return heaviest;
  // No changed symbol (ADR-008). A pure rename is still a change: mod.
  if (file.change === 'rename') return 'mod';
  // Only whitespace and comments differ anywhere in the file (ADR-005).
  if (before !== null && after !== null && before.normalized === after.normalized) return 'same';
  return gitStatus(file.change);
}

function symbolStatus(before: ParsedSymbol, after: ParsedSymbol): Status {
  if (before.signature !== after.signature) return 'sig';
  if (before.body !== after.body) return 'mod';
  return 'same';
}

/**
 * Match keys for one version: kind, unsuffixed qualified name and the
 * occurrence among symbols with that kind and name. Duplicate suffixes are
 * numbered across kinds, so they cannot be used to match (an added
 * `export { parse }` above `function parse` would shift them).
 */
function matchKeys(symbols: readonly ParsedSymbol[]): string[] {
  const seen = new Map<string, number>();
  return symbols.map((symbol) => {
    const group = `${symbol.kind}\u0000${symbol.baseQualifiedName}`;
    const occurrence = seen.get(group) ?? 0;
    seen.set(group, occurrence + 1);
    return `${group}\u0000${String(occurrence)}`;
  });
}

interface Entry {
  symbol: ParsedSymbol;
  id: string;
  status: Status;
  before?: ParsedSymbol;
}

/** A report symbol with where it sits in each version (absent on the side it does not exist). */
interface DetailedSymbol {
  symbol: Symbol;
  beforeRange?: Symbol['range'];
  afterRange?: Symbol['range'];
}

function compareSymbols(path: string, before: ParsedSymbol[], after: ParsedSymbol[]): DetailedSymbol[] {
  const beforeKeys = matchKeys(before);
  const afterKeys = matchKeys(after);
  const beforeByKey = new Map(before.map((symbol, i) => [beforeKeys[i], symbol]));
  const matched = new Set(afterKeys);

  // After-version symbols keep their qualified name as the id (ADR-011).
  const entries: Entry[] = after.map((symbol, i): Entry => {
    const previous = beforeByKey.get(afterKeys[i]);
    return previous === undefined
      ? { symbol, id: symbol.qualifiedName, status: 'add' }
      : { symbol, id: symbol.qualifiedName, status: symbolStatus(previous, symbol), before: previous };
  });

  // Deleted symbols get the first free id among `base`, `base~2`, `base~3`, ...
  const used = new Set(entries.map((e) => e.id));
  before.forEach((symbol, i) => {
    if (matched.has(beforeKeys[i] ?? '')) return;
    const base = symbol.baseQualifiedName;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}~${String(n)}`;
    used.add(id);
    entries.push({ symbol, id, status: 'del' });
  });

  return entries
    .map(({ symbol, id, status, before: previous }): DetailedSymbol => {
      const out: Symbol = {
        id: `${path}#${id}`,
        name: symbol.baseQualifiedName,
        kind: symbol.kind,
        status,
        range: { ...symbol.range },
      };
      if (status === 'sig' && previous !== undefined) {
        out.signatureBefore = previous.signatureText;
        out.signatureAfter = symbol.signatureText;
      }
      const detailed: DetailedSymbol = { symbol: out };
      if (status === 'del') detailed.beforeRange = { ...symbol.range };
      else {
        detailed.afterRange = { ...symbol.range };
        if (previous !== undefined) detailed.beforeRange = { ...previous.range };
      }
      return detailed;
    })
    .sort(
      (a, b) =>
        a.symbol.range.start - b.symbol.range.start || compare(a.symbol.id, b.symbol.id) || compare(a.symbol.kind, b.symbol.kind),
    );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
