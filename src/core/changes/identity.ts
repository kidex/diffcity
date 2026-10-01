// Repo identity (ADR-019): a repo is the realpath of its git common dir, so its
// root, any subfolder and every linked worktree name the same repo. Its path is
// the main working tree. Bare repos have no working tree and are refused.

import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { GitError, gitRaw, splitNul } from '../git/exec.js';
import type { RepoIdentity } from './types.js';

export const BARE_REPO_MESSAGE = 'bare repositories are not supported';

function notARepo(dir: string, cause?: unknown): GitError {
  return new GitError('not-a-repo', `not a git repository: ${dir}`, cause === undefined ? undefined : { cause });
}

/** One `git worktree list --porcelain -z` entry. */
export interface WorktreeEntry {
  path: string;
  /** Sha of HEAD; null for an unborn branch. */
  head: string | null;
  /** Full ref name (`refs/heads/<name>`) or null when detached. */
  branch: string | null;
  bare: boolean;
  prunable: boolean;
}

const ZERO_SHA = /^0+$/;

/** Parses `git worktree list --porcelain -z`: attributes end with NUL, entries are separated by an empty one. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const token of splitNul(output)) {
    if (token === '') {
      current = null;
      continue;
    }
    const space = token.indexOf(' ');
    const key = space === -1 ? token : token.slice(0, space);
    const value = space === -1 ? '' : token.slice(space + 1);
    if (key === 'worktree') {
      current = { path: value, head: null, branch: null, bare: false, prunable: false };
      entries.push(current);
      continue;
    }
    if (current === null) continue;
    if (key === 'HEAD') current.head = value === '' || ZERO_SHA.test(value) ? null : value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'bare') current.bare = true;
    else if (key === 'prunable') current.prunable = true;
  }
  return entries;
}

/** The worktree list of the repo containing `cwd`. */
export async function listWorktreeEntries(cwd: string): Promise<WorktreeEntry[]> {
  const result = await gitRaw(cwd, ['worktree', 'list', '--porcelain', '-z']);
  if (result.exitCode !== 0) throw notARepo(cwd);
  return parseWorktreeList(result.stdout.toString('utf8'));
}

/** Identifies the repo containing `dir` (its root, a subfolder or a linked worktree). */
export async function identifyRepo(dir: string): Promise<RepoIdentity> {
  let probe;
  try {
    probe = await gitRaw(dir, ['rev-parse', '--path-format=absolute', '--is-bare-repository', '--git-common-dir']);
  } catch (error) {
    // dir missing or git not installed.
    throw notARepo(dir, error);
  }
  if (probe.exitCode !== 0) throw notARepo(dir);
  const [bare, commonDir] = probe.stdout.toString('utf8').split('\n');
  if (bare === 'true') throw new GitError('not-a-repo', BARE_REPO_MESSAGE);
  if (commonDir === undefined || commonDir === '') throw notARepo(dir);

  const main = (await listWorktreeEntries(dir))[0];
  // A repo whose main entry is bare only has linked worktrees: there is no main working tree.
  if (main === undefined || main.bare) throw new GitError('not-a-repo', BARE_REPO_MESSAGE);

  const path = await realpath(main.path);
  return { gitCommonDir: await realpath(commonDir), path, name: basename(path) };
}
