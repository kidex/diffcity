import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitError,
  changedFiles,
  computeMeta,
  findRepoRoot,
  listHeadFiles,
  readAfter,
  readBefore,
  resolveChange,
} from '../../src/core/git/index.js';
import { ghForbidden, isolateGitConfig } from '../helpers/git-env.js';
import { createRepo, type CreateRepoOptions, type TempRepo } from '../helpers/repo.js';

isolateGitConfig();

const execFileAsync = promisify(execFile);

async function fingerprint(file: string): Promise<{ sha: string; mtimeMs: number }> {
  const sha = createHash('sha256').update(await readFile(file)).digest('hex');
  return { sha, mtimeMs: (await stat(file)).mtimeMs };
}

async function listObjects(repoDir: string): Promise<string[]> {
  return (await readdir(join(repoDir, '.git', 'objects'), { recursive: true })).sort();
}

const repos: TempRepo[] = [];
const dirs: string[] = [];

async function repoOn(options: CreateRepoOptions): Promise<TempRepo> {
  const repo = await createRepo(options);
  repos.push(repo);
  return repo;
}

const noGh = { runner: ghForbidden().runner };

afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

// Each test spawns a few dozen git processes; inside vitest workers a spawn costs ~70 ms.
describe('resolveChange and changedFiles (ADR-012)', { timeout: 30_000 }, () => {
  it('merge-base-not-tip: before is merge-base(base, head), not the base tip', async () => {
    const repo = await repoOn({
      files: { 'lib/ledger.ts': 'export const total = 1;\n', 'lib/rates.ts': 'export const rate = 1;\n' },
    });
    const forkPoint = await repo.head();
    await repo.branch('feature/ledger');
    await repo.commit('ledger 2', { 'lib/ledger.ts': 'export const total = 2;\n' });
    await repo.commit('ledger 3', { 'lib/ledger.ts': 'export const total = 3;\n' });
    await repo.checkout('main');
    const mainTip = await repo.commit('rates moved on', { 'lib/rates.ts': 'export const rate = 9;\n' });
    await repo.checkout('feature/ledger');

    const change = await resolveChange(repo.dir, noGh);
    expect(change.mergeBase).toBe(forkPoint);
    expect(change.mergeBase).not.toBe(mainTip);
    expect(change.base).toMatchObject({ name: 'main', commit: mainTip });
    expect(change.worktree).toBe(true);

    // Only the branch's own change; the base's later edit to rates.ts is not part of it.
    expect(await changedFiles(change)).toEqual([
      { path: 'lib/ledger.ts', oldPath: 'lib/ledger.ts', type: 'mod', binary: false },
    ]);
    expect(await readBefore(change, 'lib/ledger.ts')).toBe('export const total = 1;\n');
    expect(await readBefore(change, 'lib/rates.ts')).toBe('export const rate = 1;\n');
    expect(await readAfter(change, 'lib/ledger.ts')).toBe('export const total = 3;\n');

    const meta = await computeMeta(change, new Date('2026-03-04T05:06:07.000Z'));
    expect(meta).toEqual({
      repo: basename(repo.dir),
      base: 'main',
      head: 'feature/ledger',
      commits: 2,
      generatedAt: '2026-03-04T05:06:07.000Z',
    });
  });

  it('worktree-dirty-untracked: after = HEAD + staged + unstaged + non-ignored untracked', async () => {
    const repo = await repoOn({
      files: {
        '.gitignore': 'build/\n*.log\n',
        'lib/ledger.ts': 'export const total = 1;\n',
        'lib/rates.ts': 'export const rate = 1;\n',
        'lib/legacy.ts': 'export const old = 1;\n',
        'README.md': 'Sample\n',
      },
    });
    await repo.branch('feature/dirty');
    await repo.commit('committed edit', { 'lib/ledger.ts': 'export const total = 2;\n' });
    // staged
    await repo.write({ 'lib/staged.ts': 'export const staged = 1;\n' });
    await repo.git('add', 'lib/staged.ts');
    // unstaged edit and unstaged delete
    await repo.write({ 'lib/rates.ts': 'export const rate = 2;\n', 'lib/legacy.ts': null });
    // untracked, plus ignored files that must not appear
    await repo.write({
      'lib/fresh file.ts': 'export const fresh = 1;\n',
      'build/out.js': 'ignored\n',
      'debug.log': 'ignored\n',
    });

    const change = await resolveChange(repo.dir, noGh);
    expect(change.worktree).toBe(true);
    expect(await changedFiles(change)).toEqual([
      { path: 'lib/fresh file.ts', oldPath: null, type: 'add', binary: false },
      { path: 'lib/ledger.ts', oldPath: 'lib/ledger.ts', type: 'mod', binary: false },
      { path: 'lib/legacy.ts', oldPath: 'lib/legacy.ts', type: 'del', binary: false },
      { path: 'lib/rates.ts', oldPath: 'lib/rates.ts', type: 'mod', binary: false },
      { path: 'lib/staged.ts', oldPath: null, type: 'add', binary: false },
    ]);

    expect(await readAfter(change, 'lib/rates.ts')).toBe('export const rate = 2;\n');
    expect(await readAfter(change, 'lib/fresh file.ts')).toBe('export const fresh = 1;\n');
    expect(await readAfter(change, 'lib/legacy.ts')).toBeNull();
    expect(await readBefore(change, 'lib/legacy.ts')).toBe('export const old = 1;\n');
    expect(await readBefore(change, 'lib/fresh file.ts')).toBeNull();

    expect(await listHeadFiles(change)).toEqual([
      '.gitignore',
      'README.md',
      'lib/fresh file.ts',
      'lib/ledger.ts',
      'lib/rates.ts',
      'lib/staged.ts',
    ]);
    expect((await computeMeta(change)).commits).toBe(1);
  });

  it('worktree-dirty-untracked: flags binary files, tracked and untracked', async () => {
    const repo = await repoOn({ files: { 'assets/logo.bin': 'a\0b\0c', 'notes.txt': 'plain\n' } });
    await repo.branch('feature/assets');
    await repo.commit('edit logo', { 'assets/logo.bin': 'a\0b\0d' });
    await repo.write({ 'assets/icon.bin': 'x\0y', 'notes.txt': 'still plain\n' });
    const change = await resolveChange(repo.dir, noGh);
    expect(await changedFiles(change)).toEqual([
      { path: 'assets/icon.bin', oldPath: null, type: 'add', binary: true },
      { path: 'assets/logo.bin', oldPath: 'assets/logo.bin', type: 'mod', binary: true },
      { path: 'notes.txt', oldPath: 'notes.txt', type: 'mod', binary: false },
    ]);
  });

  it('worktree-dirty-untracked: odd untracked entries never break the list', async () => {
    const repo = await repoOn({ files: { 'lib/a.ts': 'x\n' } });
    await mkdir(join(repo.dir, 'lib', 'dir'));
    await writeFile(join(repo.dir, 'lib', 'dir', 'inner.ts'), 'y\n', 'utf8');
    await symlink('does-not-exist.ts', join(repo.dir, 'lib', 'dangling.ts'));
    await symlink('dir', join(repo.dir, 'lib', 'dir-link'));
    await execFileAsync('mkfifo', [join(repo.dir, 'lib', 'pipe')]);
    // A nested repository is not a file of this change.
    await execFileAsync('git', ['init', '--quiet', join(repo.dir, 'vendor', 'nested')]);
    await writeFile(join(repo.dir, 'vendor', 'nested', 'n.ts'), 'n\n', 'utf8');

    const change = await resolveChange(repo.dir, noGh);
    expect(await changedFiles(change)).toEqual([
      { path: 'lib/dangling.ts', oldPath: null, type: 'add', binary: false },
      { path: 'lib/dir-link', oldPath: null, type: 'add', binary: false },
      { path: 'lib/dir/inner.ts', oldPath: null, type: 'add', binary: false },
    ]);
    expect(await readAfter(change, 'lib/dangling.ts')).toBe('does-not-exist.ts');
    expect(await readAfter(change, 'lib/pipe')).toBeNull();
    expect(await listHeadFiles(change)).toEqual(['lib/a.ts', 'lib/dangling.ts', 'lib/dir-link', 'lib/dir/inner.ts']);
  });

  it('head-ref: --head compares against that commit and ignores the working tree', async () => {
    const repo = await repoOn({ files: { 'lib/ledger.ts': 'export const total = 1;\n' } });
    await repo.branch('feature/other');
    const headSha = await repo.commit('ledger 2', {
      'lib/ledger.ts': 'export const total = 2;\n',
      'lib/audit.ts': 'export const audit = 1;\n',
    });
    await repo.checkout('main');
    await repo.write({ 'lib/ledger.ts': 'export const total = 99;\n', 'lib/scratch.ts': 'x\n' });

    const change = await resolveChange(repo.dir, { ...noGh, head: 'feature/other' });
    expect(change.worktree).toBe(false);
    expect(change.headCommit).toBe(headSha);
    expect(await changedFiles(change)).toEqual([
      { path: 'lib/audit.ts', oldPath: null, type: 'add', binary: false },
      { path: 'lib/ledger.ts', oldPath: 'lib/ledger.ts', type: 'mod', binary: false },
    ]);
    expect(await readAfter(change, 'lib/ledger.ts')).toBe('export const total = 2;\n');
    expect(await readAfter(change, 'lib/scratch.ts')).toBeNull();
    expect(await listHeadFiles(change)).toEqual(['lib/audit.ts', 'lib/ledger.ts']);
    expect(await computeMeta(change)).toMatchObject({ base: 'main', head: 'feature/other', commits: 1 });
  });

  it('head-ref: --head accepts a sha and keeps the value as given in meta.head', async () => {
    const repo = await repoOn({ files: { 'a.ts': 'export const a = 1;\n' } });
    await repo.branch('feature/a');
    const sha = await repo.commit('a 2', { 'a.ts': 'export const a = 2;\n' });
    const change = await resolveChange(repo.dir, { ...noGh, head: sha.slice(0, 10) });
    expect(change.headCommit).toBe(sha);
    expect((await computeMeta(change)).head).toBe(sha.slice(0, 10));
  });

  it('head-ref: an unknown --head is an error', async () => {
    const repo = await repoOn({ files: { 'a.ts': 'x\n' } });
    await expect(resolveChange(repo.dir, { ...noGh, head: 'nowhere' })).rejects.toThrow('head ref not found: nowhere');
  });

  it('on-base-dirty: on the base branch only the uncommitted changes count', async () => {
    const repo = await repoOn({ files: { 'lib/ledger.ts': 'export const total = 1;\n' } });
    await repo.commit('second', { 'lib/rates.ts': 'export const rate = 1;\n' });
    await repo.write({ 'lib/ledger.ts': 'export const total = 5;\n' });

    const change = await resolveChange(repo.dir, noGh);
    expect(change.mergeBase).toBe(await repo.head());
    expect(await changedFiles(change)).toEqual([
      { path: 'lib/ledger.ts', oldPath: 'lib/ledger.ts', type: 'mod', binary: false },
    ]);
    expect(await computeMeta(change)).toMatchObject({ base: 'main', head: 'main', commits: 0 });
  });

  it('on-base-dirty: a clean base branch has no changed files', async () => {
    const repo = await repoOn({ files: { 'a.ts': 'x\n' } });
    expect(await changedFiles(await resolveChange(repo.dir, noGh))).toEqual([]);
  });

  it('rename-detected: a committed rename with an edit is one rename entry', async () => {
    const body = Array.from({ length: 20 }, (_, i) => `export const line${String(i)} = ${String(i)};\n`).join('');
    const repo = await repoOn({ files: { 'lib/old-name.ts': body } });
    await repo.branch('feature/rename');
    await repo.commit('rename', { 'lib/old-name.ts': null, 'lib/new-name.ts': body + 'export const extra = 1;\n' });

    const change = await resolveChange(repo.dir, noGh);
    expect(await changedFiles(change)).toEqual([
      { path: 'lib/new-name.ts', oldPath: 'lib/old-name.ts', type: 'rename', binary: false },
    ]);
    expect(await readBefore(change, 'lib/old-name.ts')).toBe(body);
    expect(await readAfter(change, 'lib/new-name.ts')).toBe(body + 'export const extra = 1;\n');
  });

  it('rename-detected: a staged git mv in the working tree is a rename', async () => {
    const body = Array.from({ length: 20 }, (_, i) => `export const v${String(i)} = ${String(i)};\n`).join('');
    const repo = await repoOn({ files: { 'lib/before.ts': body } });
    await repo.git('mv', 'lib/before.ts', 'lib/after.ts');
    expect(await changedFiles(await resolveChange(repo.dir, noGh))).toEqual([
      { path: 'lib/after.ts', oldPath: 'lib/before.ts', type: 'rename', binary: false },
    ]);
  });

  it('rename-detected: an unstaged plain mv is a rename, and the repo is not written to', async () => {
    const body = Array.from({ length: 20 }, (_, i) => `export const w${String(i)} = ${String(i)};\n`).join('');
    const repo = await repoOn({ files: { 'lib/source.ts': body, 'lib/kept.ts': 'k\n' } });
    const indexFile = join(repo.dir, '.git', 'index');
    const indexBefore = await fingerprint(indexFile);
    const objectsBefore = await listObjects(repo.dir);

    await rename(join(repo.dir, 'lib', 'source.ts'), join(repo.dir, 'lib', 'target.ts'));
    await writeFile(join(repo.dir, 'lib', 'target.ts'), body + 'export const more = 1;\n', 'utf8');
    // Names that would be pathspec magic if git did not read them literally.
    await repo.write({ 'lib/star*.ts': 's\n', 'lib/[ab].ts': 'b\n', ':(glob)odd.ts': 'o\n' });

    const change = await resolveChange(repo.dir, noGh);
    expect(await changedFiles(change)).toEqual([
      { path: ':(glob)odd.ts', oldPath: null, type: 'add', binary: false },
      { path: 'lib/[ab].ts', oldPath: null, type: 'add', binary: false },
      { path: 'lib/star*.ts', oldPath: null, type: 'add', binary: false },
      { path: 'lib/target.ts', oldPath: 'lib/source.ts', type: 'rename', binary: false },
    ]);

    expect(await fingerprint(indexFile)).toEqual(indexBefore);
    expect(await listObjects(repo.dir)).toEqual(objectsBefore);
    expect(await repo.status()).toContain('?? lib/target.ts');
  });

  it('worktree-dirty-untracked: a same-size edit in the same second as the index is still seen', async () => {
    // Only git's racy-entry rule can catch this edit: size and mtime match the
    // index entry and ctime is not trusted. The rule needs the index mtime to be
    // no later than the entry's, which the temp index copy must preserve.
    const repo = await repoOn({ files: { 'seed.txt': 's\n' } });
    await repo.git('config', 'core.trustctime', 'false');
    const second = Math.floor(Date.now() / 1000) - 3600;
    const file = join(repo.dir, 'lib', 'racy.ts');
    await repo.write({ 'lib/racy.ts': 'export const flag = 1;\n' });
    await utimes(file, second, second);
    await repo.commit('racy');
    await repo.write({ 'lib/racy.ts': 'export const flag = 2;\n' });
    await utimes(file, second, second);
    await utimes(join(repo.dir, '.git', 'index'), second, second);
    // An untracked file sends changedFiles through the temp index.
    await repo.write({ 'lib/new.ts': 'export const fresh = 1;\n' });

    expect(await changedFiles(await resolveChange(repo.dir, noGh))).toEqual([
      { path: 'lib/new.ts', oldPath: null, type: 'add', binary: false },
      { path: 'lib/racy.ts', oldPath: 'lib/racy.ts', type: 'mod', binary: false },
    ]);
  });

  it('rename-detected: files below the 50% similarity threshold are add + del', async () => {
    const repo = await repoOn({ files: { 'lib/one.ts': 'export const one = 1;\n' } });
    await repo.branch('feature/replace');
    await repo.commit('replace', { 'lib/one.ts': null, 'lib/two.ts': 'export function two() { return 2; }\n' });
    expect(await changedFiles(await resolveChange(repo.dir, noGh))).toEqual([
      { path: 'lib/one.ts', oldPath: 'lib/one.ts', type: 'del', binary: false },
      { path: 'lib/two.ts', oldPath: null, type: 'add', binary: false },
    ]);
  });

  it('uses base from the config when no --base is given', async () => {
    const repo = await repoOn({ files: { 'a.ts': 'export const a = 1;\n' } });
    await repo.branch('develop');
    await repo.commit('develop moves', { 'a.ts': 'export const a = 2;\n' });
    await repo.branch('feature/x');
    await repo.commit('feature', { 'b.ts': 'export const b = 1;\n' });

    const change = await resolveChange(repo.dir, { ...noGh, config: { base: 'develop' } });
    expect(change.base.name).toBe('develop');
    expect(await changedFiles(change)).toEqual([{ path: 'b.ts', oldPath: null, type: 'add', binary: false }]);
    const flagged = await resolveChange(repo.dir, { ...noGh, base: 'main', config: { base: 'develop' } });
    expect(flagged.base.name).toBe('main');
    expect((await changedFiles(flagged)).map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('works from a subdirectory and reports paths from the repo root', async () => {
    const repo = await repoOn({ files: { 'pkg/core/a.ts': 'x\n' } });
    await repo.write({ 'pkg/core/a.ts': 'y\n', 'top.ts': 'z\n' });
    const change = await resolveChange(join(repo.dir, 'pkg', 'core'), noGh);
    expect(change.root).toBe(await findRepoRoot(repo.dir));
    expect((await changedFiles(change)).map((f) => f.path)).toEqual(['pkg/core/a.ts', 'top.ts']);
    expect(await listHeadFiles(change)).toEqual(['pkg/core/a.ts', 'top.ts']);
  });

  it('reads a symlink as its target text, like git stores it', async () => {
    const repo = await repoOn({ files: { 'lib/real.ts': 'x\n' } });
    await symlink('real.ts', join(repo.dir, 'lib', 'alias.ts'));
    await repo.commit('add link');
    await repo.write({ 'lib/real.ts': 'y\n' });
    const change = await resolveChange(repo.dir, noGh);
    expect(await readAfter(change, 'lib/alias.ts')).toBe('real.ts');
    expect(await readBefore(change, 'lib/alias.ts')).toBe('real.ts');
  });

  it('meta.head is the short sha on a detached HEAD', async () => {
    const repo = await repoOn({ files: { 'a.ts': 'x\n' } });
    await repo.branch('feature/a');
    const sha = await repo.commit('a', { 'a.ts': 'y\n' });
    await repo.git('checkout', '--quiet', '--detach', sha);
    const meta = await computeMeta(await resolveChange(repo.dir, noGh));
    expect(meta.head).toBe(await repo.git('rev-parse', '--short', 'HEAD'));
    expect(meta.commits).toBe(1);
  });

  it('refuses to read through a symlinked directory that points outside the repo', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'diffcity-outside-'));
    dirs.push(outside);
    await writeFile(join(outside, 'hosts'), 'outside content\n', 'utf8');
    const repo = await repoOn({ files: { 'a.ts': 'x\n' } });
    await symlink(outside, join(repo.dir, 'outside'));
    await symlink(join(outside, 'hosts'), join(repo.dir, 'hosts-link'));
    await mkdir(join(repo.dir, 'lib'));
    await symlink('../outside', join(repo.dir, 'lib', 'nested'));
    const change = await resolveChange(repo.dir, noGh);

    await expect(readAfter(change, 'outside/hosts')).rejects.toMatchObject({ code: 'bad-path' });
    await expect(readAfter(change, 'lib/nested/hosts')).rejects.toMatchObject({ code: 'bad-path' });
    // A symlink itself reads as its target text, never as the target's content.
    expect(await readAfter(change, 'hosts-link')).toBe(join(outside, 'hosts'));
    expect(await readAfter(change, 'outside')).toBe(outside);
  });

  it('refuses paths with a .git segment, and symlinks that lead into .git', async () => {
    const repo = await repoOn({ files: { 'a.ts': 'x\n' } });
    await symlink('.git', join(repo.dir, 'meta'));
    const change = await resolveChange(repo.dir, noGh);
    for (const path of ['.git/config', 'sub/.git/HEAD', '.GIT/config', 'meta/config']) {
      await expect(readAfter(change, path)).rejects.toMatchObject({ code: 'bad-path' });
    }
    await expect(readBefore(change, '.git/config')).rejects.toMatchObject({ code: 'bad-path' });
    const committed = await resolveChange(repo.dir, { ...noGh, head: 'HEAD' });
    await expect(readAfter(committed, '.git/config')).rejects.toMatchObject({ code: 'bad-path' });
  });

  it('never runs a core.fsmonitor command from the collected repo', async () => {
    const hookDir = await mkdtemp(join(tmpdir(), 'diffcity-hook-'));
    dirs.push(hookDir);
    const marker = join(hookDir, 'ran');
    const hook = join(hookDir, 'monitor.sh');
    await writeFile(hook, `#!/bin/sh\necho ran > "${marker}"\n`, { encoding: 'utf8', mode: 0o755 });
    const repo = await repoOn({ files: { 'a.ts': 'x\n' } });
    await repo.git('config', 'core.fsmonitor', hook);
    await repo.write({ 'a.ts': 'y\n', 'b.ts': 'z\n' });

    const change = await resolveChange(repo.dir, noGh);
    await changedFiles(change);
    await listHeadFiles(change);
    await computeMeta(change);
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses paths that escape the repo', async () => {
    const repo = await repoOn({ files: { 'a.ts': 'x\n' } });
    const change = await resolveChange(repo.dir, noGh);
    await expect(readAfter(change, '../outside.ts')).rejects.toBeInstanceOf(GitError);
    await expect(readBefore(change, '/abs.ts')).rejects.toBeInstanceOf(GitError);
  });

  describe('not-a-repo', () => {
    it('findRepoRoot and resolveChange fail with code not-a-repo', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'diffcity-plain-'));
      dirs.push(dir);
      const error: unknown = await resolveChange(dir, noGh).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).code).toBe('not-a-repo');
      expect((error as GitError).message).toContain('not a git repository');
      await expect(findRepoRoot(dir)).rejects.toMatchObject({ code: 'not-a-repo' });
    });

    it('a repo without commits fails with code no-commits', async () => {
      const repo = await repoOn({});
      await expect(resolveChange(repo.dir, noGh)).rejects.toMatchObject({ code: 'no-commits' });
    });
  });
});
