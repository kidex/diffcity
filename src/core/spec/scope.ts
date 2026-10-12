// Spec scope (SPEC.md 5.5, ADR-035): which touched files the spec covers.
//
// Roots are the touched symbols and files the spec names: a backticked
// identifier equal to a touched symbol's base or qualified name (`cancelOrder`,
// also written `cancelOrder()` or `cancelOrder(id)`), the repo-relative path of
// a touched file or its basename when that has a dot (`index.ts`, not `run`),
// a Markdown link whose target resolves, from the spec file's directory, to a
// touched file, or an HTTP route string (`POST /orders/:id/cancel`) equal to a
// route entry point's registration (the touched symbol that declares the
// route and its touched handlers passed by name; routeRegistrations in
// src/core/path). Matching is exact and case-sensitive on those tokens only;
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
  /**
   * Where Markdown link targets resolve: the spec file's directory and the
   * repo root, both absolute and `/`-separated. Null: links name nothing.
   * Default: the directory of `specPath` inside the repo, else null.
   */
  linkBase?: LinkBase | null | undefined;
  /** Every file of the Report; untouched ones (`same`) stay null. */
  files: readonly ScopeFile[];
  /** The ADR-034 call graph: caller symbol id to its callees. */
  edges: ReadonlyMap<string, readonly { to: string }[]>;
  /** Touched symbol id to the HTTP routes it registers or handles (routeRegistrations, ADR-034 facts). */
  routes: ReadonlyMap<string, readonly { method: string; path: string }[]>;
}

/** The spec file's directory and the repo root, absolute, `/`-separated (or any common virtual root). */
export interface LinkBase {
  root: string;
  dir: string;
}

/** The virtual root a repo-relative spec path is placed under to resolve its links. */
const VIRTUAL_ROOT = '/repo';

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
// Trimmed by hand, not with a `[...]+$` regex: that one rescans from every
// position of a long word and is quadratic on a 256 KiB run of dots.
const LEADING = new Set('([{<"\'*_~');
const TRAILING = new Set(')]}>"\'*_~.,;:!?');

