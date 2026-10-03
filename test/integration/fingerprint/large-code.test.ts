// A code file above MAX_PARSE_BYTES is neither read whole nor parsed (DC-72): it is hashed
// from a stream and its entry follows git, as a non-code file's does (ADR-008).

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as GitLayer from '../../../src/core/git/index.js';
import { MAX_PARSE_BYTES } from '../../../src/core/parse/file.js';
import { ghForbidden, isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

/** Every path handed to a buffering read, whichever function did it. */
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
    readAfterBatch: (change: Parameters<typeof original.readAfterBatch>[0], paths: readonly string[]) => {
      buffered.push(...paths);
      return original.readAfterBatch(change, paths);
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

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const MIB = 1024 * 1024;

/** Valid TypeScript with one function, padded with comment lines (no NUL byte) to `size` bytes. */
function codeOfSize(name: string, size: number, body = 1): string {
  const head = `export function ${name}() { return ${String(body)}; }\n`;
  const line = `// ${'x'.repeat(77)}\n`;
  return head + line.repeat(Math.floor((size - head.length) / line.length));
}

const options = (repo: TempRepo) => ({
  repoDir: repo.dir,
  base: 'main',
  now: new Date('2026-03-04T05:06:07.000Z'),
  runner: ghForbidden().runner,
  trustConfig: false,
});

const symbolsOf = (report: Awaited<ReturnType<typeof buildReportWithHead>>['report'], path: string) =>
  report.packages.flatMap((pkg) => pkg.files).find((file) => file.path === path);

describe('code files above the parse limit', () => {
  it('fingerprint/large-code: a 50 MB code file is hashed, not buffered or parsed, touched or untouched, in commit and working tree mode', async () => {
    const huge = codeOfSize('bundle', 50 * MIB);
    const hugeUntouched = codeOfSize('generated', 50 * MIB);
    const repo = await createRepo({ name: 'sample-shop', files: { 'src/a.ts': 'export const a = 1;\n', 'gen/untouched.ts': hugeUntouched } });
    repos.push(repo);
    await repo.branch('feature/bundle');
    await repo.commit('add bundle', { 'dist/bundle.ts': huge, 'src/a.ts': 'export const a = 2;\n' });
    const commitSha = await repo.head();

    const committed = await buildReportWithHead({ ...options(repo), head: commitSha });
    expect(committed.fingerprints.files['dist/bundle.ts']).toEqual({ before: null, after: sha(huge) });
    expect(committed.fingerprints.files['gen/untouched.ts']).toEqual({ before: sha(hugeUntouched), after: sha(hugeUntouched) });
    expect(symbolsOf(committed.report, 'dist/bundle.ts')).toMatchObject({ status: 'add', symbols: [] });
    expect(symbolsOf(committed.report, 'gen/untouched.ts')).toMatchObject({ status: 'same', symbols: [] });
    expect(symbolsOf(committed.report, 'src/a.ts')?.symbols.length).toBeGreaterThan(0);
    expect(buffered).toContain('src/a.ts');
    expect(buffered).not.toContain('dist/bundle.ts');
    expect(buffered).not.toContain('gen/untouched.ts');

    buffered.length = 0;
    const edited = codeOfSize('bundle', 50 * MIB, 2);
    await repo.write({ 'dist/bundle.ts': edited });
    const dirty = await buildReportWithHead(options(repo));
    expect(dirty.fingerprints.files['dist/bundle.ts']).toEqual({ before: null, after: sha(edited) });
    expect(symbolsOf(dirty.report, 'dist/bundle.ts')).toMatchObject({ status: 'add', symbols: [] });
    expect(symbolsOf(dirty.report, 'gen/untouched.ts')).toMatchObject({ status: 'same', symbols: [] });
    expect(buffered).not.toContain('dist/bundle.ts');
    expect(buffered).not.toContain('gen/untouched.ts');
  }, 240_000);

  it('fingerprint/large-code: a file at the limit is still parsed, one byte over is not', async () => {
    const atLimit = codeOfSize('edge', MAX_PARSE_BYTES, 1);
    expect(Buffer.byteLength(atLimit)).toBeLessThanOrEqual(MAX_PARSE_BYTES);
    const over = `${atLimit}${'/'.repeat(MAX_PARSE_BYTES - Buffer.byteLength(atLimit) + 1)}`;
    expect(Buffer.byteLength(over)).toBe(MAX_PARSE_BYTES + 1);
    const repo = await createRepo({ files: { 'README.md': 'base\n' } });
    repos.push(repo);
    await repo.branch('feature/edge');
    await repo.commit('add', { 'src/edge.ts': atLimit, 'src/over.ts': over });

    const { report, fingerprints } = await buildReportWithHead({ ...options(repo), head: 'feature/edge' });
    expect(symbolsOf(report, 'src/edge.ts')?.symbols.map((s) => s.status)).toEqual(['add']);
    expect(symbolsOf(report, 'src/over.ts')).toMatchObject({ status: 'add', symbols: [] });
    expect(fingerprints.files['src/over.ts']).toEqual({ before: null, after: sha(over) });
  }, 120_000);

  it('fingerprint/large-code: a file that crosses the limit between base and head follows git on both sides', async () => {
    const small = codeOfSize('grow', 1024, 1);
    const big = codeOfSize('grow', 3 * MIB, 2);
    const repo = await createRepo({ files: { 'src/grow.ts': small, 'src/shrink.ts': big } });
    repos.push(repo);
    await repo.branch('feature/cross');
    await repo.commit('cross', { 'src/grow.ts': big, 'src/shrink.ts': small });

    const { report, fingerprints } = await buildReportWithHead({ ...options(repo), head: 'feature/cross' });
    for (const path of ['src/grow.ts', 'src/shrink.ts']) {
      expect(symbolsOf(report, path)).toMatchObject({ status: 'mod', symbols: [] });
    }
    expect(fingerprints.files['src/grow.ts']).toEqual({ before: sha(small), after: sha(big) });
    expect(fingerprints.files['src/shrink.ts']).toEqual({ before: sha(big), after: sha(small) });
    expect(buffered).not.toContain('src/grow.ts');
    expect(buffered).not.toContain('src/shrink.ts');
  }, 120_000);
});
