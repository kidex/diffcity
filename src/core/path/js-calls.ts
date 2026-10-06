import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';
import { parserFor } from '../parse/grammars.js';
import type { TreeSitterLanguage } from '../parse/language.js';

// Call extraction and name matching for the call graph (ADR-034): the JS
// side, and the fallback for TS above the ts-morph file limit. Pure over
// the sources it is given; the only I/O is loading the tree-sitter grammar.

/** One call-like expression of a file. */
export interface JsCall {
  /** The callee identifier, or the property name of a member callee. */
  name: string;
  /** Character offset of the call in the file (orders callees). */
  pos: number;
  /** 1-based line the call starts on. */
  line: number;
}

export interface JsFileCalls {
  /** Relative module specifiers (`./x`, `../y`) the file imports, requires or re-exports. */
  imports: string[];
  calls: JsCall[];
}

/** A touched symbol as the matcher sees it. */
export interface NameSymbol {
  id: string;
  /** Qualified base name as reported (`Cart.total`); only the last segment is matched. */
  name: string;
  range: { start: number; end: number };
}

/** A touched file with the calls found in its after content. */
export interface NameFile {
  path: string;
  calls: JsFileCalls;
  symbols: readonly NameSymbol[];
}

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

/** `./x.js` is written for the `x.ts` that tsc emits it from: try the TS twin of a JS extension. */
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

function stringValue(text: string): string | null {
  const quote = text[0];
  if ((quote !== '"' && quote !== "'" && quote !== '`') || text.length < 2 || text[text.length - 1] !== quote) return null;
  const value = text.slice(1, -1);
  return quote === '`' && value.includes('${') ? null : value;
}

const isRelative = (specifier: string): boolean => specifier.startsWith('./') || specifier.startsWith('../');

/**
 * The calls and relative imports of one source. A callee is an identifier
 * (`save()`, `new Repo()`, `<Card />`) or the property of a member callee
 * (`repo.save()`); anything else (computed access, calls of calls) has no name.
 */
export async function extractJsCalls(source: string, language: TreeSitterLanguage): Promise<JsFileCalls> {
  const parser = await parserFor(language);
  const tree = parser.parse(source);
  if (tree === null) return { imports: [], calls: [] };
  try {
    const imports = new Set<string>();
    const calls: JsCall[] = [];
    const nameOf = (callee: Node | null): string | null => {
      if (callee === null) return null;
      if (callee.type === 'identifier') return callee.text;
      if (callee.type === 'member_expression') return callee.childForFieldName('property')?.text ?? null;
      return null;
    };
    const addImport = (specifier: string | null): void => {
      if (specifier !== null && isRelative(specifier)) imports.add(specifier);
    };
    const nodes = tree.rootNode.descendantsOfType([
      'import_statement',
      'export_statement',
      'call_expression',
      'new_expression',
      'jsx_opening_element',
      'jsx_self_closing_element',
    ]);
    for (const node of nodes) {
      switch (node.type) {
        case 'import_statement':
        case 'export_statement': {
          const text = node.childForFieldName('source')?.text;
          if (text !== undefined) addImport(stringValue(text));
          break;
        }
        case 'call_expression': {
          const callee = node.childForFieldName('function');
          const argument = node.childForFieldName('arguments')?.namedChildren[0];
          const text = argument?.type === 'string' ? stringValue(argument.text) : null;
          if (callee?.type === 'import' || (callee?.type === 'identifier' && callee.text === 'require')) {
            addImport(text);
            break;
          }
          const name = nameOf(callee);
          if (name !== null) calls.push({ name, pos: node.startIndex, line: node.startPosition.row + 1 });
          break;
        }
        case 'new_expression': {
          const name = nameOf(node.childForFieldName('constructor'));
          if (name !== null) calls.push({ name, pos: node.startIndex, line: node.startPosition.row + 1 });
          break;
        }
        default: {
          // Components start with a capital (or are members, `<Ui.Card />`); `<div />` is not a call.
          const tag = node.childForFieldName('name');
          const name = nameOf(tag);
          if (name !== null && tag !== null && (tag.type === 'member_expression' || /^[A-Z]/.test(name))) {
            calls.push({ name, pos: node.startIndex, line: node.startPosition.row + 1 });
          }
        }
      }
    }
    calls.sort((a, b) => a.pos - b.pos);
    return { imports: [...imports].sort(), calls };
  } finally {
    tree.delete();
  }
}

/**
 * The touched file a relative specifier of `from` points at, or `null`.
 * Only `known` paths are candidates, and a specifier that leaves the repo
 * resolves to nothing.
 */
export function resolveRelativeImport(from: string, specifier: string, known: ReadonlySet<string>): string | null {
  if (!isRelative(specifier)) return null;
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (target === '..' || target.startsWith('../') || posix.isAbsolute(target)) return null;
  const extension = posix.extname(target);
  const stem = target.slice(0, target.length - extension.length);
  const candidates = [
    target,
    ...CODE_EXTENSIONS.map((ext) => target + ext),
    ...(JS_TO_TS[extension] ?? []).map((ext) => stem + ext),
    ...CODE_EXTENSIONS.map((ext) => `${target}/index${ext}`),
  ];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

function baseName(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

/**
 * Name matching: a call resolves to a touched symbol when its callee name
 * equals the base name of exactly one touched symbol among the files the
 * caller imports and the caller's own file. An ambiguous name, or one that
 * matches nothing, creates no edge. Calls are visited in file then position
 * order. `onCall` receives the calling file, the call and the symbol id.
 */
export function matchNames(
  files: readonly NameFile[],
  onCall: (path: string, call: JsCall, targetId: string) => void,
): void {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const known = new Set(sorted.map((file) => file.path));
  const byPath = new Map(sorted.map((file) => [file.path, file]));
  for (const file of sorted) {
    const visible = new Set<string>([file.path]);
    for (const specifier of file.calls.imports) {
      const resolved = resolveRelativeImport(file.path, specifier, known);
      if (resolved !== null) visible.add(resolved);
    }
    const byName = new Map<string, Set<string>>();
    for (const path of [...visible].sort()) {
      for (const symbol of byPath.get(path)?.symbols ?? []) {
        const base = baseName(symbol.name);
        const ids = byName.get(base);
        if (ids === undefined) byName.set(base, new Set([symbol.id]));
        else ids.add(symbol.id);
      }
    }
    for (const call of file.calls.calls) {
      const ids = byName.get(call.name);
      if (ids?.size !== 1) continue;
      const [only] = ids;
      if (only !== undefined) onCall(file.path, call, only);
    }
  }
}
