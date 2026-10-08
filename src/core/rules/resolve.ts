// Import resolution for the layers rule (ADR-031): pure string work against a
// snapshot's file list, no filesystem access.
// 1. `./` and `../` specifiers are joined to the importer's directory; a path
//    that leaves the repo is unresolved.
// 2. Bare specifiers go through the rule's `aliases` (longest prefix wins),
//    then, with `useTsconfigPaths`, the root tsconfig's `compilerOptions.paths`.
//    A specifier neither maps is an external package, ignored.
// 3. Candidates in order: the exact path; + each extension; a `.js`, `.mjs` or
//    `.cjs` suffix swapped for its TS sibling; `/index.` + each extension.
//    The first one in the file list wins; none is unresolved.

import { posix } from 'node:path';

/** compilerOptions.paths of the root tsconfig, read as data (readTsconfigPaths). */
export interface TsconfigPaths {
  /** Repo-relative directory the targets are relative to (`baseUrl`, or the root as ''). */
  base: string;
  /** Pattern (at most one `*`) to its targets. */
  paths: Readonly<Record<string, readonly string[]>>;
}

export type Resolution = { kind: 'file'; path: string } | { kind: 'external' } | { kind: 'unresolved' };

export const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'] as const;

/** The TS source a JS suffix is emitted from (TS ESM style). */
const TS_SIBLINGS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const EXTERNAL: Resolution = { kind: 'external' };
const UNRESOLVED: Resolution = { kind: 'unresolved' };

/** A repo-relative path, normalized; null when it leaves the repo. */
function insideRepo(path: string): string | null {
  const normal = posix.normalize(path);
  if (normal === '.' || normal === '..' || normal.startsWith('../') || posix.isAbsolute(normal)) return null;
  return normal.endsWith('/') ? normal.slice(0, -1) : normal;
}

/** The first candidate of a repo path that is in `files`. */
function firstFile(target: string, files: ReadonlySet<string>): string | null {
  if (files.has(target)) return target;
  for (const extension of EXTENSIONS) if (files.has(target + extension)) return target + extension;
  const extension = posix.extname(target);
  const stem = target.slice(0, target.length - extension.length);
  for (const sibling of TS_SIBLINGS[extension] ?? []) if (files.has(stem + sibling)) return stem + sibling;
  for (const extension of EXTENSIONS) {
    const index = `${target}/index${extension}`;
    if (files.has(index)) return index;
  }
  return null;
}

function resolvePath(path: string, files: ReadonlySet<string>): Resolution {
  const inside = insideRepo(path);
  if (inside === null) return UNRESOLVED;
  const file = firstFile(inside, files);
  return file === null ? UNRESOLVED : { kind: 'file', path: file };
}

export interface ResolverOptions {
  aliases?: Readonly<Record<string, string>> | undefined;
  tsconfigPaths?: TsconfigPaths | null | undefined;
}

/** A specifier's targets through tsconfig paths, in TypeScript's order; null when no pattern matches. */
function tsconfigTargets(specifier: string, config: TsconfigPaths): string[] | null {
  let best: { prefix: string; targets: readonly string[]; star: string } | null = null;
  for (const [pattern, targets] of Object.entries(config.paths)) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      // An exact pattern wins over every star pattern.
      if (pattern === specifier) return targets.map((target) => posix.join(config.base, target));
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (best === null || prefix.length > best.prefix.length) {
      best = { prefix, targets, star: specifier.slice(prefix.length, specifier.length - suffix.length) };
    }
  }
  if (best === null) return null;
  const { targets, star } = best;
  return targets.map((target) => posix.join(config.base, target.replace('*', star)));
}

/**
 * The resolver of one file list. `specifier` null (a template or computed
 * specifier) is unresolved. Deterministic: the same list and options give the
 * same answer.
 */
export function createResolver(files: ReadonlySet<string>, options: ResolverOptions = {}): (importer: string, specifier: string | null) => Resolution {
  const aliases = Object.entries(options.aliases ?? {}).sort(([a], [b]) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const tsconfigPaths = options.tsconfigPaths ?? null;
  return (importer, specifier) => {
    if (specifier === null || specifier === '') return UNRESOLVED;
    if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) {
      return resolvePath(posix.join(posix.dirname(importer), specifier), files);
    }
    // A filesystem path or URL is not a package and names no repo file.
    if (specifier.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(specifier)) return UNRESOLVED;
    let mapped = false;
    const alias = aliases.find(([prefix]) => specifier.startsWith(prefix));
    if (alias !== undefined) {
      mapped = true;
      const resolved = resolvePath(alias[1] + specifier.slice(alias[0].length), files);
      if (resolved.kind === 'file') return resolved;
    }
    const targets = tsconfigPaths === null ? null : tsconfigTargets(specifier, tsconfigPaths);
    if (targets !== null) {
      mapped = true;
      for (const target of targets) {
        const resolved = resolvePath(target, files);
        if (resolved.kind === 'file') return resolved;
      }
    }
    return mapped ? UNRESOLVED : EXTERNAL;
  };
}
