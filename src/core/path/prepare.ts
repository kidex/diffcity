import type { SymbolRanges } from '../diff/status.js';
import { languageForPath, type TreeSitterLanguage } from '../parse/language.js';
import type { DiffLine, Status, Symbol } from '../report/types.js';
import { stepDiff, sliceLines } from './diff.js';
import { mayRegisterEntries, routeKey, scanEntryFacts, type EntryFacts } from './entries.js';

// What the execution path needs from one touched file, taken while both
// versions are in memory (the report reads them once): the diff of every
// changed symbol, the entry facts of the after version and the routes the
// before version declared. After this the before content can be dropped.

/** A touched code file, ready for buildExecutionPath. */
export interface PathFile {
  /** Repo-relative, forward slashes; the file id of the report. */
  path: string;
  status: Status;
  /** After content; `null` when the file has none or is untouched. The call graph reads it. */
  after: string | null;
  /** Every symbol of the file, as the report has it (`same` ones included). */
  symbols: readonly Symbol[];
  /** Step.diff of every symbol whose status is not `same`. */
  diffs: Readonly<Record<string, DiffLine[]>>;
  /** Entry facts of the after version; `null` without after content or for SQL. */
  facts: EntryFacts | null;
  /** `<METHOD> <path>` of the routes the before version declared. */
  beforeRoutes: readonly string[];
}

export interface PrepareFileInput {
  path: string;
  /** Path in the before version, for a rename. */
  oldPath?: string | undefined;
  status: Status;
  before: string | null;
  after: string | null;
  symbols: readonly Symbol[];
  /** Before and after range of each symbol (compareFileWithFingerprints). */
  ranges: Readonly<Record<string, SymbolRanges>>;
}

function treeSitter(path: string): TreeSitterLanguage | null {
  const language = languageForPath(path);
  return language === null || language === 'sql' ? null : language;
}

export async function preparePathFile(input: PrepareFileInput): Promise<PathFile> {
  const diffs: Record<string, DiffLine[]> = {};
  for (const symbol of input.symbols) {
    if (symbol.status === 'same') continue;
    const ranges = input.ranges[symbol.id] ?? {};
    diffs[symbol.id] = stepDiff(symbol.status, sliceLines(input.before, ranges.before), sliceLines(input.after, ranges.after));
  }
  const afterLanguage = treeSitter(input.path);
  const facts = input.after === null || afterLanguage === null ? null : await scanEntryFacts(input.after, afterLanguage, input.path);
  const oldPath = input.oldPath ?? input.path;
  const beforeLanguage = treeSitter(oldPath);
  // The before routes only matter when the after version declares some.
  const beforeRoutes =
    facts === null || facts.routes.length === 0 || input.before === null || beforeLanguage === null
      ? []
      : [...new Set((await scanEntryFacts(input.before, beforeLanguage, oldPath)).routes.map(routeKey))].sort();
  return { path: input.path, status: input.status, after: input.after, symbols: input.symbols, diffs, facts, beforeRoutes };
}

/**
 * An untouched file that registers routes, commander actions or scheduled
 * jobs (mayRegisterEntries): its registrations can make a touched handler an
 * entry point. It has no steps and stays out of the call graph.
 */
export async function prepareUntouchedFile(path: string, source: string, symbols: readonly Symbol[]): Promise<PathFile | null> {
  const language = treeSitter(path);
  if (language === null || !mayRegisterEntries(source)) return null;
  const facts = await scanEntryFacts(source, language, path);
  if (facts.routes.length === 0 && facts.actions.length === 0 && facts.jobs.length === 0) return null;
  const keys = [...new Set(facts.routes.map(routeKey))].sort();
  return { path, status: 'same', after: null, symbols, diffs: {}, facts, beforeRoutes: keys };
}
