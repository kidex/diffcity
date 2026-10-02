// The reconcile pass of the chokidar working tree backend (ADR-020, SPEC.md
// section 3a C4). On Linux chokidar reads a new directory and only then puts
// its inotify watch on it: a file or subdirectory created in between gets no
// event and is never added to the watched set, and a missed subdirectory stays
// unwatched for good. The pass walks the tree on disk with the watcher's own
// ignores and lists what the watcher does not hold, so the daemon can add it.
//
// Symlinks are never added: the watcher does not follow them, so nothing below
// one is watched, and chokidar cannot hold a dangling one at all (it never
// lists it, and an explicit add() of a symlink lists it under its absolute path
// and emits `add` on every call). They are listed apart (unheldLinks) so the
// daemon can report a new one once without adding it.

import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** One entry found on disk below the walked directory. */
export interface WalkEntry {
  /** Absolute path. */
  path: string;
  dir: boolean;
  /** A symbolic link, read from the directory entry (never followed): `dir` is then false. */
  link: boolean;
}

export interface WatchWalk {
  /** Directories walked, the start included; `limit + 1` once the walk went past the limit. */
  dirs: number;
  /** The walk stopped because it went past the limit; `entries` is then partial. */
  over: boolean;
  /** Every entry not ignored below the start (not the start itself), each directory before its contents. */
  entries: WalkEntry[];
}

/**
 * Walks `start` the way the working tree watcher sees it: symlinks are not
 * followed, `ignored` paths are skipped with everything below them, and
 * unreadable directories are skipped. Stops once more than `limit` directories
 * (`start` included) have been walked.
 */
export async function walkWatched(start: string, ignored: (path: string) => boolean, limit: number): Promise<WatchWalk> {
  const entries: WalkEntry[] = [];
  let dirs = 0;
  const queue = [start];
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    dirs++;
    if (dirs > limit) return { dirs: limit + 1, over: true, entries };
    let found;
    try {
      found = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of found) {
      const path = join(dir, entry.name);
      if (ignored(path)) continue;
      const isDir = entry.isDirectory();
      entries.push({ path, dir: isDir, link: entry.isSymbolicLink() });
      if (isDir) queue.push(path);
    }
  }
  return { dirs, over: false, entries };
}

function hasAncestorIn(path: string, dirs: ReadonlySet<string>): boolean {
  for (let child = path, parent = dirname(path); parent !== child; child = parent, parent = dirname(parent)) {
    if (dirs.has(parent)) return true;
  }
  return false;
}

/**
 * Whether the watcher holds `path`. `watched` is chokidar's `getWatched()`:
 * each watched directory mapped to the names it tracks. A path is held when its
 * name is listed under its parent directory, or its absolute path is (chokidar
 * lists a symlink passed to add() that way). Parent sets are built once.
 */
function heldBy(watched: Readonly<Record<string, readonly string[]>>): (path: string) => boolean {
  const names = new Map<string, Set<string>>();
  return (path) => {
    const parent = dirname(path);
    let set = names.get(parent);
    if (set === undefined) {
      set = new Set(watched[parent] ?? []);
      names.set(parent, set);
    }
    return set.has(basename(path)) || set.has(path);
  };
}

/**
 * The entries of a walk the watcher does not hold and the daemon should add
 * (see heldBy for `watched`). Symlinks are skipped: they are never added (see
 * unheldLinks). Only the topmost missing paths are returned: adding a
 * directory adds what is below it.
 */
export function missingFromWatched(entries: readonly WalkEntry[], watched: Readonly<Record<string, readonly string[]>>): WalkEntry[] {
  const held = heldBy(watched);
  const missingDirs = new Set<string>();
  const missing: WalkEntry[] = [];
  for (const entry of entries) {
    if (entry.link || hasAncestorIn(entry.path, missingDirs) || held(entry.path)) continue;
    missing.push(entry);
    if (entry.dir) missingDirs.add(entry.path);
  }
  return missing;
}

/**
 * The symlinks of a walk the watcher does not hold, below a missing directory
 * or not: a dangling link, which chokidar never holds, or one created while
 * its directory was being read. They are reported, never added.
 */
export function unheldLinks(entries: readonly WalkEntry[], watched: Readonly<Record<string, readonly string[]>>): WalkEntry[] {
  const held = heldBy(watched);
  return entries.filter((entry) => entry.link && !held(entry.path));
}

/** The paths of `dirs` that are not below another one of them (duplicates dropped). */
export function topmostDirs(dirs: Iterable<string>): string[] {
  const all = new Set(dirs);
  const kept: string[] = [];
  for (const dir of all) {
    if (!hasAncestorIn(dir, all)) kept.push(dir);
  }
  return kept.sort();
}
