// Resolves which two states a diff compares (ADR-012):
// before = merge-base(base, headCommit); after = the `--head` commit or,
// without `--head`, the working tree (HEAD + staged + unstaged + non-ignored untracked).

import type { DiffcityConfig } from '../config/index.js';
import { resolveBase, type ResolvedBase } from './base.js';
import { GitError, assertNotOption, git, gitRaw, resolveCommit, type CommandRunner } from './exec.js';

export interface ResolvedChange {
  /** Absolute path of the repo's working tree root. */
  root: string;
  base: ResolvedBase;
  /** Sha of merge-base(base, headCommit): the "before" state. */
  mergeBase: string;
  /** Sha of the `--head` commit, or of HEAD when comparing the working tree. */
  headCommit: string;
  /** Label for meta.head: the `--head` value, else the current branch, else the short sha (detached HEAD). */
  head: string;
  /** True when "after" is the working tree (no `--head`). */
  worktree: boolean;
}

export interface ResolveChangeOptions {
  /** Value of `--base`. */
  base?: string | undefined;
  /** Value of `--head`. Omit to compare the working tree. */
  head?: string | undefined;
  /** Loaded diffcity.config.js (see loadConfig); only `base` is used here. */
  config?: Pick<DiffcityConfig, 'base'> | undefined;
  /** Runs `gh` during base detection; tests inject a fake. */
  runner?: CommandRunner | undefined;
}

/** Absolute path of the working tree root containing `cwd`. */
export async function findRepoRoot(cwd: string): Promise<string> {
  let result;
  try {
    result = await gitRaw(cwd, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    // cwd missing or git not installed.
    throw new GitError('not-a-repo', `not a git repository: ${cwd}`, { cause: error });
  }
  const root = result.stdout.toString('utf8').trim();
  if (result.exitCode !== 0 || root === '') throw new GitError('not-a-repo', `not a git repository: ${cwd}`);
  return root;
}

async function headLabel(root: string, headCommit: string): Promise<string> {
  const branch = await gitRaw(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const name = branch.stdout.toString('utf8').trim();
  if (branch.exitCode === 0 && name !== '') return name;
  return (await git(root, ['rev-parse', '--short', headCommit])).trim();
}

export async function resolveChange(cwd: string, options: ResolveChangeOptions = {}): Promise<ResolvedChange> {
  const root = await findRepoRoot(cwd);

  let headCommit: string;
  let head: string;
  const worktree = options.head === undefined;
  if (options.head === undefined) {
    const commit = await resolveCommit(root, 'HEAD');
    if (commit === null) throw new GitError('no-commits', `repository has no commits: ${root}`);
    headCommit = commit;
    head = await headLabel(root, headCommit);
  } else {
    assertNotOption(options.head, 'head ref');
    const commit = await resolveCommit(root, options.head);
    if (commit === null) throw new GitError('bad-ref', `head ref not found: ${options.head}`);
    headCommit = commit;
    head = options.head;
  }

  const base = await resolveBase(root, { flag: options.base, config: options.config?.base, runner: options.runner });

  const mergeBaseResult = await gitRaw(root, ['merge-base', base.commit, headCommit]);
  const mergeBase = mergeBaseResult.stdout.toString('utf8').trim();
  if (mergeBaseResult.exitCode !== 0 || mergeBase === '') {
    throw new GitError('no-base', `no common ancestor between base ${base.name} and ${head}`);
  }

  return { root, base, mergeBase, headCommit, head, worktree };
}
