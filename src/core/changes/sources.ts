// The three sources of the change list (SPEC.md section 3a, ADR-019), read
// through the git layer (execFile, GIT_OPTIONAL_LOCKS=0) and an injected
// CommandRunner for gh. Nothing here writes to the repo: no fetch, no lock.
//
// - working trees: `git worktree list` + `git status --porcelain` (L1);
// - local branches: `git for-each-ref --no-merged=<base>` + ahead/behind (L2);
// - open PRs: `gh pr list`, with `headAvailable` from the local objects (L3);
// - titles (L6) and the base per repo through resolveBase (L5).

import { realpath } from 'node:fs/promises';
import { resolveBase, type ResolvedBase } from '../git/base.js';
import { defaultRunner, git, gitRaw, type CommandRunner } from '../git/exec.js';
import { listWorktreeEntries } from './identity.js';
import type { BranchInfo, Discovered, PrInfo, PrSource, PrState, RepoIdentity, WorktreeInfo } from './types.js';

/** `gh pr list` and `gh pr view` timeout (ADR-020). */
export const GH_PR_TIMEOUT_MS = 10_000;

export const GH_PR_LIST_ARGS = [
  'pr',
  'list',
  '--state',
  'open',
  '--limit',
  '100',
  '--json',
  'number,title,headRefName,headRefOid,baseRefName,isCrossRepository',
] as const;

/** At most this many git processes at once per collection. */
const GIT_CONCURRENCY = 8;

