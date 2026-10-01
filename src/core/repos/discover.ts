// Repo discovery for `diffcity scan <dir>` (SPEC.md section 3, ADR-016).
//
// Walks the tree below `dir` and returns every directory that contains a `.git`
// entry (a directory, or a file as in a linked worktree or a submodule). It does
// not descend into a repo it found (submodules and nested worktrees are left
// alone), into `node_modules` or into hidden directories, goes at most 6 levels
// deep and never follows symbolic links. Nothing is spawned: only readdir/lstat.

import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const DISCOVER_MAX_DEPTH = 6;

async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    const stats = await lstat(join(dir, '.git'));
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

/** Repo roots below `dir` (realpaths, sorted). Rejects when `dir` itself cannot be resolved. */
export async function discoverRepos(dir: string, maxDepth: number = DISCOVER_MAX_DEPTH): Promise<string[]> {
  const start = await realpath(resolve(dir));
  const found: string[] = [];

  const walk = async (current: string, depth: number): Promise<void> => {
    if (await hasGitEntry(current)) {
      found.push(current);
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, removed meanwhile): skip it.
      return;
    }
    const children = entries.filter(
      // Dirent of a symbolic link is never a directory, so links are not followed.
      (entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'),
    );
    await Promise.all(children.map((entry) => walk(join(current, entry.name), depth + 1)));
  };

  await walk(start, 0);
  return found.sort();
}
