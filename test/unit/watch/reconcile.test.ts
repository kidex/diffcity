// The reconcile pass of the chokidar working tree backend (ADR-020, SPEC.md
// section 3a C4): the walk sees the tree the way the watcher does, stops past
// the budget, and the missing paths are the topmost ones the watcher lacks.

import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ignoreMatcher, missingFromWatched, parseIgnored, topmostDirs, walkWatched, type WalkEntry } from '../../../src/core/watch/index.js';
import { tempHome, type TempHome } from '../../helpers/config.js';

let home: TempHome | null = null;
afterEach(async () => {
  await home?.cleanup();
  home = null;
});

/** A small tree: src/cart/{total.ts, tax/rate.ts}, build/, node_modules/, a nested worktree and a symlink. */
async function sampleTree(): Promise<string> {
  home = await tempHome();
  const root = join(home.root, 'sample-shop');
  const files = [
    'README.md',
    'src/cart/total.ts',
    'src/cart/tax/rate.ts',
    'build/app.js',
    'node_modules/left-pad/index.js',
    'packages/till/node_modules/qs/index.js',
    'packages/till/main.ts',
    'trees/rack/src/a.ts',
    'notes.log',
  ];
  for (const file of files) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), 'x\n');
  }
  await mkdir(join(root, 'empty'), { recursive: true });
  await symlink(join(root, 'src'), join(root, 'src-link'));
  return root;
}

const rel = (root: string, entries: readonly WalkEntry[]): string[] => entries.map((entry) => `${entry.path.slice(root.length + 1)}${entry.dir ? '/' : ''}`).sort();

describe('walkWatched (DC-63)', () => {
  it('lists every entry the watcher would hold, skipping the ignored paths and what is below them', async () => {
    const root = await sampleTree();
    const ignored = ignoreMatcher(root, parseIgnored('build/\0notes.log\0'), [join(root, 'trees/rack')]);
    const walk = await walkWatched(root, ignored, 100);
    expect(walk.over).toBe(false);
    expect(rel(root, walk.entries)).toEqual([
      'README.md',
      'empty/',
      'packages/',
      'packages/till/',
      'packages/till/main.ts',
      'src-link',
      'src/',
      'src/cart/',
      'src/cart/tax/',
      'src/cart/tax/rate.ts',
      'src/cart/total.ts',
      'trees/',
    ]);
    // root, empty, packages, packages/till, src, src/cart, src/cart/tax, trees.
    expect(walk.dirs).toBe(8);
  });

  it('lists each directory before its contents', async () => {
    const root = await sampleTree();
    const walk = await walkWatched(root, ignoreMatcher(root, parseIgnored('')), 100);
    const order = walk.entries.map((entry) => entry.path);
    for (const [index, path] of order.entries()) {
      const parent = join(path, '..');
      if (parent !== root) expect(order.indexOf(parent)).toBeLessThan(index);
    }
  });

  it('watch/budget-git-only: stops once it has walked more directories than the limit', async () => {
    const root = await sampleTree();
    const ignored = ignoreMatcher(root, parseIgnored('build/\0'), [join(root, 'trees/rack')]);
    expect((await walkWatched(root, ignored, 8)).over).toBe(false);
    const over = await walkWatched(root, ignored, 7);
    expect(over.over).toBe(true);
    expect(over.dirs).toBe(8);
  });

  it('walks a subtree alone', async () => {
    const root = await sampleTree();
    const walk = await walkWatched(join(root, 'src', 'cart'), ignoreMatcher(root, parseIgnored('')), 100);
    expect(rel(join(root, 'src', 'cart'), walk.entries)).toEqual(['tax/', 'tax/rate.ts', 'total.ts']);
    expect(walk.dirs).toBe(2);
  });

  it('a missing start is an empty walk', async () => {
    const root = await sampleTree();
    expect(await walkWatched(join(root, 'gone'), () => false, 10)).toEqual({ dirs: 1, over: false, entries: [] });
  });
});

describe('missingFromWatched (DC-63)', () => {
  const root = '/work/sample-shop';
  const entries: WalkEntry[] = [
    { path: `${root}/src`, dir: true },
    { path: `${root}/src/total.ts`, dir: false },
    { path: `${root}/src/tax`, dir: true },
    { path: `${root}/src/tax/rate.ts`, dir: false },
    { path: `${root}/src/tax/zones`, dir: true },
    { path: `${root}/src/tax/zones/eu.ts`, dir: false },
    { path: `${root}/src/new.ts`, dir: false },
  ];

  it('nothing is missing when every entry is listed under its parent', () => {
    const watched = { [root]: ['src'], [`${root}/src`]: ['new.ts', 'tax', 'total.ts'], [`${root}/src/tax`]: ['rate.ts', 'zones'], [`${root}/src/tax/zones`]: ['eu.ts'] };
    expect(missingFromWatched(entries, watched)).toEqual([]);
  });

  it('returns a missed subdirectory alone, not what is below it, and a missed file', () => {
    // The checkout race: src/tax was read before zones and new.ts existed, then watched.
    const watched = { [root]: ['src'], [`${root}/src`]: ['tax', 'total.ts'], [`${root}/src/tax`]: ['rate.ts'] };
    expect(missingFromWatched(entries, watched)).toEqual([
      { path: `${root}/src/tax/zones`, dir: true },
      { path: `${root}/src/new.ts`, dir: false },
    ]);
  });

  it('a directory the watcher never saw is missing as a whole', () => {
    expect(missingFromWatched(entries, { [root]: [] })).toEqual([{ path: `${root}/src`, dir: true }]);
  });
});

describe('topmostDirs (DC-63)', () => {
  it('drops duplicates and directories below another one', () => {
    expect(topmostDirs(['/w/a/b', '/w/a', '/w/a-b', '/w/a-b/c', '/w/a/b/c', '/w/d', '/w/a'])).toEqual(['/w/a', '/w/a-b', '/w/d']);
  });
});
