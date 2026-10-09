// The gh call sites on the hardened runner (ADR-032): the CommandRunner they
// default to is an adapter over runTool, and what each call site makes of
// gh's answer is unchanged. A stub gh on a temporary PATH stands in for gh.

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GH_PR_TIMEOUT_MS, fetchOpenPrs, prState } from '../../../src/core/changes/sources.js';
import { GH_PROFILE, ToolCallError, createGhRunner, createLimiter, ghPrList, type ToolContext } from '../../../src/core/exec/index.js';
import type { CommandRunner } from '../../../src/core/git/index.js';
import { GH_TIMEOUT_MS, resolveBase } from '../../../src/core/git/index.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';
import { createToolStubs, type ToolStubs } from '../../helpers/tool-stub.js';

isolateGitConfig();

let stubs: ToolStubs;
let scratch: string;
let repo: TempRepo;
let runner: CommandRunner;
let calls: number[];

const PR = {
  number: 7,
  title: 'Add the ledger total',
  headRefName: 'feature/ledger',
  headRefOid: 'a'.repeat(40),
  baseRefName: 'trunk',
  isCrossRepository: false,
};

function ghRunner(context: ToolContext = {}): CommandRunner {
  return createGhRunner({ env: { PATH: `${stubs.bin}:/usr/bin:/bin`, HOME: scratch }, limiter: createLimiter(), ...context });
}

/**
 * The call sites' own timeouts (5 s, 10 s) are recorded, then raised to the
 * profile's 30 s: a macOS process-start stall must not read as a gh timeout.
 * The timeout outcome itself is tested with an explicit timeout.
 */
function generous(inner: CommandRunner): { runner: CommandRunner; timeouts: number[] } {
  const timeouts: number[] = [];
  return {
    timeouts,
    runner: (file, args, options) => {
      timeouts.push(options.timeoutMs);
      return inner(file, args, { ...options, timeoutMs: GH_PROFILE.timeoutMs });
    },
  };
}

beforeAll(async () => {
  stubs = await createToolStubs(['gh']);
  await stubs.warm();
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'diffcity-gh-runner-')));
  await mkdir(join(scratch, 'empty-bin'));
  repo = await createRepo({ initialBranch: 'trunk', files: { 'lib/ledger.ts': 'export const total = 1;\n' } });
  const wrapped = generous(ghRunner());
  runner = wrapped.runner;
  calls = wrapped.timeouts;
}, 120_000);

afterAll(async () => {
  await stubs.cleanup();
  await repo.cleanup();
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  await stubs.clear();
  calls.length = 0;
});

