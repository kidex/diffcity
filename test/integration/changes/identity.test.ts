import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { BARE_REPO_MESSAGE, identifyRepo } from '../../../src/core/changes/identity.js';
import { GitError } from '../../../src/core/git/index.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const execFileAsync = promisify(execFile);
const repos: TempRepo[] = [];
const dirs: string[] = [];

async function sampleShop(): Promise<TempRepo> {
  const repo = await createRepo({ name: 'sample-shop', files: { 'src/cart.ts': 'export const items = [];\n' } });
  repos.push(repo);
  return repo;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'diffcity-ident-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
  while (dirs.length > 0) await rm(dirs.pop() ?? '', { recursive: true, force: true });
});

describe('identifyRepo (ADR-019)', () => {
  it('identifies the repo from its root', async () => {
    const repo = await sampleShop();
    const path = await realpath(repo.dir);
    expect(await identifyRepo(repo.dir)).toEqual({
      gitCommonDir: join(path, '.git'),
      path,
      name: 'sample-shop',
    });
  });

  it('identifies the same repo from a subfolder', async () => {
    const repo = await sampleShop();
    expect(await identifyRepo(join(repo.dir, 'src'))).toEqual(await identifyRepo(repo.dir));
  });

  it('changes/linked-worktree-same-repo: a linked worktree is the same repo, with the main working tree as path', async () => {
    const repo = await sampleShop();
    const linked = join(await tempDir(), 'sample-shop-agent');
    await repo.git('worktree', 'add', '--quiet', '-b', 'agent/cart', linked);
    const fromLinked = await identifyRepo(linked);
    expect(fromLinked).toEqual(await identifyRepo(repo.dir));
    expect(fromLinked.path).toBe(await realpath(repo.dir));
  });

  it('changes/bare-repo-refused: a bare repo is refused with a clear error', async () => {
    const dir = await tempDir();
    await execFileAsync('git', ['init', '--quiet', '--bare', join(dir, 'order-service.git')]);
    const error = await identifyRepo(join(dir, 'order-service.git')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toBe(BARE_REPO_MESSAGE);
    expect(BARE_REPO_MESSAGE).toBe('bare repositories are not supported');
  });

  it('refuses a directory outside any repo with the not-a-repo message', async () => {
    const dir = join(await tempDir(), 'plain');
    await mkdir(dir);
    const error = await identifyRepo(dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe('not-a-repo');
    expect((error as GitError).message).toBe(`not a git repository: ${dir}`);
    expect(basename(dir)).toBe('plain');
  });
});