/** `<METHOD> <path>`: an upper-case method word, blanks, then a path starting with `/`. */
const ROUTE = /(?<![A-Za-z0-9_])([A-Z]+)[ \t]+(\/[^\s`'"<>]*)/g;

/** Punctuation that can end a sentence after a route path. */
const ROUTE_TRAILING = new Set(')]}>.,;:!?');

/**
 * An inline Markdown link or image: `[text](target)` or `[text](target "title")`,
 * the target without blanks. The text holds no `[`, so a line of `[` is linear
 * (a nested `[![img](a)](b)` keeps only the inner link).
 */
const LINK = /!?\[([^[\]\n]*)\]\(<?([^\s()<>]+)>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)/g;

/** A backticked call: an identifier or a dotted chain, then parentheses holding anything. */
const CALL = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(.*\)$/;

/** A URL scheme (`https:`, `mailto:`): such a link names no repo file. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The tokens of a spec, by kind: identifiers come from backticks only. */
export interface SpecTokens {
  /** Contents of inline code spans, trimmed; a call `name(...)` also gives `name`. */
  code: Set<string>;
  /** Words of the text outside link targets (code spans included), as written and with wrapping punctuation stripped. */
  words: Set<string>;
  /** Repo-relative paths the Markdown link targets resolve to from the spec's directory; targets that leave the repo are dropped. */
  links: Set<string>;
  /** `<METHOD> <path>` strings as written. */
  routes: Set<string>;
}

/** `text` without the characters of `set` at its start (`from: 'start'`) or its end. */
function trim(text: string, set: ReadonlySet<string>, from: 'start' | 'end'): string {
  if (from === 'start') {
    let start = 0;
    while (start < text.length && set.has(text.charAt(start))) start++;
    return text.slice(start);
  }
  let end = text.length;
  while (end > 0 && set.has(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

/** A route key with the path's trailing punctuation removed: written and registered forms meet on it. */
function routeKey(method: string, path: string): string {
  const stripped = trim(path, ROUTE_TRAILING, 'end');
  return `${method} ${stripped === '' ? '/' : stripped}`;
}

/**
 * Whether the spec names the route `<method> <path>`: a written route equal to
 * it, or equal to it followed by sentence punctuation only (`GET /orders/[id].`).
 * `/files/:name?` and `/orders/[id]` end in what is also punctuation, so they
 * are matched as written, never only stripped.
 */
function namesRoute(byKey: ReadonlyMap<string, readonly string[]>, method: string, path: string): boolean {
  const written = `${method} ${path}`;
  for (const candidate of byKey.get(routeKey(method, path)) ?? []) {
    if (candidate === written) return true;
    if (candidate.startsWith(written) && trim(candidate.slice(written.length), ROUTE_TRAILING, 'end') === '') return true;
  }
  return false;
}

/**
 * A link target as a repo-relative path: `#fragment` and `?query` dropped,
 * resolved from the spec's directory and normalized; null for a URL, an
 * absolute path or a target outside the repo.
 */
function linkTarget(target: string, base: LinkBase): string | null {
  const bare = target.replace(/[#?].*$/s, '');
  if (bare === '' || SCHEME.test(bare) || bare.startsWith('/')) return null;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // Not percent-encoded as a URL would be: taken as written.
  }
  const resolved = posix.relative(base.root, posix.resolve(base.dir, decoded));
  if (resolved === '' || resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) return null;
  return resolved;
}

export function specTokens(text: string, linkBase: LinkBase | null = null): SpecTokens {
  const code = new Set<string>();
  for (const match of text.matchAll(CODE_SPAN)) {
    const content = (match[1] ?? '').trim();
    if (content === '') continue;
    code.add(content);
    const call = CALL.exec(content);
    if (call?.[1] !== undefined) code.add(call[1]);
  }
  const links = new Set<string>();
  // A link counts by its resolved target; its text stays prose, its target is no word.
  const prose = text.replace(LINK, (_whole, label: string, target: string) => {
    const resolved = linkBase === null ? null : linkTarget(target, linkBase);
    if (resolved !== null) links.add(resolved);
    return ` ${label} `;
  });
  const words = new Set<string>();
  // Backticks end a word: `src/a.ts`.
  for (const raw of prose.split(/[\s`]+/)) {
    if (raw === '') continue;
    words.add(raw);
    const stripped = trim(trim(raw, LEADING, 'start'), TRAILING, 'end');
    if (stripped !== '') words.add(stripped);
  }
  const routes = new Set<string>();
  for (const match of prose.matchAll(ROUTE)) {
    routes.add(`${match[1] ?? ''} ${match[2] ?? ''}`);
  }
  return { code, words, links, routes };
}

/**
 * The spec scope of a change: `inSpec` per touched file, or null with
 * NO_ROOT_NOTICE when the spec names nothing touched.
 */
export function specScope(input: SpecScopeInput): SpecScope {
  const linkBase =
    input.linkBase !== undefined
      ? input.linkBase
      : input.specPath === null
        ? null
        : { root: VIRTUAL_ROOT, dir: posix.join(VIRTUAL_ROOT, posix.dirname(input.specPath)) };
  const tokens = specTokens(input.text, linkBase);
  // Written routes by their stripped key, so a registration is checked against a few candidates only.
  const routesByKey = new Map<string, string[]>();
  for (const written of tokens.routes) {
    const space = written.indexOf(' ');
    const key = routeKey(written.slice(0, space), written.slice(space + 1));
    const list = routesByKey.get(key);
    if (list === undefined) routesByKey.set(key, [written]);
    else list.push(written);
  }
  const touchedFiles = input.files.filter((file) => touched(file.status));

  const roots = new Set<string>();
  const rootFiles = new Set<string>();
  const touchedSymbols = new Map<string, string>();
  for (const file of touchedFiles) {
    const symbols = file.symbols.filter((symbol) => touched(symbol.status));
    for (const symbol of symbols) touchedSymbols.set(symbol.id, file.path);
    // The spec file itself is in the spec, but naming itself is no root.
    if (file.path === input.specPath) continue;
    // A file named by its path, its basename (with a dot) or a link roots its touched symbols, and is in the spec even without any.
    const base = posix.basename(file.path);
    if (tokens.words.has(file.path) || tokens.links.has(file.path) || (base.includes('.') && tokens.words.has(base))) {
      rootFiles.add(file.path);
      for (const symbol of symbols) roots.add(symbol.id);
    }
    for (const symbol of symbols) {
      if (tokens.code.has(symbol.name) || tokens.code.has(baseName(symbol.name))) roots.add(symbol.id);
      for (const route of input.routes.get(symbol.id) ?? []) {
        if (namesRoute(routesByKey, route.method, route.path)) roots.add(symbol.id);
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