describe('gh adapter', () => {
  it('runs gh with the argv of a gh builder and hands back its JSON', async () => {
    await stubs.mode('json', { stdout: JSON.stringify([PR]) });
    const stdout = await runner('gh', ghPrList().argv, { cwd: repo.dir, timeoutMs: 10_000 });
    expect(JSON.parse(stdout)).toEqual([PR]);
    const [record] = await stubs.records();
    expect(record?.argv).toEqual(ghPrList().argv);
    expect(record?.cwd).toBe(await realpath(repo.dir));
  });

  it('refuses anything but gh, and any argv no gh builder makes, before starting a process', async () => {
    await stubs.mode('json', { stdout: '{}' });
    await expect(runner('git', ['status'], { cwd: repo.dir, timeoutMs: 1000 })).rejects.toBeInstanceOf(ToolCallError);
    for (const argv of [['api', '/user'], ['auth', 'token'], ['pr', 'view', '7; id', '--json', 'state'], ['pr', 'list', '--repo', 'elsewhere/x']]) {
      await expect(runner('gh', argv, { cwd: repo.dir, timeoutMs: 1000 }), argv.join(' ')).rejects.toMatchObject({ kind: 'error' });
    }
    expect(await stubs.records()).toEqual([]);
  });

  it('rejects like execFile did: ENOENT when gh is missing, killed on a timeout', async () => {
    const missing = ghRunner({ env: { PATH: join(scratch, 'empty-bin') } });
    await expect(missing('gh', ghPrList().argv, { cwd: repo.dir, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'ENOENT', kind: 'missing' });

    await stubs.mode('sleep');
    await expect(ghRunner({ killGraceMs: 200 })('gh', ghPrList().argv, { cwd: repo.dir, timeoutMs: 3000 })).rejects.toMatchObject({ killed: true, kind: 'timeout' });
  });

  it('a PR list that is not an array is unexpected output, not an empty list', async () => {
    await stubs.mode('json', { stdout: '{"number":7}' });
    await expect(runner('gh', ghPrList().argv, { cwd: repo.dir, timeoutMs: 10_000 })).rejects.toMatchObject({ kind: 'error' });
  });
});

describe('gh/behaviour-unchanged-on-collector-fixtures', () => {
  it('fetchOpenPrs: ok with the PRs, else missing, failed or timeout as before', async () => {
    await stubs.mode('json', { stdout: JSON.stringify([PR, { ...PR, number: 0 }]) });
    expect(await fetchOpenPrs(repo.dir, runner)).toEqual({ ok: true, prs: [PR] });
    expect(calls).toEqual([GH_PR_TIMEOUT_MS]);

    await stubs.mode('fail', { stderr: 'no git remotes found\n' });
    expect(await fetchOpenPrs(repo.dir, runner)).toEqual({ ok: false, reason: 'failed' });

    await stubs.mode('fail', { stderr: 'error connecting to api.github.com\n' });
    expect(await fetchOpenPrs(repo.dir, runner)).toEqual({ ok: false, reason: 'failed' });

    await stubs.mode('json', { stdout: 'not json' });
    expect(await fetchOpenPrs(repo.dir, runner)).toEqual({ ok: false, reason: 'failed' });

    expect(await fetchOpenPrs(repo.dir, ghRunner({ env: { PATH: join(scratch, 'empty-bin') } }))).toEqual({ ok: false, reason: 'missing' });

    await stubs.mode('sleep');
    const quick: CommandRunner = (file, args, options) => ghRunner({ killGraceMs: 200 })(file, args, { ...options, timeoutMs: 3000 });
    expect(await fetchOpenPrs(repo.dir, quick)).toEqual({ ok: false, reason: 'timeout' });
  });

  it('prState: the confirmed state, else null', async () => {
    await stubs.mode('json', { stdout: '{"state":"MERGED"}' });
    expect(await prState(repo.dir, 7, runner)).toBe('MERGED');
    expect(calls).toEqual([GH_PR_TIMEOUT_MS]);
    expect((await stubs.records()).at(-1)?.argv).toEqual(['pr', 'view', '7', '--json', 'state']);

    await stubs.mode('json', { stdout: '{"state":"DRAFTED"}' });
    expect(await prState(repo.dir, 7, runner)).toBeNull();

    await stubs.mode('fail');
    expect(await prState(repo.dir, 7, runner)).toBeNull();

    // An invalid PR number never reaches gh.
    await stubs.clear();
    expect(await prState(repo.dir, -1, runner)).toBeNull();
    expect(await stubs.records()).toEqual([]);
  });

  it('base detection: the default branch from gh repo view, and no base when gh fails', async () => {
    await stubs.mode('json', { stdout: '{"defaultBranchRef":{"name":"trunk"}}' });
    expect(await resolveBase(repo.dir, { runner })).toMatchObject({ name: 'trunk', ref: 'refs/heads/trunk', source: 'gh' });
    expect(calls).toEqual([GH_TIMEOUT_MS]);
    expect((await stubs.records()).at(-1)?.argv).toEqual(['repo', 'view', '--json', 'defaultBranchRef']);

    await stubs.mode('fail', { stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
    await expect(resolveBase(repo.dir, { runner })).rejects.toMatchObject({ code: 'no-base' });
  });
});