/** An open PR as `gh pr list --json` returns it. */
export interface GhPullRequest {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toIso(date: string): string {
  const time = Date.parse(date);
  if (Number.isNaN(time)) throw new Error(`unreadable git date: ${date}`);
  return new Date(time).toISOString();
}

/** The base of the repo (L5): config, then main, master, then the default branch from gh. Cached by the caller. */
export function detectBase(
  identity: RepoIdentity,
  options: { config?: string | undefined; runner?: CommandRunner | undefined } = {},
): Promise<ResolvedBase> {
  return resolveBase(identity.path, { config: options.config, runner: options.runner });
}

/** `[behind, ahead]` of `head` relative to `base`. */
async function aheadBehind(root: string, base: string, head: string): Promise<{ ahead: number; behind: number }> {
  const output = await git(root, ['rev-list', '--left-right', '--count', `${base}...${head}`]);
  const [behind, ahead] = output.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
  if (behind === undefined || ahead === undefined || Number.isNaN(behind) || Number.isNaN(ahead)) {
    throw new Error(`unexpected rev-list output: ${output}`);
  }
  return { ahead, behind };
}

async function committerDate(root: string, commit: string): Promise<string> {
  return toIso((await git(root, ['show', '-s', '--no-show-signature', '--format=%cI', commit])).trim());
}

/** Subject of the oldest commit in `<base>..<head>` (L6). */
async function firstSubject(root: string, base: string, head: string): Promise<string | null> {
  const output = await git(root, ['log', '--no-show-signature', '--reverse', '--format=%s', `${base}..${head}`]);
  const subject = output.split('\n', 1)[0]?.trim() ?? '';
  return subject === '' ? null : subject;
}

async function isDirty(path: string): Promise<boolean> {
  const output = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  return output !== '';
}

/** Working trees (main + linked) with commits, without prunable or missing ones (L1). */
export async function listWorktrees(identity: RepoIdentity, base: ResolvedBase): Promise<WorktreeInfo[]> {
  const entries = (await listWorktreeEntries(identity.path)).filter((entry) => !entry.bare && !entry.prunable);
  const trees = await mapLimit(entries, GIT_CONCURRENCY, async (entry): Promise<WorktreeInfo | null> => {
    if (entry.head === null) return null;
    let path: string;
    try {
      path = await realpath(entry.path);
    } catch {
      return null;
    }
    const head = entry.head;
    const [dirty, counts, committedAt] = await Promise.all([
      isDirty(path),
      aheadBehind(identity.path, base.commit, head),
      committerDate(identity.path, head),
    ]);
    const branch = entry.branch?.startsWith('refs/heads/') === true ? entry.branch.slice('refs/heads/'.length) : null;
    return { path, head, branch, dirty, ...counts, committedAt };
  });
  return trees.filter((tree) => tree !== null);
}

/** Local branches with commits ahead of the base, the base itself excluded (L2), plus every local branch name. */
export async function listBranches(
  identity: RepoIdentity,
  base: ResolvedBase,
): Promise<{ branches: BranchInfo[]; localBranches: string[] }> {
  const root = identity.path;
  const format = '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)';
  const [unmerged, all] = await Promise.all([
    git(root, ['for-each-ref', `--no-merged=${base.commit}`, format, 'refs/heads']),
    git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads']),
  ]);
  const localBranches = all
    .split('\n')
    .filter((line) => line.startsWith('refs/heads/'))
    .map((line) => line.slice('refs/heads/'.length));

  const rows = unmerged.split('\n').flatMap((line) => {
    const [ref, head, date] = line.split('\0');
    if (ref === undefined || head === undefined || date === undefined || !ref.startsWith('refs/heads/')) return [];
    const name = ref.slice('refs/heads/'.length);
    return name === base.name ? [] : [{ name, head, date }];
  });
  const branches = await mapLimit(rows, GIT_CONCURRENCY, async ({ name, head, date }): Promise<BranchInfo> => {
    const [counts, subject] = await Promise.all([
      aheadBehind(root, base.commit, head),
      firstSubject(root, base.commit, head),
    ]);
    return { name, head, ...counts, title: subject ?? name, committedAt: toIso(date) };
  });
  return { branches, localBranches };
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function parsePullRequests(stdout: string): GhPullRequest[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const prs: GhPullRequest[] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const pr = item as Partial<Record<keyof GhPullRequest, unknown>>;
    if (
      typeof pr.number === 'number' &&
      Number.isInteger(pr.number) &&
      pr.number > 0 &&
      typeof pr.title === 'string' &&
      typeof pr.headRefName === 'string' &&
      typeof pr.headRefOid === 'string' &&
      OID.test(pr.headRefOid) &&
      typeof pr.baseRefName === 'string' &&
      pr.baseRefName !== '' &&
      typeof pr.isCrossRepository === 'boolean'
    ) {
      prs.push({
        number: pr.number,
        title: pr.title,
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        baseRefName: pr.baseRefName,
        isCrossRepository: pr.isCrossRepository,
      });
    }
  }
  return prs;
}

/**
 * What `gh pr list` gave (C5, ADR-020): the open PRs, or why there are none.
 * The call itself tells whether gh can be used, with no separate probe:
 * - `missing`: gh is not installed (ENOENT);
 * - `failed`: gh exited non-zero (not authenticated, no GitHub remote, an API
 *   error) or answered something unreadable;
 * - `timeout`: gh did not answer within GH_PR_TIMEOUT_MS.
 */
export type OpenPrsOutcome = { ok: true; prs: GhPullRequest[] } | { ok: false; reason: 'missing' | 'failed' | 'timeout' };

function failureReason(error: unknown): 'missing' | 'failed' | 'timeout' {
  if (typeof error !== 'object' || error === null) return 'failed';
  const { code, killed } = error as { code?: unknown; killed?: unknown };
  if (code === 'ENOENT') return 'missing';
  if (killed === true || code === 'ETIMEDOUT') return 'timeout';
  return 'failed';
}

/** Runs `gh pr list` once and classifies the outcome; never throws. */
export async function fetchOpenPrs(root: string, runner: CommandRunner = defaultRunner): Promise<OpenPrsOutcome> {
  let stdout: string;
  try {
    stdout = await runner('gh', GH_PR_LIST_ARGS, { cwd: root, timeoutMs: GH_PR_TIMEOUT_MS });
  } catch (error) {
    return { ok: false, reason: failureReason(error) };
  }
  const prs = parsePullRequests(stdout);
  return prs === null ? { ok: false, reason: 'failed' } : { ok: true, prs };
}

/**
 * Open PRs from `gh pr list` (L3, C5), or null when gh is missing, failing,
 * slow or answers something unreadable: then PRs are "unavailable" and none is archived.
 */
export async function listOpenPrs(root: string, runner: CommandRunner = defaultRunner): Promise<GhPullRequest[] | null> {
  const outcome = await fetchOpenPrs(root, runner);
  return outcome.ok ? outcome.prs : null;
}

/** `gh pr view <n> --json state`, or null when it cannot be confirmed. */
export async function prState(root: string, number: number, runner: CommandRunner = defaultRunner): Promise<PrState | null> {
  let stdout: string;
  try {
    stdout = await runner('gh', ['pr', 'view', String(number), '--json', 'state'], { cwd: root, timeoutMs: GH_PR_TIMEOUT_MS });
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null || !('state' in parsed)) return null;
    const state = parsed.state;
    return state === 'OPEN' || state === 'MERGED' || state === 'CLOSED' ? state : null;
  } catch {
    return null;
  }
}

