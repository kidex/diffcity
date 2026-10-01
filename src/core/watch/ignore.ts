// What the working tree watchers leave out (ADR-020): any `.git` or
// `node_modules` segment, every path git reports as ignored, and the linked
// worktrees nested inside a working tree (they get their own watcher).
//
// The ignored set comes from `git ls-files --others --ignored --exclude-standard
// --directory -z`, which lists ignored files and collapses fully ignored
// directories into `dir/`. It is computed when a watcher starts and again after
// each collection and on any `.gitignore` change.

import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { git, splitNul } from '../git/exec.js';

/** Directory names never watched, wherever they appear. */
export const ALWAYS_IGNORED_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/** The ignored entries of a working tree, relative to its root, `/`-separated, without a trailing slash. */
export interface IgnoredSet {
  dirs: ReadonlySet<string>;
  files: ReadonlySet<string>;
}

/** Parses `git ls-files -z --others --ignored --exclude-standard --directory`. */
export function parseIgnored(output: string): IgnoredSet {
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const entry of splitNul(output)) {
    if (entry === '') continue;
    if (entry.endsWith('/')) dirs.add(entry.slice(0, -1));
    else files.add(entry);
  }
  return { dirs, files };
}

/** The paths git ignores in the working tree at `root`. */
export async function listIgnored(root: string): Promise<IgnoredSet> {
  return parseIgnored(await git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']));
}

/**
 * A predicate on absolute paths: true for what the watcher of the working
 * tree at `root` must not watch. `nested` holds the absolute paths of other
 * working trees inside this one. Paths outside `root` are never ignored here.
 */
export function ignoreMatcher(root: string, ignored: IgnoredSet, nested: readonly string[] = []): (path: string) => boolean {
  const nestedRel = new Set(nested.map((path) => relative(root, path).split(sep).join('/')).filter((rel) => rel !== '' && !rel.startsWith('..')));
  return (path) => {
    const rel = relative(root, path);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
    const parts = rel.split(sep);
    if (parts.some((part) => ALWAYS_IGNORED_NAMES.has(part))) return true;
    const posix = parts.join('/');
    if (ignored.files.has(posix)) return true;
    let prefix = '';
    for (const part of parts) {
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      if (ignored.dirs.has(prefix) || nestedRel.has(prefix)) return true;
    }
    return false;
  };
}

/**
 * Counts the directories a watcher of `root` would watch (root included,
 * symlinks not followed, `ignored` ones skipped), stopping once the count
 * exceeds `limit`: the result is then `limit + 1`. Unreadable directories are
 * skipped.
 */
export async function countWatchedDirs(root: string, ignored: (path: string) => boolean, limit: number): Promise<number> {
  let count = 0;
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    count++;
    if (count > limit) return limit + 1;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (!ignored(path)) queue.push(path);
    }
  }
  return count;
}
