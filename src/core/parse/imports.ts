import { Query, type Language, type Node } from 'web-tree-sitter';
import type { TreeSitterLanguage } from './language.js';

// Import extraction for the layers rule (ADR-031): tree-sitter queries over
// the tree parseSource already builds for a file's symbols, so a file is
// never parsed twice. Statements: `import … from 's'`, `import 's'`,
// `export … from 's'`, `import x = require('s')`, and `require('s')` and
// `import('s')` calls anywhere in the file.

/** One import of a file version. */
export interface ImportRef {
  /** The module specifier; null when it is not a plain string literal (a template, a variable): it cannot be resolved. */
  specifier: string | null;
  /** 1-based line the statement (or the call) starts on. */
  line: number;
  /** `import type`, `export type … from`, or named imports or re-exports that are all `type`: no runtime dependency. */
  typeOnly: boolean;
}

/** Patterns shared by the three grammars. Capture names: `stmt` + `source` for statements, `call` + `arg` for calls. */
const COMMON_PATTERNS = `
(import_statement source: (string) @source) @stmt
(export_statement source: (string) @source) @stmt
(call_expression function: (import) arguments: (arguments . (_) @arg)) @call
(call_expression function: (identifier) @fn arguments: (arguments . (_) @arg) (#eq? @fn "require")) @call
`;

/** `import x = require('s')` exists only in the TypeScript grammars. */
const TS_PATTERNS = `
(import_statement (import_require_clause source: (string) @source)) @stmt
`;

const queries = new Map<TreeSitterLanguage, Query>();

function queryFor(language: TreeSitterLanguage, grammar: Language): Query {
  let query = queries.get(language);
  if (query === undefined) {
    query = new Query(grammar, language === 'javascript' ? COMMON_PATTERNS : COMMON_PATTERNS + TS_PATTERNS);
    queries.set(language, query);
  }
  return query;
}

/** The value of a plain string literal node; null for anything else (a template string included). */
function literalValue(node: Node): string | null {
  if (node.type !== 'string') return null;
  const text = node.text;
  return text.length >= 2 ? text.slice(1, -1) : null;
}

function hasTypeKeyword(node: Node): boolean {
  return node.children.some((child) => child.type === 'type');
}

/**
 * `import type …`, `export type … from`, `import type x = require()`, or
 * `import { type A, type B }` / `export { type A, type B } from` with nothing
 * but types in the braces.
 */
function isTypeOnly(statement: Node): boolean {
  if (hasTypeKeyword(statement)) return true;
  if (statement.type === 'export_statement') {
    const clause = statement.namedChildren.find((child) => child.type === 'export_clause');
    const specifiers = clause?.namedChildren.filter((child) => child.type === 'export_specifier') ?? [];
    return specifiers.length > 0 && specifiers.every(hasTypeKeyword);
  }
  if (statement.type !== 'import_statement') return false;
  const clause = statement.namedChildren.find((child) => child.type === 'import_clause');
  if (clause === undefined) return false;
  const parts = clause.namedChildren;
  const named = parts[0];
  if (parts.length !== 1 || named?.type !== 'named_imports') return false;
  const specifiers = named.namedChildren.filter((child) => child.type === 'import_specifier');
  return specifiers.length > 0 && specifiers.every(hasTypeKeyword);
}

/**
 * The imports of a parsed file, in source order. A computed or template
 * specifier is kept with `specifier: null` so the rule can count it as
 * unresolved.
 */
export function extractImports(root: Node, language: TreeSitterLanguage, grammar: Language): ImportRef[] {
  const found: (ImportRef & { at: number })[] = [];
  for (const match of queryFor(language, grammar).matches(root)) {
    const capture = (name: string): Node | undefined => match.captures.find((entry) => entry.name === name)?.node;
    const statement = capture('stmt');
    if (statement !== undefined) {
      const source = capture('source');
      found.push({ specifier: source === undefined ? null : literalValue(source), line: statement.startPosition.row + 1, typeOnly: isTypeOnly(statement), at: statement.startIndex });
      continue;
    }
    const call = capture('call');
    const argument = capture('arg');
    if (call === undefined || argument === undefined) continue;
    found.push({ specifier: literalValue(argument), line: call.startPosition.row + 1, typeOnly: false, at: call.startIndex });
  }
  found.sort((a, b) => a.at - b.at);
  return found.map(({ specifier, line, typeOnly }) => ({ specifier, line, typeOnly }));
}
