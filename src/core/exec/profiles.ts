// The tool profiles (ADR-032): binary name, extra environment, timeout and how
// a failure reads, plus the builders that make every argv from validated
// values. Shas match ^[0-9a-f]{40}$, PR numbers and check-run ids are positive
// integers, paths come from a snapshot only.

import { toolArgs, type ToolArgs, type ToolProfile } from './tool.js';

const SHA = /^[0-9a-f]{40}$/;

export function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** gh cannot answer in this repo: not authenticated, no GitHub remote, not a repo gh knows. */
const GH_UNAVAILABLE =
  /gh auth login|not logged in|authentication required|HTTP 401|bad credentials|no git remotes|none of the git remotes|not a git repository|could not determine (?:the )?(?:base )?repo|no known GitHub host/i;

/** gh could not reach GitHub. */
const GH_OFFLINE =
  /error connecting to|could not resolve host|no such host|dial tcp|network is unreachable|connection refused|connection reset|i\/o timeout|TLS handshake timeout/i;

export const GH_PROFILE: ToolProfile = {
  name: 'gh',
  timeoutMs: 30_000,
  env: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR'],
  stdin: 'closed',
  classify(stderr) {
    if (GH_UNAVAILABLE.test(stderr)) return 'unavailable';
    if (GH_OFFLINE.test(stderr)) return 'offline';
    return 'error';
  },
};

/**
 * `claude` for "send review to the agent" (ADR-029): the summary goes on
 * stdin. Only the profile lives here; building and starting the call is the
 * review feature's.
 */
export const CLAUDE_PROFILE: ToolProfile = {
  name: 'claude',
  timeoutMs: 10 * 60 * 1000,
  env: ['CLAUDE_CONFIG_DIR'],
  stdin: 'input',
  classify() {
    return 'error';
  },
};

/** `gh pr list` of the open PRs (ADR-020). */
export const GH_PR_LIST_ARGV = [
  'pr',
  'list',
  '--state',
  'open',
  '--limit',
  '100',
  '--json',
  'number,title,headRefName,headRefOid,baseRefName,isCrossRepository',
] as const;

/** `gh repo view` of the default branch, for base detection (ADR-012). */
export const GH_REPO_VIEW_ARGV = ['repo', 'view', '--json', 'defaultBranchRef'] as const;

export function ghPrList(): ToolArgs {
  return toolArgs(GH_PROFILE, GH_PR_LIST_ARGV);
}

export function ghRepoView(): ToolArgs {
  return toolArgs(GH_PROFILE, GH_REPO_VIEW_ARGV);
}

/** `gh pr view <number> --json state`; throws on a number that is not a positive integer. */
export function ghPrView(number: number): ToolArgs {
  if (!isPositiveInt(number)) throw new RangeError(`invalid PR number: ${String(number)}`);
  return toolArgs(GH_PROFILE, ['pr', 'view', String(number), '--json', 'state']);
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * The gh arguments an argv stands for, rebuilt by its builder, or null when
 * it is none of the calls diffcity makes. What a CommandRunner is handed is
 * checked through this before gh runs.
 */
export function ghArgsFrom(argv: readonly string[]): ToolArgs | null {
  if (sameArgv(argv, GH_PR_LIST_ARGV)) return ghPrList();
  if (sameArgv(argv, GH_REPO_VIEW_ARGV)) return ghRepoView();
  const [pr, view, number, json, state, ...rest] = argv;
  if (pr === 'pr' && view === 'view' && json === '--json' && state === 'state' && rest.length === 0 && number !== undefined && /^[1-9][0-9]{0,15}$/.test(number)) {
    const value = Number(number);
    if (isPositiveInt(value)) return ghPrView(value);
  }
  return null;
}
