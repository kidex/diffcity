// diffcity's own files in a working tree (SPEC.md section 3a, ADR-036 Q6):
// `.diffcity/findings.json` (written by the /diffcity-review command, read by
// `diffcity import`) and `.diffcity/fix-queue.json` (written by the daemon).
// They are never part of a change: left out of the touched files, of the
// untracked listing and of the dirty check, and ignored by the watcher, so an
// import or a queued fix creates no Draft and no recollect.
// `.diffcity/fix-queue.taking.json` is the fix queue while the /diffcity-review
// command applies it: the command renames the queue to it, so an item the
// daemon appends meanwhile goes to a new queue and is neither lost nor applied
// twice (ADR-037), then deletes it. Every other file
// under `.diffcity/` (`.diffcity/spec.md`, say) is a normal file.
//
// Only the copies at the working tree root count: `pkg/.diffcity/findings.json`
// is a normal file. The fix queue's temporary file (written next to it and
// renamed into place, src/core/fix-queue) is part of the fix queue.

/** The directory of the own files, at the working tree root. */
export const OWN_DIR = '.diffcity';

/** Root-relative, `/`-separated paths of the own files. */
export const OWN_FILES: readonly string[] = [`${OWN_DIR}/findings.json`, `${OWN_DIR}/fix-queue.json`, `${OWN_DIR}/fix-queue.taking.json`];

const OWN_SET: ReadonlySet<string> = new Set(OWN_FILES);

/** `.diffcity/.fix-queue.json.<pid>.<12 hex>.tmp`, the fix queue's temporary file before its rename. */
const FIX_QUEUE_TEMP = /^\.diffcity\/\.fix-queue\.json\.\d+\.[0-9a-f]{12}\.tmp$/;

/** True for a root-relative, `/`-separated path that is one of diffcity's own files. */
export function isOwnFile(path: string): boolean {
  return OWN_SET.has(path) || FIX_QUEUE_TEMP.test(path);
}
