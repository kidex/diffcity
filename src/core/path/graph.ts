import { posix } from 'node:path';
import type * as TsMorphModule from 'ts-morph';
import type { Node, Project, Symbol as MorphSymbol } from 'ts-morph';
import { languageForPath, type TreeSitterLanguage } from '../parse/language.js';
import type { Status, Symbol } from '../report/types.js';
import { extractJsCalls, matchNames, type JsFileCalls, type NameFile } from './js-calls.js';

// The call graph over touched symbols (ADR-034, SPEC.md 5.4): the edges the
// execution path walks and the call-site count of `sig` symbols. Pure over
// its input; nothing here reads the file system. TS and TSX are resolved by
// the type checker of an in-memory ts-morph project, JS by name matching.

/** A touched symbol, as the report has it. Only the after side is used. */
export type GraphSymbol = Pick<Symbol, 'id' | 'name' | 'kind' | 'status' | 'range'>;

export interface GraphFile {
  /** Repo-relative, forward slashes. */
  path: string;
  status: Status;
  /** After content; `null` when the file has none (deleted, binary, too large to parse). */
  after: string | null;
  symbols: readonly GraphSymbol[];
}

export interface CallGraphInput {
  /**
   * The files of the change. Files with status `same` or `del`, without after
   * content or in a language that is not code are ignored; every non-`del`
   * symbol of the others is a node of the graph (the caller filters `same`
   * symbols out beforehand when it does not want them as nodes).
   */
  files: readonly GraphFile[];
  /** Text of the root `tsconfig.json` as read through git, or `null`: only `paths` is used (ADR-031 rule). */
  tsconfig?: string | null | undefined;
  /** Receives the one-line notes the daemon writes to daemon.log. */
  log?: ((message: string) => void) | undefined;
}

export interface CallEdge {
  /** Symbol id of the callee. */
  to: string;
  /** Character offset of the (first) call in the caller's file; orders callees. */
  pos: number;
}

export interface CallGraph {
  /** Caller symbol id to its callees, ordered by call position, one edge per callee. */
  edges: Map<string, CallEdge[]>;
  /** `sig` symbol id to the number of call expressions in touched files that resolve to it (0 included). */
  callsites: Map<string, number>;
  /** `ts-morph` when the type checker resolved the TS files; `names` for name matching only. */
  mode: 'ts-morph' | 'names';
}

/** At most this many touched TS/TSX files go through ts-morph; above it the whole change uses names (ADR-034). */
export const MAX_TS_MORPH_FILES = 400;

/** Where the in-memory project keeps the repo; never a real path. */
const ROOT = '/repo';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A repo-relative path that stays inside the repo, normalized; `null` otherwise. */
function insideRepo(path: string): string | null {
  const normal = posix.normalize(path.replaceAll('\\', '/'));
  if (normal === '.' || normal === '..' || normal.startsWith('../') || posix.isAbsolute(normal)) return null;
  return normal;
}

type TsMorph = typeof TsMorphModule;
let tsMorph: Promise<TsMorph> | undefined;

/** ts-morph, loaded on first use: only the snapshot worker, only for a change with TS files. */
export function loadTsMorph(): Promise<TsMorph> {
  tsMorph ??= import('ts-morph').catch((error: unknown) => {
    tsMorph = undefined;
    throw error;
  });
  return tsMorph;
}

/**
 * `compilerOptions.paths` of a tsconfig as data: patterns with at most one
 * `*`, targets that stay inside the repo, `extends` ignored. The base is the
 * tsconfig's `baseUrl` when it is inside the repo, the repo root otherwise.
 */
export function readTsconfigPaths(
  text: string,
  ts: TsMorph['ts'],
): { base: string; paths: Record<string, string[]> } | null {
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', text);
  const config: unknown = parsed.config;
  if (typeof config !== 'object' || config === null) return null;
  const options: unknown = (config as { compilerOptions?: unknown }).compilerOptions;
  if (typeof options !== 'object' || options === null) return null;
  const { baseUrl, paths } = options as { baseUrl?: unknown; paths?: unknown };
  if (typeof paths !== 'object' || paths === null) return null;
  const stars = (value: string): number => value.split('*').length - 1;
  const base = typeof baseUrl === 'string' ? (insideRepo(baseUrl) ?? '') : '';
  const result: Record<string, string[]> = {};
  for (const [pattern, targets] of Object.entries(paths)) {
    if (stars(pattern) > 1 || !Array.isArray(targets)) continue;
    const kept: string[] = [];
    for (const target of targets as unknown[]) {
      if (typeof target !== 'string' || stars(target) > 1) continue;
      const inside = insideRepo(posix.join(base, target));
      if (inside !== null) kept.push(target);
    }
    if (kept.length > 0) result[pattern] = kept;
  }
  return Object.keys(result).length === 0 ? null : { base, paths: result };
}

