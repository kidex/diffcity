// The git side of the file view (ADR-027): every byte of a file diff comes
// through the hardened git layer (ADR-024) of one repo or working tree, never
// through the filesystem. file-diff.ts takes this as an injected runner.

import { gitRaw, type GitCallOptions, type GitResult } from '../git/exec.js';
import { withIntentToAddIndex } from '../git/files.js';

/** Runs git in a fixed directory with the ADR-024 guards; pathspecs are always literal. */
export type GitRunner = (args: readonly string[], options?: GitCallOptions) => Promise<GitResult>;

/** What file-diff.ts needs from git. */
export interface DiffGit {
  run: GitRunner;
  /**
   * Runs `fn` with the environment of a throwaway index in which `untracked`
   * are marked intent-to-add (the repo's own index is not touched), so an
   * untracked file diffs as an add and pairs up with a deleted one as a rename.
   * `fn` gets `undefined` when no such index could be made.
   */
  withUntrackedIndex<T>(untracked: readonly string[], fn: (env: Record<string, string> | undefined) => Promise<T>): Promise<T>;
}

/** The git adapter of `dir`: a repo root for a commit, the change's working tree for a dirty change. */
export function createDiffGit(dir: string): DiffGit {
  return {
    run: (args, options = {}) => gitRaw(dir, args, { ...options, env: { GIT_LITERAL_PATHSPECS: '1', ...options.env } }),
    withUntrackedIndex: (untracked, fn) => withIntentToAddIndex(dir, untracked, fn),
  };
}
