// rootSpellings: the physical root git reports and the logical one reached
// through a symbolic link, so absolute paths in a findings file match either.

import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rootSpellings } from '../../src/core/git/root.js';

let base: string | null = null;
afterEach(async () => {
  if (base !== null) await rm(base, { recursive: true, force: true });
  base = null;
});

describe('rootSpellings', () => {
  it('adds the logical root of a directory reached through a link, and the realpath', async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'dc-root-')));
    const physical = join(base, 'disk', 'sample-shop');
    await mkdir(join(physical, 'src', 'cart'), { recursive: true });
    await symlink(join(base, 'disk'), join(base, 'alias'));
    const logicalCwd = join(base, 'alias', 'sample-shop', 'src', 'cart');
    expect(await rootSpellings(physical, [logicalCwd, undefined])).toEqual([physical, join(base, 'alias', 'sample-shop')]);
    expect(await rootSpellings(physical, [join(base, 'alias', 'sample-shop')])).toEqual([physical, join(base, 'alias', 'sample-shop')]);
  });

  it('ignores directories outside the root, relative ones and missing ones', async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'dc-root-')));
    const root = join(base, 'sample-shop');
    await mkdir(root);
    expect(await rootSpellings(root, [base, 'sample-shop', join(base, 'gone')])).toEqual([root]);
    expect(await rootSpellings(join(base, 'gone'), [root])).toEqual([join(base, 'gone')]);
  });
});
