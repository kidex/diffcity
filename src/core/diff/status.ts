import { withDuplicateSuffixes } from '../parse/dedupe.js';
import { parseFile } from '../parse/file.js';
import type { ParsedFile } from '../parse/file.js';
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
  if (file.binary) return { status: gitStatus(file.change), symbols: [] };

  const beforeLanguage = languageForPath(file.oldPath ?? file.path);
  const afterLanguage = languageForPath(file.path);
  if (beforeLanguage === null && afterLanguage === null) return { status: gitStatus(file.change), symbols: [] };

  const [before, after] = await Promise.all([
    file.before === null || beforeLanguage === null ? null : parseFile(file.before, beforeLanguage),
    file.after === null || afterLanguage === null ? null : parseFile(file.after, afterLanguage),
  ]);
  const symbols = compareSymbols(file.path, before?.symbols ?? [], after?.symbols ?? []);
  return { status: fileStatus(file, before, after, symbols), symbols };
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

/** Symbols match on qualified name and kind. */
function matchKey(symbol: ParsedSymbol): string {
  return `${symbol.kind}\u0000${symbol.qualifiedName}`;
}

function symbolStatus(before: ParsedSymbol, after: ParsedSymbol): Status {
  if (before.signature !== after.signature) return 'sig';
  if (before.body !== after.body) return 'mod';
  return 'same';
}

interface Entry {
  symbol: ParsedSymbol;
  status: Status;
  before?: ParsedSymbol;
}

function compareSymbols(path: string, before: ParsedSymbol[], after: ParsedSymbol[]): Symbol[] {
  const beforeByKey = new Map(before.map((s) => [matchKey(s), s]));
  const afterKeys = new Set(after.map(matchKey));

  const entries: Entry[] = [
    ...after.map((symbol): Entry => {
      const previous = beforeByKey.get(matchKey(symbol));
      return previous === undefined
        ? { symbol, status: 'add' }
        : { symbol, status: symbolStatus(previous, symbol), before: previous };
    }),
    ...before.filter((s) => !afterKeys.has(matchKey(s))).map((symbol): Entry => ({ symbol, status: 'del' })),
  ];

  // Qualified names are unique within one version; a name whose kind changed
  // yields an `add` and a `del` with the same name, so the `del` gets `~N` (ADR-011).
  const ids = withDuplicateSuffixes(entries.map((e) => e.symbol.qualifiedName));

  return entries
    .map((entry, i): Symbol => {
      const { symbol, status } = entry;
      const out: Symbol = {
        id: `${path}#${ids[i] ?? symbol.qualifiedName}`,
        name: displayName(symbol),
        kind: symbol.kind,
        status,
        range: { ...symbol.range },
      };
      if (status === 'sig' && entry.before !== undefined) {
        out.signatureBefore = entry.before.signatureText;
        out.signatureAfter = symbol.signatureText;
      }
      return out;
    })
    .sort((a, b) => a.range.start - b.range.start || compare(a.id, b.id) || compare(a.kind, b.kind));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The name shown to the reviewer: the qualified name without duplicate
 * suffixes (`Class.method`, `Class.get x`, ADR-013). Suffixes live in the id only.
 */
function displayName(symbol: ParsedSymbol): string {
  const { name, qualifiedName } = symbol;
  if (qualifiedName === name) return name;
  const member = new RegExp(`^(.*)\\.${escapeRegExp(name)}(?:~\\d+)?$`).exec(qualifiedName);
  // Class names are identifiers, so a `~N` at the end of the owner is always a suffix.
  if (member?.[1] !== undefined) return `${member[1].replace(/~\d+$/, '')}.${name}`;
  return name;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
