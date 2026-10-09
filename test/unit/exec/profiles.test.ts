// Tool profiles and argv builders (ADR-032): every argv comes from validated values.

import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PROFILE,
  GH_PROFILE,
  GH_PR_LIST_ARGV,
  GH_REPO_VIEW_ARGV,
  ghArgsFrom,
  ghPrList,
  ghPrView,
  ghRepoView,
  isPositiveInt,
  isSha,
} from '../../../src/core/exec/index.js';

describe('validators', () => {
  it('a sha is 40 lowercase hex digits', () => {
    expect(isSha('a'.repeat(40))).toBe(true);
    expect(isSha('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    for (const bad of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), `-${'a'.repeat(39)}`, 'HEAD', 42]) expect(isSha(bad)).toBe(false);
  });

  it('PR numbers and check-run ids are positive integers', () => {
    expect(isPositiveInt(1)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '7']) expect(isPositiveInt(bad)).toBe(false);
  });
});

describe('gh builders', () => {
  it('build the argv of the three gh calls', () => {
    expect(ghPrList()).toEqual({ tool: 'gh', argv: [...GH_PR_LIST_ARGV] });
    expect(ghRepoView()).toEqual({ tool: 'gh', argv: [...GH_REPO_VIEW_ARGV] });
    expect(ghPrView(12)).toEqual({ tool: 'gh', argv: ['pr', 'view', '12', '--json', 'state'] });
  });

  it('refuse a PR number that is not a positive integer', () => {
    for (const bad of [0, -3, 2.5, Number.NaN]) expect(() => ghPrView(bad)).toThrow(RangeError);
  });

  it('ghArgsFrom accepts only an argv one of the builders makes', () => {
    expect(ghArgsFrom([...GH_PR_LIST_ARGV])).toEqual(ghPrList());
    expect(ghArgsFrom(['repo', 'view', '--json', 'defaultBranchRef'])).toEqual(ghRepoView());
    expect(ghArgsFrom(['pr', 'view', '7', '--json', 'state'])).toEqual(ghPrView(7));
    for (const bad of [
      ['pr', 'view', '0', '--json', 'state'],
      ['pr', 'view', '-7', '--json', 'state'],
      ['pr', 'view', '07', '--json', 'state'],
      ['pr', 'view', '7', '--json', 'state', '--web'],
      ['pr', 'view', '--repo=elsewhere/x', '--json', 'state'],
      ['pr', 'list'],
      ['repo', 'view'],
      ['api', '/user'],
      ['auth', 'token'],
      [],
    ]) {
      expect(ghArgsFrom(bad), bad.join(' ')).toBeNull();
    }
  });
});

describe('profiles', () => {
  it('gh: 30 s, stdin closed, its own variables', () => {
    expect(GH_PROFILE).toMatchObject({ name: 'gh', timeoutMs: 30_000, stdin: 'closed', env: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR'] });
  });

  it.each([
    ['To get started with GitHub CLI, please run:  gh auth login', 'unavailable'],
    ['no git remotes found', 'unavailable'],
    ['none of the git remotes configured for this repository point to a known GitHub host.', 'unavailable'],
    ['failed to run git: fatal: not a git repository (or any of the parent directories): .git', 'unavailable'],
    ['HTTP 401: Bad credentials (https://api.github.com/graphql)', 'unavailable'],
    ['error connecting to api.github.com', 'offline'],
    ['Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host', 'offline'],
    ['HTTP 502: Bad Gateway', 'error'],
    ['', 'error'],
  ] as const)('gh classifies %j as %s', (stderr, kind) => {
    expect(GH_PROFILE.classify(stderr)).toBe(kind);
  });

  it('claude: reads its input on stdin, keeps its config dir and the API-key login variables (ADR-029 decision 1)', () => {
    expect(CLAUDE_PROFILE).toMatchObject({ name: 'claude', stdin: 'input', env: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] });
    // The longest agentLaunch.timeoutMinutes, and SIGKILL 10 s after SIGTERM (ADR-029).
    expect(CLAUDE_PROFILE.timeoutMs).toBe(120 * 60 * 1000);
    expect(CLAUDE_PROFILE.killGraceMs).toBe(10_000);
  });
});
