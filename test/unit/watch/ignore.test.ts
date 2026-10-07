// What the watchers watch and ignore (ADR-020, SPEC.md section 3a C4): the git
// paths under the common dir, and the working tree ignores.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { countWatchedDirs, gitIgnoreMatcher, ignoreMatcher, parseIgnored, quietEvent } from '../../../src/core/watch/index.js';
import { tempHome, type TempHome } from '../../helpers/config.js';

const COMMON = '/work/sample-shop/.git';

describe('gitIgnoreMatcher (C4)', () => {
  const ignored = gitIgnoreMatcher(COMMON);
  it('watches HEAD, packed-refs, refs/** and the HEAD of each linked worktree', () => {
    for (const path of ['', 'HEAD', 'packed-refs', 'refs', 'refs/heads', 'refs/heads/feature/cart', 'refs/remotes/origin/main', 'worktrees', 'worktrees/rack', 'worktrees/rack/HEAD']) {
      expect(ignored(join(COMMON, path)), path).toBe(false);
    }
  });

  it('ignores the index, objects, logs, lock files and the rest of a linked worktree dir', () => {
    for (const path of ['index', 'objects', 'objects/ab/cdef', 'logs/HEAD', 'config', 'ORIG_HEAD', 'HEAD.lock', 'packed-refs.lock', 'refs/heads/main.lock', 'worktrees/rack/index', 'worktrees/rack/logs/HEAD']) {
      expect(ignored(join(COMMON, path)), path).toBe(true);
    }
    expect(ignored('/work/other/.git/HEAD')).toBe(true);
  });
});

describe('ignoreMatcher (ADR-020)', () => {
  const root = '/work/sample-shop';
  const set = parseIgnored('build/\0.cache/\0src/generated/\0notes.log\0');

  it('parses directories (trailing slash) and files', () => {
    expect([...set.dirs]).toEqual(['build', '.cache', 'src/generated']);
    expect([...set.files]).toEqual(['notes.log']);
  });

  it('watch/node-modules-ignored: any .git or node_modules segment is ignored', () => {
    const ignored = ignoreMatcher(root, parseIgnored(''));
    expect(ignored(join(root, 'node_modules'))).toBe(true);
    expect(ignored(join(root, 'packages/cart/node_modules/left-pad/index.js'))).toBe(true);
    expect(ignored(join(root, '.git'))).toBe(true);
    expect(ignored(join(root, 'vendor/lib/.git'))).toBe(true);
    expect(ignored(join(root, 'src/cart/total.ts'))).toBe(false);
  });

  it('watch/gitignored-dir-ignored: paths under an ignored directory, and ignored files', () => {
    const ignored = ignoreMatcher(root, set);
    expect(ignored(root)).toBe(false);
    expect(ignored(join(root, 'build'))).toBe(true);
    expect(ignored(join(root, 'build/assets/app.js'))).toBe(true);
    expect(ignored(join(root, 'src/generated/types.ts'))).toBe(true);
    expect(ignored(join(root, 'notes.log'))).toBe(true);
    expect(ignored(join(root, 'builder/x.ts'))).toBe(false);
    expect(ignored(join(root, 'src/cart/total.ts'))).toBe(false);
    expect(ignored('/work/elsewhere/build')).toBe(false);
  });

  it('linked worktrees nested in the working tree are left to their own watcher', () => {
    const ignored = ignoreMatcher(root, parseIgnored(''), [join(root, 'trees/rack'), '/work/outside']);
    expect(ignored(join(root, 'trees/rack/src/a.ts'))).toBe(true);
    expect(ignored(join(root, 'trees/other.ts'))).toBe(false);
  });
});

describe("diffcity's own files (SPEC.md section 3a, ADR-036)", () => {
  const root = '/work/sample-shop';
  const ignored = ignoreMatcher(root, parseIgnored(''));

  it('own-files/watcher-ignores-own-files: findings.json and the fix queue directories with everything in them are ignored at the root', () => {
    expect(ignored(join(root, '.diffcity/findings.json'))).toBe(true);
    expect(ignored(join(root, '.diffcity/fix-queue'))).toBe(true);
    expect(ignored(join(root, '.diffcity/fix-queue/0123456789abcdef0123456789abcdef.json'))).toBe(true);
    expect(ignored(join(root, '.diffcity/.fix-queue.0123456789abcdef0123456789abcdef.4242.0123456789ab.tmp'))).toBe(true);
    expect(ignored(join(root, '.diffcity/fix-queue.taking'))).toBe(true);
    expect(ignored(join(root, '.diffcity/fix-queue.taking/0123456789abcdef0123456789abcdef.json'))).toBe(true);
  });

  it('own-files/taking-dir-is-own (watcher): only the two directories at the root are own, not look-alikes or nested copies', () => {
    expect(ignored(join(root, 'packages/cart/.diffcity/fix-queue/a.json'))).toBe(false);
    expect(ignored(join(root, 'packages/cart/.diffcity/fix-queue.taking'))).toBe(false);
    expect(ignored(join(root, '.diffcity/fix-queue.bak'))).toBe(false);
    expect(ignored(join(root, '.diffcity/fix-queue-notes.md'))).toBe(false);
    expect(ignored(join(root, '.diffcity/fix-queue.taking.bak/a.json'))).toBe(false);
    expect(ignored(join(root, '.diffcity/.fix-queue.tmp'))).toBe(false);
    // The single-file queue of the first design is a normal file now.
    expect(ignored(join(root, '.diffcity/fix-queue.json'))).toBe(false);
  });

  it('own-files/spec-md-is-a-normal-file (watcher): the directory, spec.md and nested copies stay watched', () => {
    expect(ignored(join(root, '.diffcity'))).toBe(false);
    expect(ignored(join(root, '.diffcity/spec.md'))).toBe(false);
    expect(ignored(join(root, '.diffcity/notes/findings.json'))).toBe(false);
    expect(ignored(join(root, 'packages/cart/.diffcity/findings.json'))).toBe(false);
  });

  it('an event on the .diffcity directory entry or a fix queue directory entry is quiet; events on other files are not', () => {
    expect(quietEvent(root, join(root, '.diffcity'))).toBe(true);
    expect(quietEvent(root, join(root, '.diffcity/fix-queue'))).toBe(true);
    expect(quietEvent(root, join(root, '.diffcity/fix-queue.taking'))).toBe(true);
    expect(quietEvent(root, join(root, '.diffcity/spec.md'))).toBe(false);
    expect(quietEvent(root, join(root, '.diffcity/fix-queue.bak'))).toBe(false);
    expect(quietEvent(root, join(root, 'packages/.diffcity'))).toBe(false);
    expect(quietEvent(root, join(root, 'packages/.diffcity/fix-queue'))).toBe(false);
    expect(quietEvent(root, root)).toBe(false);
  });
});

describe('countWatchedDirs (ADR-020 budget)', () => {
  let home: TempHome | null = null;
  afterEach(async () => {
    await home?.cleanup();
    home = null;
  });

  it('counts the root and every directory not ignored, and stops past the limit', async () => {
    home = await tempHome();
    const root = join(home.root, 'tree');
    for (const dir of ['a/b', 'a/c', 'd', 'node_modules/x/y']) await mkdir(join(root, dir), { recursive: true });
    const ignored = ignoreMatcher(root, parseIgnored(''));
    expect(await countWatchedDirs(root, ignored, 100)).toBe(5);
    expect(await countWatchedDirs(root, ignored, 3)).toBe(4);
  });
});