/** Records edges and call-site counts while the engines report calls. */
class Collector {
  readonly edges = new Map<string, CallEdge[]>();
  readonly callsites = new Map<string, number>();
  private readonly byFile = new Map<string, GraphSymbol[]>();
  private readonly sig = new Set<string>();

  constructor(files: readonly GraphFile[]) {
    for (const file of files) {
      const symbols = file.symbols.filter((symbol) => symbol.status !== 'del');
      // Smallest range first: the innermost symbol wins when ranges nest (a method inside its class).
      symbols.sort((a, b) => a.range.end - a.range.start - (b.range.end - b.range.start) || compare(a.id, b.id));
      this.byFile.set(file.path, symbols);
      for (const symbol of symbols) {
        if (symbol.status === 'sig') {
          this.sig.add(symbol.id);
          this.callsites.set(symbol.id, 0);
        }
      }
    }
  }

  /** The symbol of `path` that contains the 1-based `line`, innermost first. */
  at(path: string, line: number): GraphSymbol | undefined {
    return this.byFile.get(path)?.find((symbol) => symbol.range.start <= line && line <= symbol.range.end);
  }

  call(fromPath: string, line: number, pos: number, targetId: string): void {
    if (this.sig.has(targetId)) this.callsites.set(targetId, (this.callsites.get(targetId) ?? 0) + 1);
    const caller = this.at(fromPath, line);
    if (caller === undefined || caller.id === targetId) return;
    const list = this.edges.get(caller.id);
    if (list === undefined) this.edges.set(caller.id, [{ to: targetId, pos }]);
    else {
      const seen = list.find((edge) => edge.to === targetId);
      if (seen === undefined) list.push({ to: targetId, pos });
      else if (pos < seen.pos) seen.pos = pos;
    }
  }

  finish(mode: CallGraph['mode']): CallGraph {
    const edges = new Map<string, CallEdge[]>();
    for (const id of [...this.edges.keys()].sort(compare)) {
      edges.set(id, (this.edges.get(id) ?? []).sort((a, b) => a.pos - b.pos || compare(a.to, b.to)));
    }
    const callsites = new Map([...this.callsites].sort(([a], [b]) => compare(a, b)));
    return { edges, callsites, mode };
  }
}

function treeSitterLanguage(path: string): TreeSitterLanguage | null {
  const language = languageForPath(path);
  return language === null || language === 'sql' ? null : language;
}

/** The nodes of a source file that call something, with the node that names the callee. */
function calleeNodes(morph: TsMorph, root: Node): { at: Node; callee: Node }[] {
  const { SyntaxKind } = morph;
  const found: { at: Node; callee: Node }[] = [];
  root.forEachDescendant((node) => {
    switch (node.getKind()) {
      case SyntaxKind.CallExpression:
        found.push({ at: node, callee: node.asKindOrThrow(SyntaxKind.CallExpression).getExpression() });
        break;
      case SyntaxKind.NewExpression:
        found.push({ at: node, callee: node.asKindOrThrow(SyntaxKind.NewExpression).getExpression() });
        break;
      case SyntaxKind.TaggedTemplateExpression:
        found.push({ at: node, callee: node.asKindOrThrow(SyntaxKind.TaggedTemplateExpression).getTag() });
        break;
      case SyntaxKind.JsxOpeningElement:
        found.push({ at: node, callee: node.asKindOrThrow(SyntaxKind.JsxOpeningElement).getTagNameNode() });
        break;
      case SyntaxKind.JsxSelfClosingElement:
        found.push({ at: node, callee: node.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getTagNameNode() });
        break;
      default:
    }
  });
  return found;
}

/** The symbol a callee expression names, aliases (imports, re-exports) followed. */
function resolveSymbol(morph: TsMorph, callee: Node): MorphSymbol | undefined {
  const { SyntaxKind } = morph;
  const named = callee.getKind() === SyntaxKind.PropertyAccessExpression
    ? callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getNameNode()
    : callee;
  let symbol = named.getSymbol();
  for (let hops = 0; symbol?.isAlias() === true && hops < 8; hops++) symbol = symbol.getAliasedSymbol();
  return symbol;
}

