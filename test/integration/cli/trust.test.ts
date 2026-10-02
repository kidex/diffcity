// `diffcity trust [<dir>]`, `--list` and `--remove` (ADR-030, DC-53): the repo
// root's realpath goes into settings.json in a temporary DIFFCITY_HOME.

import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTrust, type TrustCommandOptions } from '../../../src/cli/trust.js';
import { homePaths } from '../../../src/core/home.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

let temp: TempHome;
let settingsFile: string;
const repos: TempRepo[] = [];

beforeEach(async () => {
  temp = await tempHome();
  settingsFile = homePaths(temp.home).settings;
});
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
  await temp.cleanup();
});

async function repoNamed(name: string): Promise<{ repo: TempRepo; root: string }> {
  const repo = await createRepo({ name, files: { 'src/index.ts': 'export const one = 1;\n' } });
  repos.push(repo);
  return { repo, root: await realpath(repo.dir) };
}

async function trust(dir: string | undefined, options: TrustCommandOptions = {}, cwd = temp.root) {
  const out = { stdout: '', stderr: '' };
  const code = await runTrust(dir, options, {
    io: { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    env: temp.env,
    cwd,
  });
  return { code, ...out };
}

async function trustedRepos(): Promise<unknown> {
  return (JSON.parse(await readFile(settingsFile, 'utf8')) as { trustedRepos: unknown }).trustedRepos;
}

describe('diffcity trust', () => {
  it('cli/trust-adds-root: trusts the repo root of a subdirectory, by realpath, once', async () => {
    const { repo, root } = await repoNamed('sample-shop');
    const first = await trust(join(repo.dir, 'src'));
    expect(first).toEqual({ code: 0, stdout: `trusted ${root}\n`, stderr: '' });
    expect(await trustedRepos()).toEqual([root]);
    expect((await stat(settingsFile)).mode & 0o777).toBe(0o600);

    const again = await trust(undefined, {}, repo.dir);
    expect(again).toEqual({ code: 0, stdout: `already trusted ${root}\n`, stderr: '' });
    expect(await trustedRepos()).toEqual([root]);
  });

  it('cli/trust-symlink: a path through a symlink stores the realpath', async () => {
    const { repo, root } = await repoNamed('sample-shop');
    const link = join(temp.root, 'shop-link');
    await symlink(repo.dir, link);
    expect((await trust(link)).code).toBe(0);
    expect(await trustedRepos()).toEqual([root]);
  });

  it('cli/trust-not-a-repo: a directory outside any repo is an error with exit 1', async () => {
    const plain = join(temp.root, 'plain');
    await mkdir(plain);
    const result = await trust(plain);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`diffcity trust: not a git repository: ${plain}\n`);
  });

  it('cli/trust-list: prints the trusted repos, one per line', async () => {
    expect(await trust(undefined, { list: true })).toEqual({ code: 0, stdout: 'no trusted repos\n', stderr: '' });
    const shop = await repoNamed('sample-shop');
    const blog = await repoNamed('sample-blog');
    await trust(shop.repo.dir);
    await trust(blog.repo.dir);
    expect(await trust(undefined, { list: true })).toEqual({ code: 0, stdout: `${shop.root}\n${blog.root}\n`, stderr: '' });
  });

  it('cli/trust-remove: removes one repo and leaves the others', async () => {
    const shop = await repoNamed('sample-shop');
    const blog = await repoNamed('sample-blog');
    await trust(shop.repo.dir);
    await trust(blog.repo.dir);
    expect(await trust(shop.repo.dir, { remove: true })).toEqual({ code: 0, stdout: `removed ${shop.root}\n`, stderr: '' });
    expect(await trustedRepos()).toEqual([blog.root]);
    expect(await trust(undefined, { remove: true }, shop.repo.dir)).toEqual({
      code: 0,
      stdout: `not trusted ${shop.root}\n`,
      stderr: '',
    });
  });

  it('cli/trust-remove-gone: removes a listed directory that is no longer a repo', async () => {
    const plain = await realpath(temp.root);
    await mkdir(temp.home, { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ v: 1, trustedRepos: [plain] }));
    expect(await trust(plain, { remove: true })).toEqual({ code: 0, stdout: `removed ${plain}\n`, stderr: '' });
    expect(await trustedRepos()).toEqual([]);
  });

  it('cli/trust-remove-not-a-repo: an unlisted directory outside any repo is an error with exit 1', async () => {
    const plain = join(temp.root, 'plain');
    await mkdir(plain);
    const result = await trust(plain, { remove: true });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`diffcity trust: not a git repository: ${plain}\n`);
  });

  it('cli/trust-invalid-settings: reports the file and leaves it untouched', async () => {
    const { repo } = await repoNamed('sample-shop');
    await mkdir(temp.home, { recursive: true });
    await writeFile(settingsFile, '{"v":1,"trustedRepos":"oops"}');
    for (const options of [{}, { list: true }, { remove: true }]) {
      const result = await trust(options.list === true ? undefined : repo.dir, options);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(settingsFile);
      expect(result.stderr).toContain('"trustedRepos"');
    }
    expect(await readFile(settingsFile, 'utf8')).toBe('{"v":1,"trustedRepos":"oops"}');
  });

  it('cli/trust-flags: --list takes no directory and excludes --remove', async () => {
    expect(await trust('somewhere', { list: true })).toEqual({ code: 1, stdout: '', stderr: 'diffcity trust: --list takes no directory\n' });
    expect(await trust(undefined, { list: true, remove: true })).toEqual({
      code: 1,
      stdout: '',
      stderr: 'diffcity trust: --list and --remove cannot be used together\n',
    });
  });
});
