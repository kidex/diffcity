// discoverRepos on a tree of real git repos (`git init`), with the traps a
// developer's workspace has: a repo nested in a repo, a repo under
// node_modules, a repo in a hidden directory, symbolic link loops and a
// dangling link. It must return quickly, with exactly the top-level repos.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverRepos } from '../../../src/core/repos/discover.js';

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'diffcity-scan-real-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function gitInit(rel: string): Promise<string> {
  const dir = join(root, rel);
  await mkdir(dir, { recursive: true });
  await execFileAsync('git', ['init', '--quiet', dir], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return dir;
}

describe('discoverRepos on real repos (scan, ADR-016)', () => {
  it('repos/discover-nested + repos/discover-skips-node-modules-hidden-symlinks: nested, node_modules, hidden and symlink loops', async () => {
    const garden = await gitInit('workspace/sample-garden');
    await gitInit('workspace/sample-garden/vendor/inner-lib');
    await gitInit('workspace/sample-garden/packages/web/sub-module');
    const kiosk = await gitInit('workspace/clients/demo-kiosk');
    await gitInit('workspace/clients/demo-kiosk-ui/node_modules/left-pad-ish');
    await gitInit('node_modules/top-level-dep');
    await gitInit('.cache/hidden-repo');
    await gitInit('workspace/.archive/old-repo');
    const notes = await gitInit('notes');

    // Loops: a link to the scanned root, a link to an ancestor, a link to a sibling folder, a dangling link.
    await symlink(root, join(root, 'loop-to-root'));
    await mkdir(join(root, 'workspace/clients/deep'), { recursive: true });
    await symlink('../..', join(root, 'workspace/clients/deep/up-two'));
    await symlink(join(root, 'workspace'), join(root, 'notes-link-to-workspace'));
    await symlink(join(root, 'missing-target'), join(root, 'dangling'));

    const started = Date.now();
    const found = await discoverRepos(root);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(found).toEqual([kiosk, garden, notes].sort());
    expect(found).toHaveLength(3);
  }, 30_000);

  it('a scan started from inside a loop still terminates with the reachable repos only', async () => {
    const garden = await gitInit('a/sample-garden');
    await symlink(join(root, 'a'), join(root, 'a', 'self'));
    expect(await discoverRepos(join(root, 'a', 'self', 'self'))).toEqual([garden]);
  }, 30_000);
});