async function hasCommit(root: string, oid: string): Promise<boolean> {
  return (await gitRaw(root, ['cat-file', '-e', `${oid}^{commit}`])).exitCode === 0;
}

/**
 * The base of a PR as the local repo knows it, never fetched: the local branch
 * `<baseRefName>`, else `origin/<baseRefName>`, else the repo base. `ref` is a
 * commit-ish to pass as `--base` (a snapshot's base), `commit` its sha.
 */
export async function prBase(root: string, baseRefName: string, repoBase: ResolvedBase): Promise<{ ref: string; commit: string }> {
  const candidates = [
    { ref: baseRefName, full: `refs/heads/${baseRefName}` },
    { ref: `origin/${baseRefName}`, full: `refs/remotes/origin/${baseRefName}` },
  ];
  for (const { ref, full } of candidates) {
    const result = await gitRaw(root, ['rev-parse', '--verify', '--quiet', `${full}^{commit}`]);
    if (result.exitCode === 0) return { ref, commit: result.stdout.toString('utf8').trim() };
  }
  return { ref: repoBase.commit, commit: repoBase.commit };
}

/** Completes a gh PR with what the local repo knows; never fetches (Q3). */
async function localPrInfo(root: string, pr: GhPullRequest, base: ResolvedBase): Promise<PrInfo> {
  const headAvailable = await hasCommit(root, pr.headRefOid);
  if (!headAvailable) return { ...pr, headAvailable, ahead: null, behind: null, committedAt: null };
  const baseCommit = (await prBase(root, pr.baseRefName, base)).commit;
  const [counts, committedAt] = await Promise.all([
    aheadBehind(root, baseCommit, pr.headRefOid),
    committerDate(root, pr.headRefOid),
  ]);
  return { ...pr, headAvailable, ...counts, committedAt };
}

/**
 * The PR source for reconcile: `openPrs` (from `listOpenPrs` or the daemon's
 * cache; null = gh unavailable) completed locally, plus the confirmed state of
 * each live PR missing from the open list.
 */
export async function readPrs(
  identity: RepoIdentity,
  base: ResolvedBase,
  openPrs: readonly GhPullRequest[] | null,
  livePrNumbers: readonly number[],
  runner: CommandRunner = defaultRunner,
): Promise<PrSource> {
  if (openPrs === null) return { available: false };
  const open = await mapLimit(openPrs, GIT_CONCURRENCY, (pr) => localPrInfo(identity.path, pr, base));
  const listed = new Set(openPrs.map((pr) => pr.number));
  const states: Record<number, PrState> = {};
  for (const number of livePrNumbers) {
    if (listed.has(number)) continue;
    const state = await prState(identity.path, number, runner);
    if (state !== null) states[number] = state;
  }
  return { available: true, open, states };
}

export interface CollectSourcesOptions {
  /** The repo base, resolved with `detectBase` and cached by the caller. */
  base: ResolvedBase;
  /** Open PRs (fresh or cached); null when gh is unavailable or not consulted. */
  openPrs: readonly GhPullRequest[] | null;
  /** PR numbers of the live changes, to confirm the state of those no longer open. */
  livePrNumbers?: readonly number[];
  /** Runs gh; tests inject a fake. */
  runner?: CommandRunner;
}

/** Reads all three sources of a repo for `reconcile`. */
export async function collectSources(identity: RepoIdentity, options: CollectSourcesOptions): Promise<Discovered> {
  const [worktrees, refs, prs] = await Promise.all([
    listWorktrees(identity, options.base),
    listBranches(identity, options.base),
    readPrs(identity, options.base, options.openPrs, options.livePrNumbers ?? [], options.runner),
  ]);
  return {
    repoPath: identity.path,
    base: options.base.name,
    worktrees,
    branches: refs.branches,
    localBranches: refs.localBranches,
    prs,
  };
}
