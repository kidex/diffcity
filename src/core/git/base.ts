// Base detection (ADR-012): `--base`, then `base` from diffcity.config.js, then
// main, master (each local first, then origin), then the default branch from gh.

import { GH_REPO_VIEW_ARGV } from '../exec/profiles.js';
import { defaultRunner } from '../exec/gh.js';
import { GitError, resolveCommit, type CommandRunner } from './exec.js';

export const NO_BASE_MESSAGE = 'no base branch found; pass --base or set base in diffcity.config.js';

export const GH_TIMEOUT_MS = 5000;

export type BaseSource = 'flag' | 'config' | 'main' | 'master' | 'gh';

export interface ResolvedBase {
  /** Base name as shown in meta.base (e.g. `main`, even when only origin/main exists). */
  name: string;
  /** The ref that was resolved: `refs/heads/main`, `refs/remotes/origin/main`, or the explicit ref as given. */
  ref: string;
  /** Sha of the base tip. */
  commit: string;
  source: BaseSource;
}

export interface ResolveBaseOptions {
  /** Value of `--base`. */
  flag?: string | undefined;
  /** `base` from diffcity.config.js. */
  config?: string | undefined;
  /** Runs `gh`; defaults to the hardened tool runner (ADR-032). Tests inject a fake. */
  runner?: CommandRunner | undefined;
}

/** A branch name: `refs/heads/<name>`, else `refs/remotes/origin/<name>`. */
async function resolveBranch(
  root: string,
  name: string,
): Promise<{ ref: string; commit: string } | null> {
  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    const commit = await resolveCommit(root, ref);
    if (commit !== null) return { ref, commit };
  }
  return null;
}

/** An explicit base: the ref as given (any commit-ish), else origin/<ref>. */
async function resolveExplicit(root: string, value: string, source: 'flag' | 'config'): Promise<ResolvedBase> {
  const commit = await resolveCommit(root, value);
  if (commit !== null) return { name: value, ref: value, commit, source };
  const remote = `refs/remotes/origin/${value}`;
  const remoteCommit = await resolveCommit(root, remote);
  if (remoteCommit !== null) return { name: value, ref: remote, commit: remoteCommit, source };
  throw new GitError('no-base', `base ref not found: ${value}`);
}

/** Default branch name from `gh repo view`, or null if gh is missing, slow, failing or unclear. */
async function ghDefaultBranch(root: string, runner: CommandRunner): Promise<string | null> {
  let stdout: string;
  try {
    stdout = await runner('gh', GH_REPO_VIEW_ARGV, { cwd: root, timeoutMs: GH_TIMEOUT_MS });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('defaultBranchRef' in parsed)) return null;
  const branch = parsed.defaultBranchRef;
  if (typeof branch !== 'object' || branch === null || !('name' in branch)) return null;
  const name = branch.name;
  if (typeof name !== 'string' || name === '' || name.startsWith('-')) return null;
  return name;
}

export async function resolveBase(root: string, options: ResolveBaseOptions = {}): Promise<ResolvedBase> {
  if (options.flag !== undefined) return resolveExplicit(root, options.flag, 'flag');
  if (options.config !== undefined) return resolveExplicit(root, options.config, 'config');

  for (const name of ['main', 'master'] as const) {
    const found = await resolveBranch(root, name);
    if (found !== null) return { name, ...found, source: name };
  }

  const ghName = await ghDefaultBranch(root, options.runner ?? defaultRunner);
  if (ghName !== null) {
    const found = await resolveBranch(root, ghName);
    if (found !== null) return { name: ghName, ...found, source: 'gh' };
  }

  throw new GitError('no-base', NO_BASE_MESSAGE);
}
