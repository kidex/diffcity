// The spellings of a working tree root. git reports the physical path
// (`/private/var/...` on macOS), while a tool run from a directory reached
// through a symbolic link writes the logical one (`/var/...`) into its
// findings. `diffcity import` accepts absolute paths under any of them.

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

const real = (path: string): Promise<string | null> => realpath(path).catch(() => null);

/**
 * `root` (as git gives it), its realpath, and the logical root of every
 * directory in `logical` (the cwd as the caller knows it, `$PWD`) that lies
 * inside it: the directory with its path below the root taken off. A
 * directory whose spelling does not end with that path (a link inside the
 * repo) adds nothing. Duplicates are dropped; `root` comes first.
 */
export async function rootSpellings(root: string, logical: readonly (string | undefined)[]): Promise<string[]> {
  const spellings = [root];
  const realRoot = await real(root);
  if (realRoot === null) return spellings;
  spellings.push(realRoot);
  for (const dir of logical) {
    if (dir === undefined || !isAbsolute(dir)) continue;
    const realDir = await real(dir);
    if (realDir === null) continue;
    const below = relative(realRoot, realDir);
    if (below.startsWith('..') || isAbsolute(below)) continue;
    const trimmed = dir.replace(/[\\/]+$/, '');
    if (below === '') spellings.push(trimmed);
    else if (trimmed.endsWith(`${sep}${below}`)) spellings.push(trimmed.slice(0, -(below.length + 1)));
  }
  return [...new Set(spellings)];
}
