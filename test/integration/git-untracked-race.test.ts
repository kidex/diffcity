// An untracked file can vanish between `git ls-files` and `git add -N` (e.g. a
// bundler's temporary file). The real git call then fails; changedFiles must
// still return the list. The seam wraps `git` so the file is deleted right
// before the intent-to-add call, and the real git runs against the real repo.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as exec from '../../src/core/git/exec.js';
import { changedFiles, resolveChange } from '../../src/core/git/index.js';
import { ghForbidden, isolateGitConfig } from '../helpers/git-env.js';
import { createRepo, type TempRepo } from '../helpers/repo.js';

/** Absolute path deleted just before `git add -N` runs; null disables the seam. */
const vanishing = vi.hoisted((): { target: string | null } => ({ target: null }));

vi.mock('../../src/core/git/exec.js', async (importOriginal) => {
  const original = await importOriginal<typeof exec>();
  return {
    ...original,
    git: async (cwd: string, args: readonly string[], options?: exec.GitCallOptions) => {
      if (args.includes('--intent-to-add') && vanishing.target !== null) {
        await rm(vanishing.target, { force: true });
      }
      return original.git(cwd, args, options);
    },
  };
});

isolateGitConfig();

const repos: TempRepo[] = [];

afterEach(async () => {
  vanishing.target = null;
  while (repos.length > 0) await repos.pop()?.cleanup();
});

describe('changedFiles with an untracked file that vanishes mid-collection', { timeout: 30_000 }, () => {
  it('falls back to the plain diff and leaves the vanished file out', async () => {
    const repo = await createRepo({ files: { 'lib/a.ts': 'export const a = 1;\n' } });
    repos.push(repo);
    await repo.write({
      'lib/a.ts': 'export const a = 2;\n',
      'lib/kept.ts': 'export const kept = 1;\n',
      'vite.config.ts.timestamp-1767225600000-abc.mjs': 'export default {};\n',
    });
    vanishing.target = join(repo.dir, 'vite.config.ts.timestamp-1767225600000-abc.mjs');

    const change = await resolveChange(repo.dir, { runner: ghForbidden().runner });
    expect(await changedFiles(change)).toEqual([
      { path: 'lib/a.ts', oldPath: 'lib/a.ts', type: 'mod', binary: false },
      { path: 'lib/kept.ts', oldPath: null, type: 'add', binary: false },
    ]);
  });
});