/** One call the type checker resolved, held back until the whole pass has run. */
interface ResolvedCall {
  path: string;
  line: number;
  pos: number;
  targetId: string;
}

/**
 * Resolves the calls of the TS files through the type checker. Only reads
 * from `collector`: the calls are returned, so a throw partway through
 * leaves nothing behind for the names fallback to count twice.
 */
async function tsMorphCalls(
  files: readonly (GraphFile & { after: string })[],
  tsconfig: string | null,
  collector: Collector,
): Promise<ResolvedCall[]> {
  const morph = await loadTsMorph();
  const { Project, ts } = morph;
  const paths = tsconfig === null ? null : readTsconfigPaths(tsconfig, ts);
  const project: Project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noLib: true,
      types: [],
      noEmit: true,
      ...(paths === null ? {} : { paths: paths.paths, pathsBasePath: posix.join(ROOT, paths.base) }),
    },
  });
  for (const file of files) project.createSourceFile(posix.join(ROOT, file.path), file.after, { overwrite: true });

  const calls: ResolvedCall[] = [];
  for (const file of files) {
    const source = project.getSourceFileOrThrow(posix.join(ROOT, file.path));
    for (const { at, callee } of calleeNodes(morph, source)) {
      const symbol = resolveSymbol(morph, callee);
      if (symbol === undefined) continue;
      const targets = new Set<string>();
      for (const declaration of symbol.getDeclarations()) {
        const path = declaration.getSourceFile().getFilePath();
        if (!path.startsWith(`${ROOT}/`)) continue;
        const target = collector.at(path.slice(ROOT.length + 1), declaration.getStartLineNumber());
        if (target !== undefined) targets.add(target.id);
      }
      for (const id of [...targets].sort(compare)) {
        calls.push({ path: file.path, line: at.getStartLineNumber(), pos: at.getStart(), targetId: id });
      }
    }
  }
  return calls;
}

/**
 * Builds the call graph of a change. TS and TSX files go through the type
 * checker unless more than MAX_TS_MORPH_FILES are touched, in which case
 * (or when ts-morph cannot run) name matching covers the whole change.
 */
export async function buildCallGraph(input: CallGraphInput): Promise<CallGraph> {
  const files = input.files
    .filter((file): file is GraphFile & { after: string } => {
      return file.status !== 'same' && file.status !== 'del' && file.after !== null && treeSitterLanguage(file.path) !== null;
    })
    .map((file) => ({ ...file, path: insideRepo(file.path) ?? '' }))
    .filter((file) => file.path !== '')
    .sort((a, b) => compare(a.path, b.path));
  const collector = new Collector(files);
  const isTs = (path: string): boolean => {
    const language = treeSitterLanguage(path);
    return language === 'typescript' || language === 'tsx';
  };
  const tsFiles = files.filter((file) => isTs(file.path));

  let mode: CallGraph['mode'] = 'names';
  let byNames = files;
  if (tsFiles.length > MAX_TS_MORPH_FILES) {
    input.log?.(
      `call graph: ${String(tsFiles.length)} touched TS files exceed the ts-morph limit of ${String(MAX_TS_MORPH_FILES)}; matching names for the whole change`,
    );
  } else if (tsFiles.length > 0) {
    try {
      const calls = await tsMorphCalls(tsFiles, input.tsconfig ?? null, collector);
      for (const call of calls) collector.call(call.path, call.line, call.pos, call.targetId);
      mode = 'ts-morph';
      byNames = files.filter((file) => !isTs(file.path));
    } catch (error) {
      input.log?.(`call graph: ts-morph failed (${error instanceof Error ? error.message : String(error)}); matching names for the whole change`);
    }
  }

  const named: NameFile[] = [];
  // TS files the type checker handled still provide symbols for JS callers to match, but make no calls here.
  const handled = new Set(byNames);
  for (const file of files.filter((file) => !handled.has(file))) {
    named.push({ path: file.path, calls: { imports: [], calls: [] }, symbols: file.symbols.filter((symbol) => symbol.status !== 'del') });
  }
  for (const file of byNames) {
    const language = treeSitterLanguage(file.path);
    if (language === null) continue;
    const calls: JsFileCalls = await extractJsCalls(file.after, language);
    named.push({ path: file.path, calls, symbols: file.symbols.filter((symbol) => symbol.status !== 'del') });
  }
  matchNames(named, (path, call, targetId) => {
    collector.call(path, call.line, call.pos, targetId);
  });
  return collector.finish(mode);
}
