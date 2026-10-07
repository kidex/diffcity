import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { FindingCategory } from './types.js';

/** The `source` prefix of findings computed by rules (ADR-030); never accepted from an import. */
export const RULE_SOURCE_PREFIX = 'rule:';

export function isRuleSource(source: string): boolean {
  return source.startsWith(RULE_SOURCE_PREFIX);
}

/** The warning for an imported entry (own format) or run (SARIF) that claims a rule source. */
export function ruleSourceWarning(source: string): string {
  return `skipped: source "${source}" is reserved for rule findings`;
}

/** Lower case, collapsed whitespace, trailing punctuation removed (SPEC.md 5.6). */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,;:!?…]+$/u, '');
}

/**
 * `f:` + the first 16 hex of sha256(source, file, category, normalized title,
 * line), NUL separated (ADR-036). Category is part of the dedup identity, so
 * it is part of the key: two findings that stay separate never share a key.
 */
export function findingKey(source: string, file: string, category: FindingCategory, title: string, line: number): string {
  const digest = createHash('sha256')
    .update(`${source}\0${file}\0${category}\0${normalizeTitle(title)}\0${String(line)}`)
    .digest('hex');
  return `f:${digest.slice(0, 16)}`;
}

export type PathResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The working tree root, or every spelling of it an absolute path may use
 * (git's physical path and the logical one reached through a symbolic link,
 * see rootSpellings in src/core/git/change.ts).
 */
export type RepoRoot = string | readonly string[];

function decodeUri(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

/**
 * A SARIF `artifactLocation.uri` as a path (docs/findings.md): a `file://` URI
 * or a relative reference, percent-decoded either way. Invalid percent-encoding
 * is kept as written. The own format's `file` is a path and is not decoded.
 */
export function normalizeSarifUri(uri: string, repoRoot: RepoRoot): PathResult {
  const trimmed = uri.trim();
  return normalizePath(trimmed.startsWith('file://') ? trimmed : decodeUri(trimmed), repoRoot);
}

/**
 * A path as the Report writes it: repo-relative, `/` separators, no `..`.
 * Absolute paths (and `file://` URIs) are made relative to `repoRoot` (the
 * first spelling they start with), or refused.
 */
export function normalizePath(raw: string, repoRoot?: RepoRoot): PathResult {
  let path = raw.trim();
  if (path.startsWith('file://')) path = decodeUri(path.slice('file://'.length).replace(/^\/(?=[A-Za-z]:)/, ''));
  path = path.replace(/\\/g, '/');
  if (path === '') return { ok: false, reason: 'empty path' };
  const absolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path);
  if (absolute) {
    const roots = repoRoot === undefined ? [] : typeof repoRoot === 'string' ? [repoRoot] : repoRoot;
    if (roots.length === 0) return { ok: false, reason: `absolute path "${path}" and no repository root` };
    const inside = roots
      .map((given) => given.replace(/\\/g, '/').replace(/\/+$/, ''))
      .find((root) => path === root || path.startsWith(`${root}/`));
    if (inside === undefined) return { ok: false, reason: `absolute path "${path}" is outside the repository` };
    path = path.slice(inside.length + 1);
  }
  if (path.split('/').includes('..')) return { ok: false, reason: `path "${path}" contains ".."` };
  const clean = posix.normalize(path).replace(/^(\.\/)+/, '');
  if (clean === '' || clean === '.' || clean.endsWith('/')) return { ok: false, reason: `path "${raw}" is not a file` };
  return { ok: true, path: clean };
}
