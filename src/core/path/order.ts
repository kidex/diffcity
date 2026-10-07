import { posix } from 'node:path';
import type { Step, Symbol } from '../report/types.js';
import { isTestFile, routeKey, type HandlerRef, type RouteFact } from './entries.js';
import { buildCallGraph, type CallGraph } from './graph.js';
import { resolveRelativeImport } from './js-calls.js';
import type { PathFile } from './prepare.js';
import { whyFor, type WhyContext } from './why.js';

// The execution path of a change (SPEC.md 5.4, ADR-034): entry points in
// priority order, a BFS from each over the call graph restricted to touched
// symbols, the SQL statements at the end, then whatever no entry reached.
// Pure over its input apart from loading the grammars and ts-morph; every
// list is sorted before it is walked, so the same change gives the same steps.

export interface ExecutionPathInput {
  /**
   * The touched code files (status other than `same`), prepared by
   * preparePathFile, and the untouched files that register entry points
   * (prepareUntouchedFile, status `same`).
   */
  files: readonly PathFile[];
  /** Text of the root `tsconfig.json` read through git, or `null` (only `paths` is used). */
  tsconfig?: string | null | undefined;
  /** Text of the root `package.json` read through git, or `null` (only `bin` and `main` are used). */
  packageJson?: string | null | undefined;
  /** Receives the one-line notes the daemon writes to daemon.log. */
  log?: ((message: string) => void) | undefined;
}

export interface ExecutionPath {
  steps: Step[];
  /** `sig` symbol id to its call sites, for Symbol.callsites. */
  callsites: Map<string, number>;
  mode: CallGraph['mode'];
}

/** Entry classes in the priority order of 5.4. */
export const ENTRY_CLASSES = ['route', 'controller', 'main', 'job', 'test'] as const;
export type EntryClass = (typeof ENTRY_CLASSES)[number];

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Located {
  file: PathFile;
  symbol: Symbol;
}

/** File path, then range start, then id: the order of several entries of one class and of the tail sections. */
function byPosition(a: Located, b: Located): number {
  return compare(a.file.path, b.file.path) || a.symbol.range.start - b.symbol.range.start || compare(a.symbol.id, b.symbol.id);
}

/** A symbol that can start or join the path: touched, present in after. */
const changed = (symbol: Symbol): boolean => symbol.status === 'add' || symbol.status === 'mod' || symbol.status === 'sig';

const baseName = (name: string): string => name.slice(name.lastIndexOf('.') + 1);

/** Repo-relative paths named by the `bin` and `main` fields of a package.json text. */
export function packageEntryFiles(text: string | null | undefined): Set<string> {
  const files = new Set<string>();
  if (text === null || text === undefined) return files;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return files;
  }
  if (typeof parsed !== 'object' || parsed === null) return files;
  const { bin, main } = parsed as { bin?: unknown; main?: unknown };
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const normal = posix.normalize(value.replaceAll('\\', '/'));
    if (normal !== '..' && !normal.startsWith('../') && !posix.isAbsolute(normal)) files.add(normal);
  };
  add(main);
  if (typeof bin === 'string') add(bin);
  else if (typeof bin === 'object' && bin !== null) for (const value of Object.values(bin)) add(value);
  return files;
}

export class Changeset {
  readonly files: PathFile[];
  private readonly byId = new Map<string, Located>();
  private readonly known: Set<string>;
  /** Per file, the symbols present in after, innermost (smallest range) first. */
  private readonly nested = new Map<string, Symbol[]>();

  constructor(files: readonly PathFile[]) {
    this.files = [...files].sort((a, b) => compare(a.path, b.path));
    this.known = new Set(this.files.map((file) => file.path));
    for (const file of this.files) {
      for (const symbol of file.symbols) this.byId.set(symbol.id, { file, symbol });
      const present = file.symbols.filter((symbol) => symbol.status !== 'del');
      present.sort((a, b) => a.range.end - a.range.start - (b.range.end - b.range.start) || compare(a.id, b.id));
      this.nested.set(file.path, present);
    }
  }

