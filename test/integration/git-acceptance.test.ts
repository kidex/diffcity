// Acceptance checks for the git layer (ADR-012, spec-rules L5) that complement
// git-base.test.ts and git-change.test.ts.

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../../src/core/config/index.js';
import { changedFiles, computeMeta, resolveBase, resolveChange } from '../../src/core/git/index.js';
import { ghForbidden, isolateGitConfig } from '../helpers/git-env.js';
import { createRepo, type CreateRepoOptions, type TempRepo } from '../helpers/repo.js';

isolateGitConfig();

const repos: TempRepo[] = [];
const dirs: string[] = [];

async function repoOn(options: CreateRepoOptions): Promise<TempRepo> {
  const repo = await createRepo(options);
  repos.push(repo);
  return repo;
}

afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const noGh = { runner: ghForbidden().runner };

const body = Array.from({ length: 20 }, (_, i) => `export const v${String(i)} = ${String(i)};\n`).join('');

describe('L5 base detection order (ADR-012)', { timeout: 60_000 }, () => {
  it('L5 base-origin-only: local main beats a diverging origin/main', async () => {
    const repo = await repoOn({ files: { 'lib/orders.ts': 'export const n = 1;\n' } });
    const originSha = await repo.git('rev-parse', 'main');
    await repo.git('update-ref', 'refs/remotes/origin/main', originSha);
    const localSha = await repo.commit('local main moves', { 'lib/orders.ts': 'export const n = 2;\n' });
    const base = await resolveBase(repo.dir, noGh);
    expect(base).toMatchObject({ name: 'main', ref: 'refs/heads/main', commit: localSha, source: 'main' });
  });

  it('L5 base-origin-only: origin/master is used when there is no main anywhere and no local master', async () => {
    const repo = await repoOn({ initialBranch: 'master', files: { 'lib/orders.ts': 'x\n' } });
    const sha = await repo.git('rev-parse', 'master');
    await repo.git('update-ref', 'refs/remotes/origin/master', sha);
    await repo.branch('feature/orders');
    await repo.git('branch', '-D', 'master');
    const base = await resolveBase(repo.dir, noGh);
    expect(base).toMatchObject({ name: 'master', ref: 'refs/remotes/origin/master', commit: sha, source: 'master' });
  });

  it('L5 base-flag-override: --base never falls through to gh, even without main or master', async () => {
    const repo = await repoOn({ initialBranch: 'trunk', files: { 'a.ts': 'a\n' } });
    const gh = ghForbidden();
    expect(await resolveBase(repo.dir, { flag: 'trunk', runner: gh.runner })).toMatchObject({ source: 'flag' });
    expect(gh.calls).toHaveLength(0);
  });
});

describe('config end to end (ADR-012)', { timeout: 60_000 }, () => {
  it('base-config-override: base from diffcity.config.js drives before and meta.base', async () => {
    const repo = await repoOn({ files: { 'a.ts': 'a\n' } });
    await repo.branch('develop');
    const developTip = await repo.commit('develop moves', { 'b.ts': 'b\n' });
    await repo.branch('feature/pricing');
    await repo.commit('pricing', { 'c.ts': 'c\n' });
    await writeFile(join(repo.dir, 'diffcity.config.js'), "export default { base: 'develop' };\n", 'utf8');
    await repo.git('add', 'diffcity.config.js');
    await repo.git('commit', '-q', '-m', 'config');

    const config = await loadConfig(repo.dir, { trusted: true });
    const change = await resolveChange(repo.dir, { config, ...noGh });
    expect(change.base).toMatchObject({ name: 'develop', source: 'config' });
    expect(change.mergeBase).toBe(developTip);
    expect((await changedFiles(change)).map((f) => f.path)).toEqual(['c.ts', 'diffcity.config.js']);
    expect(await computeMeta(change)).toMatchObject({ base: 'develop', head: 'feature/pricing', commits: 2 });
  });

  it('config-invalid-field: a misspelled field is named in the error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'diffcity-config-'));
    dirs.push(dir);
    await writeFile(join(dir, 'diffcity.config.js'), "export default { bsae: 'main' };\n", 'utf8');
    const error: unknown = await loadConfig(dir, { trusted: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).field).toBe('bsae');
    expect((error as ConfigError).message).toContain('"bsae"');
  });
});

describe('user git config cannot change the result', { timeout: 60_000 }, () => {
  it('rename-detected: hostile diff settings in the global config are overridden', async () => {
    const home = await mkdtemp(join(tmpdir(), 'diffcity-gitcfg-'));
    dirs.push(home);
    const globalConfig = join(home, 'gitconfig');
    await writeFile(
      globalConfig,
      [
        '[diff]',
        '\trenames = false',
        '\trelative = true',
        '\tnoprefix = true',
        '\texternal = false',
        '[color]',
        '\tui = always',
        '[status]',
        '\tshowUntrackedFiles = no',
        '[core]',
        '\tquotePath = true',
        '',
      ].join('\n'),
      'utf8',
    );
    const repo = await repoOn({ files: { 'lib/source.ts': body } });
    await repo.branch('feature/move');
    await repo.commit('move', { 'lib/source.ts': null, 'lib/target.ts': body });
    await repo.write({ 'lib/fresh ü.ts': 'export const f = 1;\n' });

    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    const inSubdir = await resolveChange(join(repo.dir, 'lib'), noGh);
    expect(await changedFiles(inSubdir)).toEqual([
      { path: 'lib/fresh ü.ts', oldPath: null, type: 'add', binary: false },
      { path: 'lib/target.ts', oldPath: 'lib/source.ts', type: 'rename', binary: false },
    ]);
    const atHead = await resolveChange(repo.dir, { head: 'feature/move', ...noGh });
    expect(await changedFiles(atHead)).toEqual([
      { path: 'lib/target.ts', oldPath: 'lib/source.ts', type: 'rename', binary: false },
    ]);
  });
});

describe('process execution (ADR-012)', () => {
  it('src/core spawns processes only through execFile, never a shell', async () => {
    const root = new URL('../../src/core/', import.meta.url);
    const entries = await readdir(root, { recursive: true });
    const sources = entries.filter((entry) => entry.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = await readFile(new URL(file, root), 'utf8');
      expect(text, file).not.toMatch(/(?<![.\w])(exec|execSync|spawn|spawnSync|execFileSync|fork)\s*\(/);
      expect(text, file).not.toMatch(/shell\s*:/);
      if (text.includes('node:child_process')) {
        expect(text, file).toMatch(/import \{ execFile \} from 'node:child_process'/);
      }
    }
  });
});
