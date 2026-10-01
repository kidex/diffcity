// What the git watcher of a repo listens to (ADR-020, SPEC.md section 3a C4):
// under the git common dir, only
//
// - `HEAD` (the main working tree's HEAD);
// - `packed-refs`;
// - everything under `refs/`;
// - `worktrees/<name>/HEAD` (the HEAD of each linked working tree).
//
// One watcher on the common dir covers all of them, including a packed-refs
// that does not exist yet and linked worktrees added later. `index` is left
// out: staging alone does not change the diff (ADR-012). Lock files are left
// out too: git renames them into place, and the rename is the event.

import { isAbsolute, relative, sep } from 'node:path';

/** A predicate on absolute paths: true for what the git watcher of `commonDir` ignores. */
export function gitIgnoreMatcher(commonDir: string): (path: string) => boolean {
  return (path) => {
    const rel = relative(commonDir, path);
    if (rel === '') return false;
    if (rel.startsWith('..') || isAbsolute(rel)) return true;
    if (rel.endsWith('.lock')) return true;
    const parts = rel.split(sep);
    const [first, , third] = parts;
    if (parts.length === 1) return !(first === 'HEAD' || first === 'packed-refs' || first === 'refs' || first === 'worktrees');
    if (first === 'refs') return false;
    // worktrees/<name> is traversed; inside it, only HEAD counts.
    if (first === 'worktrees') return parts.length > 3 || (parts.length === 3 && third !== 'HEAD');
    return true;
  };
}
