// Files that are not parsed are hashed from a stream (never buffered): a large
// binary does not break the collect, and the buffered read path is not used for it.

import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as GitLayer from '../../../src/core/git/index.js';
import { ghForbidden, isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

const buffered: string[] = [];
vi.mock('../../../src/core/git/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof GitLayer>();
  return {
    ...original,
    readBeforeBytes: (change: Parameters<typeof original.readBeforeBytes>[0], path: string) => {
      buffered.push(path);
      return original.readBeforeBytes(change, path);
    },
    readAfterBytes: (change: Parameters<typeof original.readAfterBytes>[0], path: string) => {
      buffered.push(path);
      return original.readAfterBytes(change, path);
    },
  };
});

const { buildReportWithHead } = await import('../../../src/core/report/build.js');

isolateGitConfig();

const repos: TempRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
  buffered.length = 0;
});

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const SIZE = 20 * 1024 * 1024;

/** ASCII bytes (the repo helper writes UTF-8) with a NUL up front, so git treats the file as binary. */
function blob(seed: number): Buffer {
  const bytes = randomBytes(SIZE);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (bytes[i] ?? 0) & 0x7f;
  bytes[0] = 0;
  bytes[1] = seed;
  return bytes;
}

describe('large binary files', () => {
  it('fingerprint/large-binary: a 20 MB binary is hashed from a stream in commit and working tree mode', async () => {
    const repo = await createRepo({ name: 'sample-shop', files: { 'src/a.ts': 'export const a = 1;\n' } });
    repos.push(repo);
    await repo.branch('feature/assets');
    const first = blob(1);
    await repo.commit('add asset', { 'assets/big.bin': first.toString('utf8'), 'src/a.ts': 'export const a = 2;\n' });
    const commitSha = await repo.head();
    const options = { repoDir: repo.dir, base: 'main', now: new Date('2026-03-04T05:06:07.000Z'), runner: ghForbidden().runner, trustConfig: false };

    const committed = await buildReportWithHead({ ...options, head: commitSha });
    expect(committed.fingerprints.files['assets/big.bin']).toEqual({ before: null, after: sha(first) });
    expect(buffered).not.toContain('assets/big.bin');
    expect(buffered).toContain('src/a.ts');

    const second = blob(2);
    await repo.write({ 'assets/big.bin': second.toString('utf8') });
    const dirty = await buildReportWithHead(options);
    expect(dirty.fingerprints.files['assets/big.bin']).toEqual({ before: null, after: sha(second) });
    expect(buffered).not.toContain('assets/big.bin');
  }, 120_000);
});
