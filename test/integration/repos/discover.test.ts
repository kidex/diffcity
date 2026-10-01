import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISCOVER_MAX_DEPTH, discoverRepos } from '../../../src/core/repos/discover.js';

// Repos are faked with an empty `.git` directory (or a `.git` file, as in a
// linked worktree or a submodule): discovery only looks for the entry.
let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'diffcity-scan-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fakeRepo(rel: string, kind: 'dir' | 'file' = 'dir'): Promise<string> {
  const dir = join(root, rel);
  await mkdir(dir, { recursive: true });
  if (kind === 'dir') await mkdir(join(dir, '.git'));
  else await writeFile(join(dir, '.git'), 'gitdir: ../elsewhere\n');
  return dir;
}

describe('discoverRepos (scan, ADR-016)', () => {
  it('repos/discover-nested: finds repos at any depth and does not descend into a repo it found', async () => {
    const shop = await fakeRepo('clients/sample-shop');
    await fakeRepo('clients/sample-shop/vendor/inner-lib');
    const orders = await fakeRepo('order-service');
    const docs = await fakeRepo('archive/2025/docs-site', 'file');
    await mkdir(join(root, 'empty/folder'), { recursive: true });
    expect(await discoverRepos(root)).toEqual([docs, shop, orders]);
  });

  it('returns the root itself when it is a repo', async () => {
    await mkdir(join(root, '.git'));
    await fakeRepo('nested-lib');
    expect(await discoverRepos(root)).toEqual([root]);
  });

  it('repos/discover-skips-node-modules-hidden-symlinks: skips node_modules, hidden directories and symbolic links', async () => {
    const visible = await fakeRepo('order-service');
    await fakeRepo('node_modules/some-package');
    await fakeRepo('order-service-copy/node_modules/other-package');
    await fakeRepo('.cache/hidden-repo');
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'diffcity-scan-outside-')));
    try {
      await mkdir(join(outside, 'linked-repo', '.git'), { recursive: true });
      await symlink(join(outside, 'linked-repo'), join(root, 'link-to-repo'));
      await symlink(visible, join(root, 'link-to-order-service'));
      expect(await discoverRepos(root)).toEqual([visible]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it(`stops at depth ${String(DISCOVER_MAX_DEPTH)} below the scanned directory`, async () => {
    expect(DISCOVER_MAX_DEPTH).toBe(6);
    const atSix = await fakeRepo('a/b/c/d/e/at-six');
    await fakeRepo('a/b/c/d/e/f/at-seven');
    expect(await discoverRepos(root)).toEqual([atSix]);
  });

  it('accepts a relative or symlinked starting directory and returns realpaths', async () => {
    const shop = await fakeRepo('sample-shop');
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'diffcity-scan-link-')));
    try {
      await symlink(root, join(outside, 'workspace'));
      expect(await discoverRepos(join(outside, 'workspace'))).toEqual([shop]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a starting directory that does not exist', async () => {
    await expect(discoverRepos(join(root, 'missing'))).rejects.toThrow();
  });
});
