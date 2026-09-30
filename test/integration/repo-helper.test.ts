import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepo, type TempRepo } from '../helpers/repo.js';

const repos: TempRepo[] = [];

async function track(repo: Promise<TempRepo>): Promise<TempRepo> {
  const r = await repo;
  repos.push(r);
  return r;
}

afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

describe('test/helpers/repo.ts', { timeout: 30_000 }, () => {
  it('creates a repo under os.tmpdir() with an initial tree committed on main', async () => {
    const repo = await track(createRepo({ files: { 'lib/ledger/invoice.ts': 'export const a = 1;\n' } }));
    expect(realpathSync(repo.dir).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(await repo.currentBranch()).toBe('main');
    expect(await repo.git('show', 'HEAD:lib/ledger/invoice.ts')).toBe('export const a = 1;');
    expect(await repo.status()).toBe('');
  });

  it('uses a local invented identity, independent of the global git config', async () => {
    const repo = await track(createRepo({ files: { 'a.txt': 'a\n' } }));
    expect(await repo.git('log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(
      'Sample Author <author@example.invalid>|Sample Author <author@example.invalid>',
    );
    expect(await repo.git('config', '--local', 'user.email')).toBe('author@example.invalid');
    // No global or system config is read by the helper's git invocations.
    const origins = await repo.git('config', '--list', '--show-origin');
    for (const line of origins.split('\n')) {
      expect(line.startsWith('file:.git/config') || line.startsWith('command line:')).toBe(true);
    }
  });

  it('commits, branches and checks out', async () => {
    const repo = await track(createRepo({ files: { 'a.txt': 'one\n' } }));
    const base = await repo.head();
    await repo.branch('feature/ledger');
    expect(await repo.currentBranch()).toBe('feature/ledger');
    const sha = await repo.commit('change a', { 'a.txt': 'two\n', 'b.txt': 'new\n' });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.head()).toBe(sha);
    expect(await repo.git('rev-list', '--count', `${base}..feature/ledger`)).toBe('1');
    await repo.checkout('main');
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(repo.dir, 'b.txt'))).toBe(false);
  });

  it('deletes files when their content is null', async () => {
    const repo = await track(createRepo({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } }));
    await repo.commit('drop b', { 'b.txt': null });
    expect(await repo.git('ls-tree', '--name-only', 'HEAD')).toBe('a.txt');
  });

  it('leaves uncommitted modifications and untracked files', async () => {
    const repo = await track(createRepo({ files: { 'a.txt': 'a\n', 'gone.txt': 'x\n' } }));
    await repo.write({ 'a.txt': 'changed\n', 'gone.txt': null, 'notes/new.txt': 'n\n' });
    const lines = (await repo.status()).split('\n').sort();
    expect(lines).toEqual([' D gone.txt', ' M a.txt', '?? notes/']);
  });

  it('produces distinct, ordered commit dates for deterministic history', async () => {
    const repo = await track(createRepo({ files: { 'a.txt': 'a\n' } }));
    await repo.commit('second', { 'a.txt': 'b\n' });
    const [second, first] = (await repo.git('log', '--format=%ct')).split('\n').map(Number);
    expect(second).toBeGreaterThan(first ?? Infinity);
  });

  it('refuses to write any path inside a .git directory', async () => {
    const repo = await track(createRepo());
    await expect(repo.write({ 'vendor/lib/.git/config': 'x' })).rejects.toThrow(/\.git/);
    await expect(repo.write({ '.git/hooks/pre-commit': 'x' })).rejects.toThrow(/\.git/);
  });

  it('refuses paths that escape the repo', async () => {
    const repo = await track(createRepo());
    await expect(repo.write({ '../outside.txt': 'x' })).rejects.toThrow(/outside/);
  });

  it('names the working tree after `name`, inside its own temp directory', async () => {
    const repo = await track(createRepo({ name: 'sample-ledger', files: { 'a.txt': 'a\n' } }));
    expect(basename(repo.dir)).toBe('sample-ledger');
    const parent = dirname(repo.dir);
    expect(realpathSync(parent).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(realpathSync(parent)).not.toBe(realpathSync(tmpdir()));
    expect(await repo.git('rev-parse', '--show-toplevel')).toBe(realpathSync(repo.dir));
    await repo.cleanup();
    expect(existsSync(parent)).toBe(false);
  });

  it('refuses a name that is not a single path segment', async () => {
    await expect(createRepo({ name: '../escape' })).rejects.toThrow(/single directory name/);
    await expect(createRepo({ name: '.git' })).rejects.toThrow(/single directory name/);
  });

  it('cleanup removes the directory', async () => {
    const repo = await createRepo({ files: { 'a.txt': 'a\n' } });
    await repo.cleanup();
    expect(existsSync(repo.dir)).toBe(false);
  });
});