  get(id: string): Located | undefined {
    return this.byId.get(id);
  }

  /** The innermost symbol of `file` (after version) that contains `line`. */
  at(file: PathFile, line: number): Symbol | undefined {
    return this.nested.get(file.path)?.find((symbol) => symbol.range.start <= line && line <= symbol.range.end);
  }

  /**
   * The symbol a handler passed by name refers to: the only symbol with that
   * base name in the file and the touched files it imports (relative
   * specifiers), the same rule as the call graph's name matching. Ambiguous or
   * unknown: none.
   */
  resolve(file: PathFile, ref: HandlerRef): Symbol | undefined {
    const visible = new Set([file.path]);
    for (const specifier of file.facts?.imports ?? []) {
      const resolved = resolveRelativeImport(file.path, specifier, this.known);
      if (resolved !== null) visible.add(resolved);
    }
    const found: Symbol[] = [];
    for (const path of visible) {
      for (const symbol of this.nested.get(path) ?? []) if (baseName(symbol.name) === ref.name) found.push(symbol);
    }
    return found.length === 1 ? found[0] : undefined;
  }
}

/** A classified entry point. */
export interface Entry extends Located {
  kind: EntryClass;
  /** The route a `route` entry stands for, and whether it is new. */
  route?: { method: string; path: string; isNew: boolean };
}

/**
 * Entry points in the priority order of 5.4; each symbol is classified once,
 * in the first class that claims it. Several entries of one class follow
 * file path then range start. `same`, `del` and SQL symbols are never entries.
 */
export function classifyEntries(set: Changeset, packageJson: string | null | undefined): Entry[] {
  const candidates: Record<EntryClass, Located[]> = { route: [], controller: [], main: [], job: [], test: [] };
  const routesOf = new Map<string, { route: RouteFact; isNew: boolean }[]>();
  const binFiles = packageEntryFiles(packageJson);
  const claim = (kind: EntryClass, file: PathFile, symbol: Symbol | undefined): void => {
    if (symbol !== undefined && changed(symbol) && symbol.kind !== 'sql') candidates[kind].push({ file, symbol });
  };
  const located = (symbol: Symbol): Located | undefined => set.get(symbol.id);

  for (const file of set.files) {
    const facts = file.facts;
    if (facts !== null) {
      const before = new Set(file.beforeRoutes);
      for (const route of facts.routes) {
        // The symbol that declares the route (the registration, the decorated method, the exported handler) and its named handlers.
        const declaring = set.at(file, route.line);
        const handlers = route.handlers.flatMap((ref) => set.resolve(file, ref) ?? []);
        const entry = declaring !== undefined && changed(declaring) ? declaring : handlers.find(changed);
        if (entry === undefined) continue;
        const home = located(entry);
        if (home === undefined) continue;
        claim('route', home.file, entry);
        const list = routesOf.get(entry.id) ?? [];
        // New or changed is a property of the route, not of its handler: the before file declared it or not.
        list.push({ route, isNew: !before.has(routeKey(route)) });
        routesOf.set(entry.id, list);
        for (const handler of handlers) {
          const at = located(handler);
          if (handler !== entry && at !== undefined) claim('controller', at.file, handler);
        }
      }
      for (const [kind, list] of [['main', facts.actions], ['job', facts.jobs]] as const) {
        for (const callback of list) {
          const named = callback.handlers.flatMap((ref) => set.resolve(file, ref) ?? []);
          if (named.length === 0) claim(kind, file, set.at(file, callback.line));
          for (const symbol of named) {
            const at = located(symbol);
            if (at !== undefined) claim(kind, at.file, symbol);
          }
        }
      }
    }
    for (const symbol of file.symbols) {
      const parts = symbol.name.split('.');
      const owner = parts.at(-2);
      if (symbol.kind === 'method' && owner?.endsWith('Controller') === true && parts.at(-1) !== 'constructor') {
        claim('controller', file, symbol);
      }
      if ((symbol.kind === 'function' && symbol.name === 'main') || binFiles.has(file.path)) claim('main', file, symbol);
      if (symbol.status === 'add' && isTest(file, symbol)) claim('test', file, symbol);
    }
  }

  const classified = new Set<string>();
  const entries: Entry[] = [];
  for (const kind of ENTRY_CLASSES) {
    for (const candidate of candidates[kind].sort(byPosition)) {
      if (classified.has(candidate.symbol.id)) continue;
      classified.add(candidate.symbol.id);
      const entry: Entry = { ...candidate, kind };
      const routes = routesOf.get(candidate.symbol.id);
      if (kind === 'route' && routes !== undefined) {
        // A symbol that declares several routes is one step: the first new route names it, else the first route.
        const chosen = [...routes].sort((a, b) => a.route.line - b.route.line).find((r) => r.isNew) ?? routes[0];
        if (chosen !== undefined) entry.route = { method: chosen.route.method, path: chosen.route.path, isNew: chosen.isNew };
      }
      entries.push(entry);
    }
  }
  return entries;
}

