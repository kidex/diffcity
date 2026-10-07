import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/** Lower case, collapsed whitespace, trailing punctuation removed (SPEC.md 5.6). */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,;:!?…]+$/u, '');
}

/** `f:` + the first 16 hex of sha256(source, file, normalized title, line), NUL separated (ADR-036). */
export function findingKey(source: string, file: string, title: string, line: number): string {
  const digest = createHash('sha256')
    .update(`${source}\0${file}\0${normalizeTitle(title)}\0${String(line)}`)
    .digest('hex');
  return `f:${digest.slice(0, 16)}`;
}

export type PathResult = { ok: true; path: string } | { ok: false; reason: string };

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
export function normalizeSarifUri(uri: string, repoRoot: string): PathResult {
  const trimmed = uri.trim();
  return normalizePath(trimmed.startsWith('file://') ? trimmed : decodeUri(trimmed), repoRoot);
}

/**
 * A path as the Report writes it: repo-relative, `/` separators, no `..`.
 * Absolute paths (and `file://` URIs) are made relative to `repoRoot`, or refused.
 */
export function normalizePath(raw: string, repoRoot?: string): PathResult {
  let path = raw.trim();
  if (path.startsWith('file://')) path = decodeUri(path.slice('file://'.length).replace(/^\/(?=[A-Za-z]:)/, ''));
  path = path.replace(/\\/g, '/');
  if (path === '') return { ok: false, reason: 'empty path' };
  const absolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path);
  if (absolute) {
    if (repoRoot === undefined) return { ok: false, reason: `absolute path "${path}" and no repository root` };
    const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (path !== root && !path.startsWith(`${root}/`)) {
      return { ok: false, reason: `absolute path "${path}" is outside the repository` };
    }
    path = path.slice(root.length + 1);
  }
  if (path.split('/').includes('..')) return { ok: false, reason: `path "${path}" contains ".."` };
  const clean = posix.normalize(path).replace(/^(\.\/)+/, '');
  if (clean === '' || clean === '.' || clean.endsWith('/')) return { ok: false, reason: `path "${raw}" is not a file` };
  return { ok: true, path: clean };
}
