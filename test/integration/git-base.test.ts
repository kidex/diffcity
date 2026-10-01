import { afterEach, describe, expect, it } from 'vitest';
import { GitError, NO_BASE_MESSAGE, defaultRunner, resolveBase } from '../../src/core/git/index.js';
import { fakeRunner, ghForbidden, ghMissing, isolateGitConfig } from '../helpers/git-env.js';
import { createRepo, type CreateRepoOptions, type TempRepo } from '../helpers/repo.js';

isolateGitConfig();

const repos: TempRepo[] = [];

async function repoOn(options: CreateRepoOptions): Promise<TempRepo> {
  const repo = await createRepo(options);
  repos.push(repo);
  return repo;
}

/** A repo whose initial branch is `initial`, with a `feature/ledger` branch one commit ahead, checked out. */
async function featureRepo(initial: string): Promise<TempRepo> {
  const repo = await repoOn({ initialBranch: initial, files: { 'lib/ledger.ts': 'export const total = 1;\n' } });
  await repo.branch('feature/ledger');
  await repo.commit('ledger total', { 'lib/ledger.ts': 'export const total = 2;\n' });
  return repo;
}

afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

// Each test spawns a dozen git processes; inside vitest workers a spawn costs ~70 ms.
describe('resolveBase (ADR-012)', { timeout: 60_000 }, () => {
  it('base-main: picks refs/heads/main without calling gh', async () => {
    const repo = await featureRepo('main');
    const gh = ghForbidden();
    const base = await resolveBase(repo.dir, { runner: gh.runner });
    expect(base).toMatchObject({ name: 'main', ref: 'refs/heads/main', source: 'main' });
    expect(base.commit).toBe(await repo.git('rev-parse', 'main'));
    expect(gh.calls).toHaveLength(0);
  });

  it('base-master: picks master when there is no main', async () => {
    const repo = await featureRepo('master');
    const gh = ghForbidden();
    expect(await resolveBase(repo.dir, { runner: gh.runner })).toMatchObject({
      name: 'master',
      ref: 'refs/heads/master',
      source: 'master',
    });
    expect(gh.calls).toHaveLength(0);
  });

  it('base-master: main wins when both main and master exist', async () => {
    const repo = await featureRepo('master');
    await repo.git('branch', 'main', 'master');
    expect((await resolveBase(repo.dir, { runner: ghForbidden().runner })).name).toBe('main');
  });

  it('base-origin-only: falls back to refs/remotes/origin/main when there is no local main', async () => {
    const repo = await featureRepo('main');
    const mainSha = await repo.git('rev-parse', 'main');
    await repo.git('update-ref', 'refs/remotes/origin/main', mainSha);
    await repo.git('branch', '-D', 'main');
    const base = await resolveBase(repo.dir, { runner: ghForbidden().runner });
    expect(base).toMatchObject({ name: 'main', ref: 'refs/remotes/origin/main', source: 'main', commit: mainSha });
  });

  it('base-origin-only: a local master beats origin/main (main then master, each local then origin)', async () => {
    const repo = await featureRepo('master');
    await repo.git('update-ref', 'refs/remotes/origin/main', await repo.git('rev-parse', 'master'));
    // main: no local, but origin/main exists -> main wins before master is considered.
    expect((await resolveBase(repo.dir, { runner: ghForbidden().runner })).ref).toBe('refs/remotes/origin/main');
  });

  it('base-gh-default: asks gh for the default branch with a 5 s timeout', async () => {
    const repo = await featureRepo('trunk');
    const gh = fakeRunner(() => '{"defaultBranchRef":{"name":"trunk"}}\n');
    const base = await resolveBase(repo.dir, { runner: gh.runner });
    expect(base).toMatchObject({ name: 'trunk', ref: 'refs/heads/trunk', source: 'gh' });
    expect(gh.calls).toEqual([
      { file: 'gh', args: ['repo', 'view', '--json', 'defaultBranchRef'], cwd: repo.dir, timeoutMs: 5000 },
    ]);
  });

  it('base-gh-default: the gh default branch may exist only on origin', async () => {
    const repo = await featureRepo('trunk');
    await repo.git('update-ref', 'refs/remotes/origin/trunk', await repo.git('rev-parse', 'trunk'));
    await repo.git('branch', '-D', 'trunk');
    const gh = fakeRunner(() => '{"defaultBranchRef":{"name":"trunk"}}');
    expect(await resolveBase(repo.dir, { runner: gh.runner })).toMatchObject({
      name: 'trunk',
      ref: 'refs/remotes/origin/trunk',
    });
  });

  it('base-config-override: base from config wins over main', async () => {
    const repo = await featureRepo('main');
    await repo.git('branch', 'develop', 'main');
    const base = await resolveBase(repo.dir, { config: 'develop', runner: ghForbidden().runner });
    expect(base).toMatchObject({ name: 'develop', ref: 'develop', source: 'config' });
  });

  it('base-flag-override: --base wins over config and main', async () => {
    const repo = await featureRepo('main');
    await repo.git('branch', 'develop', 'main');
    await repo.git('branch', 'release', 'main');
    const base = await resolveBase(repo.dir, { flag: 'release', config: 'develop', runner: ghForbidden().runner });
    expect(base).toMatchObject({ name: 'release', ref: 'release', source: 'flag' });
  });

  it('base-flag-override: accepts any commit-ish, e.g. a sha', async () => {
    const repo = await featureRepo('main');
    const sha = await repo.git('rev-parse', 'main');
    expect(await resolveBase(repo.dir, { flag: sha, runner: ghForbidden().runner })).toMatchObject({
      name: sha,
      commit: sha,
      source: 'flag',
    });
  });

  it('base-flag-override: an explicit base that does not exist is an error, not a fallback', async () => {
    const repo = await featureRepo('main');
    await expect(resolveBase(repo.dir, { flag: 'nowhere', runner: ghForbidden().runner })).rejects.toThrow(
      'base ref not found: nowhere',
    );
    await expect(resolveBase(repo.dir, { config: 'nowhere', runner: ghForbidden().runner })).rejects.toThrow(
      'base ref not found: nowhere',
    );
  });

  it('base-flag-override: refuses a ref that looks like an option', async () => {
    const repo = await featureRepo('main');
    await expect(resolveBase(repo.dir, { flag: '--output=x', runner: ghForbidden().runner })).rejects.toBeInstanceOf(
      GitError,
    );
  });

  describe('base-missing', () => {
    it('gives the ADR-012 message when gh is not installed', async () => {
      const repo = await featureRepo('trunk');
      const gh = ghMissing();
      await expect(resolveBase(repo.dir, { runner: gh.runner })).rejects.toThrow(NO_BASE_MESSAGE);
      expect(NO_BASE_MESSAGE).toBe('no base branch found; pass --base or set base in diffcity.config.js');
      expect(gh.calls).toHaveLength(1);
    });

    it('gives the same message when gh fails, times out or answers garbage', async () => {
      const repo = await featureRepo('trunk');
      for (const answer of ['not json', '{}', '{"defaultBranchRef":null}', '{"defaultBranchRef":{"name":""}}']) {
        await expect(resolveBase(repo.dir, { runner: fakeRunner(() => answer).runner })).rejects.toThrow(
          NO_BASE_MESSAGE,
        );
      }
      const timedOut = fakeRunner(() => {
        throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
      });
      await expect(resolveBase(repo.dir, { runner: timedOut.runner })).rejects.toThrow(NO_BASE_MESSAGE);
    });

    it('gives the same message when gh names a branch that is not in the repo', async () => {
      const repo = await featureRepo('trunk');
      const gh = fakeRunner(() => '{"defaultBranchRef":{"name":"develop"}}');
      const error: unknown = await resolveBase(repo.dir, { runner: gh.runner }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).code).toBe('no-base');
      expect((error as GitError).message).toBe(NO_BASE_MESSAGE);
    });
  });
});

describe('defaultRunner', () => {
  it('kills a command that exceeds its timeout', async () => {
    const started = Date.now();
    await expect(
      defaultRunner(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { cwd: process.cwd(), timeoutMs: 100 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('returns stdout of a successful command', async () => {
    expect(
      await defaultRunner(process.execPath, ['-e', 'process.stdout.write("ok")'], { cwd: process.cwd(), timeoutMs: 30_000 }),
    ).toBe('ok');
  });

  it('rejects when the command is not installed', async () => {
    await expect(
      defaultRunner('diffcity-no-such-command', [], { cwd: process.cwd(), timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
