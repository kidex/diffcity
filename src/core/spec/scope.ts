// Spec scope (SPEC.md 5.5, ADR-035): which touched files the spec covers.
//
// Roots are the touched symbols and files the spec names: a backticked
// identifier equal to a touched symbol's base or qualified name, the
// repo-relative path or the basename of a touched file, or an HTTP route
// string (`POST /orders/:id/cancel`) equal to a route entry point's
// registration. Matching is exact and case-sensitive on those tokens only;
// prose words never match a symbol. A touched file is in the spec when one
// of its touched symbols is a root or is connected to one through call edges
// (callers and callees) among touched symbols, the ADR-034 call graph. A
// spec that names nothing touched claims nothing: every `inSpec` stays null.
//
// Pure: the spec text is data. Nothing in it is executed, and nothing it
// names is read; it is only compared with the change's own paths and names.

import { posix } from 'node:path';
import type { Status, Symbol } from '../report/types.js';

/** `.diffcity/spec.md`, read from the after state of the change. */
export const SPEC_PATH = '.diffcity/spec.md';

/** A spec above this many bytes counts as absent, with a notice (ADR-035). */
export const MAX_SPEC_BYTES = 256 * 1024;

/** The Outside the spec tab's text when the spec names no touched symbol or file (ADR-035). */
export const NO_ROOT_NOTICE = 'The spec names no touched symbol or file';

/** The notice of a spec above MAX_SPEC_BYTES, which counts as absent. */
export const TOO_LARGE_NOTICE = 'The spec is larger than 256 KiB and was ignored';

/** A file of the change as spec scope needs it. */
export interface ScopeFile {
  path: string;
  status: Status;
  symbols: readonly Pick<Symbol, 'id' | 'name' | 'status'>[];
}

export interface SpecScopeInput {
  /** The spec's text. */
  text: string;
  /** Repo-relative path of the spec file when it is inside the repo (it is in the spec when touched), else null. */
  specPath: string | null;
  /** Every file of the Report; untouched ones (`same`) stay null. */
  files: readonly ScopeFile[];
  /** The ADR-034 call graph: caller symbol id to its callees. */
  edges: ReadonlyMap<string, readonly { to: string }[]>;
  /** Touched symbol id to the HTTP routes it registers or handles (routeRegistrations, ADR-034 facts). */
  routes: ReadonlyMap<string, readonly { method: string; path: string }[]>;
}

export interface SpecScope {
  /** `inSpec` of every touched file; null when no root matched (nothing is claimed). */
  inSpec: Map<string, boolean> | null;
  /** NO_ROOT_NOTICE when no root matched, else null. */
  notice: string | null;
}

const touched = (status: Status): boolean => status !== 'same';

const baseName = (name: string): string => name.slice(name.lastIndexOf('.') + 1);

/** Inline code spans: one backtick on each side, on one line, not part of a longer backtick run. */
const CODE_SPAN = /(?<!`)`([^`\n]+)`(?!`)/g;

/** Punctuation that wraps a path in prose or Markdown, stripped from either end of a word. */
const LEADING = /^[([{<"'*_~]+/;
const TRAILING = /[)\]}>"'*_~.,;:!?]+$/;

/** `<METHOD> <path>`: an upper-case method word, blanks, then a path starting with `/`. */
const ROUTE = /(?<![A-Za-z0-9_])([A-Z]+)[ \t]+(\/[^\s`'"<>]*)/g;

/** The tokens of a spec, by kind: identifiers come from backticks only. */
export interface SpecTokens {
  /** Contents of inline code spans, trimmed. */
  code: Set<string>;
  /** Words of the whole text (code spans included), as written and with wrapping punctuation stripped. */
  words: Set<string>;
  /** `<METHOD> <path>` strings, with trailing punctuation stripped from the path. */
  routes: Set<string>;
}

export function specTokens(text: string): SpecTokens {
  const code = new Set<string>();
  for (const match of text.matchAll(CODE_SPAN)) {
    const content = (match[1] ?? '').trim();
    if (content !== '') code.add(content);
  }
  const words = new Set<string>();
  // Backticks and Markdown link brackets end a word: `src/a.ts`, [a](src/a.ts).
  for (const raw of text.split(/[\s`]+|\]\(/)) {
    if (raw === '') continue;
    words.add(raw);
    const stripped = raw.replace(LEADING, '').replace(TRAILING, '');
    if (stripped !== '') words.add(stripped);
  }
  const routes = new Set<string>();
  for (const match of text.matchAll(ROUTE)) {
    const path = (match[2] ?? '').replace(/[)\]}>.,;:!?]+$/, '');
    routes.add(`${match[1] ?? ''} ${path === '' ? '/' : path}`);
  }
  return { code, words, routes };
}

/**
 * The spec scope of a change: `inSpec` per touched file, or null with
 * NO_ROOT_NOTICE when the spec names nothing touched.
 */
export function specScope(input: SpecScopeInput): SpecScope {
  const tokens = specTokens(input.text);
  const touchedFiles = input.files.filter((file) => touched(file.status));

  const roots = new Set<string>();
  const rootFiles = new Set<string>();
  const touchedSymbols = new Map<string, string>();
  for (const file of touchedFiles) {
    const symbols = file.symbols.filter((symbol) => touched(symbol.status));
    for (const symbol of symbols) touchedSymbols.set(symbol.id, file.path);
    // The spec file itself is in the spec, but naming itself is no root.
    if (file.path === input.specPath) continue;
    // A file named by its path or basename roots its touched symbols, and is in the spec even without any.
    if (tokens.words.has(file.path) || tokens.words.has(posix.basename(file.path))) {
      rootFiles.add(file.path);
      for (const symbol of symbols) roots.add(symbol.id);
    }
    for (const symbol of symbols) {
      if (tokens.code.has(symbol.name) || tokens.code.has(baseName(symbol.name))) roots.add(symbol.id);
      for (const route of input.routes.get(symbol.id) ?? []) {
        if (tokens.routes.has(`${route.method} ${route.path}`)) roots.add(symbol.id);
      }
    }
  }
  if (roots.size === 0 && rootFiles.size === 0) return { inSpec: null, notice: NO_ROOT_NOTICE };

  // Undirected neighbours over the call edges whose two ends are touched symbols.
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = neighbours.get(a);
    if (list === undefined) neighbours.set(a, [b]);
    else list.push(b);
  };
  for (const [from, callees] of input.edges) {
    if (!touchedSymbols.has(from)) continue;
    for (const { to } of callees) {
      if (!touchedSymbols.has(to) || to === from) continue;
      link(from, to);
      link(to, from);
    }
  }
  const reached = new Set(roots);
  const queue = [...roots];
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighbours.get(queue[head] ?? '') ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }

  const covered = new Set(rootFiles);
  for (const id of reached) {
    const path = touchedSymbols.get(id);
    if (path !== undefined) covered.add(path);
  }
  const inSpec = new Map<string, boolean>();
  for (const file of touchedFiles) inSpec.set(file.path, file.path === input.specPath || covered.has(file.path));
  return { inSpec, notice: null };
}
