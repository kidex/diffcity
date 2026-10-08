// measureAfter and LineMeasure (ADR-030, the file-size rule): lines are counted
// only after the first BINARY_SNIFF_BYTES show text; binary content stops the
// read there and takes its size from the object header or lstat.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LineMeasure, measureAfter } from '../../src/core/git/files.js';
import { resolveChange } from '../../src/core/git/index.js';
import { isolateGitConfig } from '../helpers/git-env.js';
import { createRepo, type TempRepo } from '../helpers/repo.js';

isolateGitConfig();

const repos: TempRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

const SNIFF = 8000;

function feed(measure: LineMeasure, chunks: Buffer[]): ('binary' | 'text')[] {
  return chunks.map((chunk) => measure.add(chunk));
}

describe('LineMeasure', () => {
  it('counts lines across chunk boundaries, before and after the sniffed head', () => {
    const text = Buffer.from(`${'ledger entry\n'.repeat(1000)}last line`);
    const measure = new LineMeasure();
    const answers = feed(measure, [text.subarray(0, 5), text.subarray(5, SNIFF + 3), text.subarray(SNIFF + 3)]);
    expect(answers).toEqual(['text', 'text', 'text']);
    expect([measure.bytes, measure.lines()]).toEqual([text.length, 1001]);
    expect(new LineMeasure().lines()).toBe(0);
    const short = new LineMeasure();
    short.add(Buffer.from('a\nb\n'));
    expect(short.lines()).toBe(2);
  });

  it('says stop as soon as the first BINARY_SNIFF_BYTES hold a NUL byte, without counting further', () => {
    const measure = new LineMeasure();
    const head = Buffer.alloc(SNIFF / 2, 0x41);
    head[10] = 0;
    expect(measure.add(head)).toBe('text');
    expect(measure.add(Buffer.alloc(SNIFF / 2, 0x0a))).toBe('binary');
    expect(measure.lines()).toBeNull();
  });

  it('a short binary is told apart at the end; a NUL past the sniffed head is text, as for git', () => {
    const short = new LineMeasure();
    expect(short.add(Buffer.from([0x61, 0, 0x0a]))).toBe('text');
    expect(short.lines()).toBeNull();
    const late = new LineMeasure();
    feed(late, [Buffer.alloc(SNIFF, 0x0a), Buffer.from([0, 0x0a])]);
    expect(late.lines()).toBe(SNIFF + 1);
  });
});

describe('measureAfter', () => {
  it('measures text, and takes a binary size without reading it, committed and in the working tree', async () => {
    const repo = await createRepo({ name: 'acme-cli', files: { 'README.md': 'start\n' } });
    repos.push(repo);
    const big = Buffer.alloc(3 * 1024 * 1024, 0x0a);
    big[0] = 0;
    await repo.branch('feature');
    await writeFile(join(repo.dir, 'assets.bin'), big);
    await repo.commit('assets', { 'docs/guide.md': 'one\ntwo\nthree' });
    const committed = await resolveChange(repo.dir, { base: 'main', head: 'feature' });
    expect(await measureAfter(committed, 'assets.bin')).toEqual({ bytes: big.length, lines: null });
    expect(await measureAfter(committed, 'docs/guide.md')).toEqual({ bytes: 13, lines: 3 });
    expect(await measureAfter(committed, 'missing.md')).toBeNull();

    await writeFile(join(repo.dir, 'assets.bin'), Buffer.concat([big, big]));
    const worktree = await resolveChange(repo.dir, { base: 'main' });
    expect(await measureAfter(worktree, 'assets.bin')).toEqual({ bytes: 2 * big.length, lines: null });
    expect(await measureAfter(worktree, 'docs/guide.md')).toEqual({ bytes: 13, lines: 3 });
  });
});
