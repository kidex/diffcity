// readAfterBatch: many after-state files in one go, byte for byte the same as readAfterBytes.

import { afterEach, describe, expect, it } from 'vitest';
import { readAfterBatch, readAfterBytes, resolveChange } from '../../src/core/git/index.js';
import { ghForbidden, isolateGitConfig } from '../helpers/git-env.js';
import { createRepo, type TempRepo } from '../helpers/repo.js';

isolateGitConfig();

const repos: TempRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

const files = {
  'src/oven.ts': 'export const heat = 1;\n',
  'src/with space.ts': 'export const spaced = 2;\n',
  'src/ends with missing': 'looks like a missing header\n',
  'media/clip.ts': 'G\u0000\u0011\u0010 not text\n',
  'src/empty.ts': '',
  'src/line\nbreak.ts': 'export const odd = 3;\n',
  'src/carriage.ts\r': 'export const cr = 4;\n',
};
const paths = [...Object.keys(files), 'src/not-there.ts', 'src/oven.ts'];

describe('readAfterBatch', () => {
  it.each([
    ['--head commit (one cat-file --batch)', true],
    ['working tree', false],
  ])('%s: same bytes as readAfterBytes, null for missing paths, input order kept', async (_mode, committed) => {
    const repo = await createRepo({ files: { 'README.md': 'base\n' } });
    repos.push(repo);
    await repo.branch('feature/oven');
    if (committed) await repo.commit('after', files);
    else await repo.write(files);

    const change = await resolveChange(repo.dir, {
      ...(committed ? { head: 'feature/oven' } : {}),
      runner: ghForbidden().runner,
    });
    const batch = await readAfterBatch(change, paths);
    const single = await Promise.all(paths.map((path) => readAfterBytes(change, path)));
    expect(batch).toEqual(single);
    expect(batch[paths.indexOf('src/not-there.ts')]).toBeNull();
    expect(batch[paths.indexOf('src/empty.ts')]?.length).toBe(0);
    expect(batch[paths.indexOf('src/carriage.ts\r')]?.toString('utf8')).toBe('export const cr = 4;\n');
    expect(batch[paths.indexOf('src/line\nbreak.ts')]?.toString('utf8')).toBe('export const odd = 3;\n');
    expect(batch[paths.indexOf('media/clip.ts')]?.includes(0)).toBe(true);
  });

  it('returns an empty list for no paths', async () => {
    const repo = await createRepo({ files: { 'a.ts': 'a\n' } });
    repos.push(repo);
    const change = await resolveChange(repo.dir, { head: 'main', runner: ghForbidden().runner });
    expect(await readAfterBatch(change, [])).toEqual([]);
  });
});