/** A test: a symbol of a test file, or a top-level `describe` / `it` / `test` block anywhere. */
function isTest(file: PathFile, symbol: Symbol): boolean {
  return isTestFile(file.path) || (file.facts?.testBlocks.includes(symbol.range.start) ?? false);
}

/** Builds the execution path of a change: the call graph, the entries, the order, the `why` of each step. */
export async function buildExecutionPath(input: ExecutionPathInput): Promise<ExecutionPath> {
  const set = new Changeset(input.files);
  const graph = await buildCallGraph({
    files: set.files
      .filter((file) => file.status !== 'same')
      .map((file) => ({ path: file.path, status: file.status, after: file.after, symbols: file.symbols })),
    tsconfig: input.tsconfig,
    log: input.log,
  });
  const entries = classifyEntries(set, input.packageJson);

  const visited = new Set<string>();
  const placed: { at: Located; section: NonNullable<Step['section']>; root?: string }[] = [];
  for (const entry of entries) {
    if (visited.has(entry.symbol.id)) continue;
    visited.add(entry.symbol.id);
    const queue: Located[] = [entry];
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head];
      if (at === undefined) break;
      placed.push({ at, section: 'path', root: entry.symbol.id });
      // `same` and `del` symbols are never on the path; a `same` caller is never expanded (it is never visited).
      for (const edge of graph.edges.get(at.symbol.id) ?? []) {
        const callee = set.get(edge.to);
        if (callee === undefined || visited.has(edge.to) || !changed(callee.symbol) || callee.symbol.kind === 'sql') continue;
        visited.add(edge.to);
        queue.push(callee);
      }
    }
  }

  const rest: Located[] = [];
  for (const file of set.files) {
    for (const symbol of file.symbols) if (symbol.status !== 'same' && !visited.has(symbol.id)) rest.push({ file, symbol });
  }
  rest.sort(byPosition);
  for (const at of rest) if (at.symbol.kind === 'sql') placed.push({ at, section: 'migration' });
  for (const at of rest) if (at.symbol.kind !== 'sql') placed.push({ at, section: 'unconnected' });

  const entryOf = new Map(entries.map((entry) => [entry.symbol.id, entry]));
  const steps = placed.map(({ at, section, root }, index): Step => {
    const context: WhyContext = {
      symbol: at.symbol,
      route: entryOf.get(at.symbol.id)?.route,
      callsites: graph.callsites.get(at.symbol.id),
      test: isTest(at.file, at.symbol),
    };
    const step: Step = {
      order: index + 1,
      symbolId: at.symbol.id,
      fileId: at.file.path,
      why: whyFor(context),
      diff: at.file.diffs[at.symbol.id] ?? [],
      section,
    };
    if (root !== undefined) step.entry = root;
    return step;
  });
  return { steps, callsites: graph.callsites, mode: graph.mode };
}

