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

function compareSymbols(path: string, before: ParsedSymbol[], after: ParsedSymbol[]): Symbol[] {
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
    .map(({ symbol, id, status, before: previous }): Symbol => {
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
      return out;
    })
    .sort((a, b) => a.range.start - b.range.start || compare(a.id, b.id) || compare(a.kind, b.kind));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
