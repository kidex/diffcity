// diffcity's own files in a working tree (SPEC.md section 3a, ADR-036):
// `.diffcity/findings.json` (written by the /diffcity-review command, read by
// `diffcity import`), the fix queue directory `.diffcity/fix-queue/` (one file
// per item, written by the daemon) and `.diffcity/fix-queue.taking/` (the
// queue while the /diffcity-review command applies it: the command renames
// the directory to it, reads it and removes it). The two directories count
// with everything inside them. The daemon's temporary file for an item,
// `.diffcity/.fix-queue.<32 hex>.<pid>.<12 hex>.tmp`, written next to the
// queue directory and renamed into it, is part of the fix queue too.
//
// They are never part of a change: left out of the touched files, of the
// untracked listing and of the dirty check, and ignored by the watcher, so an
// import or a queued fix creates no Draft and no recollect. Every other file
// under `.diffcity/` (`.diffcity/spec.md`, say) is a normal file.
//
// Only the copies at the working tree root count: `pkg/.diffcity/findings.json`
// is a normal file.

/** The directory of the own files, at the working tree root. */
export const OWN_DIR = '.diffcity';

/** Root-relative, `/`-separated paths of the own single files. */
export const OWN_FILES: readonly string[] = [`${OWN_DIR}/findings.json`];

/** Root-relative, `/`-separated own directories: they and everything in them are own files. */
export const OWN_DIRS: readonly string[] = [`${OWN_DIR}/fix-queue`, `${OWN_DIR}/fix-queue.taking`];

const OWN_SET: ReadonlySet<string> = new Set(OWN_FILES);

/** The fix queue's temporary file for an item, before its rename into the queue directory. */
const FIX_QUEUE_TEMP = /^\.diffcity\/\.fix-queue\.[0-9a-f]{32}\.\d+\.[0-9a-f]{12}\.tmp$/;

/** True for a root-relative, `/`-separated path that is diffcity's own (a trailing `/` is allowed). */
export function isOwnFile(path: string): boolean {
  if (OWN_SET.has(path) || FIX_QUEUE_TEMP.test(path)) return true;
  return OWN_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}
