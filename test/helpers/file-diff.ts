// Small repos and requests for the file view tests (ADR-027): a `main`
// commit, a `feature` commit on top, and the fingerprints a snapshot of that
// change would hold.

import { createHash } from 'node:crypto';
import { createDiffGit, type DiffGit } from '../../src/core/diff/diff-git.js';
import type { DiffSymbol, FileDiffRequest } from '../../src/core/diff/file-diff.js';
import { createRepo, type FileTree, type TempRepo } from './repo.js';

export const sha = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

export interface Change {
  repo: TempRepo;
  mergeBase: string;
  head: string;
  git: DiffGit;
  /** A request for `path` as a snapshot of this change would make it. */
  request(path: string, options?: RequestOptions): FileDiffRequest;
}

export interface RequestOptions {
  language?: string;
  symbols?: DiffSymbol[];
  focus?: string;
  /** Path in the before state, for a rename. */
  oldPath?: string;
  /** Content the fingerprint was taken from, when it is not the committed one (a working tree snapshot). */
  after?: string | null;
  worktree?: boolean;
}

const TS = 'typescript';

/** `before` committed on main, `after` on a `feature` branch on top of it (null deletes a file). */
export async function featureChange(before: FileTree, after: FileTree, repos: TempRepo[]): Promise<Change> {
  const repo = await createRepo({ name: 'sample-shop', files: before });
  repos.push(repo);
  const mergeBase = await repo.head();
  await repo.branch('feature');
  const head = await repo.commit('change', after);
  const git = createDiffGit(repo.dir);
  const text = (tree: FileTree, path: string): string | null => tree[path] ?? null;
  // A file the change does not mention is untouched: it is the same on both sides.
  const afterOf = (path: string): string | null => (path in after ? text(after, path) : text(before, path));
  return {
    repo,
    mergeBase,
    head,
    git,
    request(path, options = {}) {
      const oldPath = options.oldPath;
      const beforeText = text(before, oldPath ?? path);
      const afterText = options.after !== undefined ? options.after : afterOf(path);
      return {
        snapshotId: 1,
        head,
        mergeBase,
        worktree: options.worktree ?? false,
        path,
        language: options.language ?? TS,
        fingerprint: {
          before: beforeText === null ? null : sha(beforeText),
          after: afterText === null ? null : sha(afterText),
          ...(oldPath === undefined ? {} : { oldPath }),
        },
        symbols: options.symbols ?? [],
        ...(options.focus === undefined ? {} : { focus: options.focus }),
      };
    },
  };
}

/** `count` numbered lines: `line 1`, `line 2`, ... */
export function lines(count: number, edit: Record<number, string> = {}): string {
  return Array.from({ length: count }, (_, i) => `${edit[i + 1] ?? `line ${String(i + 1)}`}\n`).join('');
}
