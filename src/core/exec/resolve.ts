// Where a tool's binary is (ADR-032): `settings.tools.<name>` when set,
// otherwise the first match on the daemon's PATH, remembered for an hour.
// Relative PATH entries (an empty one means the current directory) are
// skipped: the current directory of a tool call is a repo, and a repo's own
// `./bin` or `node_modules/.bin` must never stand in for the tool.

import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';

/** How long a binary found on the PATH is remembered. */
export const PATH_CACHE_TTL_MS = 60 * 60 * 1000;

interface Cached {
  path: string;
  at: number;
}

const cache = new Map<string, Cached>();

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The absolute PATH entries, in order; relative and empty ones are dropped. */
export function absolutePathEntries(pathValue: string | undefined): string[] {
  return (pathValue ?? '').split(delimiter).filter((entry) => entry !== '' && isAbsolute(entry));
}

/**
 * The realpath of the first executable regular file `name` in an absolute
 * entry of `pathValue`, or null. Remembered per name and PATH for an hour.
 */
export async function findOnPath(name: string, pathValue: string | undefined, now: number = Date.now()): Promise<string | null> {
  const key = `${name}\0${pathValue ?? ''}`;
  const hit = cache.get(key);
  if (hit !== undefined && now - hit.at < PATH_CACHE_TTL_MS) return hit.path;
  for (const dir of absolutePathEntries(pathValue)) {
    const candidate = join(dir, name);
    if (await isExecutableFile(candidate)) {
      const path = await realpath(candidate);
      cache.set(key, { path, at: now });
      return path;
    }
  }
  cache.delete(key);
  return null;
}

/** Forgets a remembered binary, e.g. one that vanished since it was found. */
export function forgetBinary(name: string, pathValue: string | undefined): void {
  cache.delete(`${name}\0${pathValue ?? ''}`);
}

/** Whether `path` is `root` or inside it; both are realpaths. */
export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** The realpath of `path`, or `path` itself when it cannot be resolved. */
export async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
