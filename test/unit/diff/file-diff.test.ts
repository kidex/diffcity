// The diff of one file for the file view (ADR-027), on small invented repos
// built with real git: rows, hunks, folds, symbol spans, limits and highlights.

import { afterEach, describe, expect, it } from 'vitest';
import { computeFileDiff, foldsOf, hunksOf, parseUnifiedDiff, symbolSpans } from '../../../src/core/diff/file-diff.js';
import type { DiffRow } from '../../../src/core/model/types.js';
import { featureChange, lines, sha } from '../../helpers/file-diff.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import type { TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const repos: TempRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

const kinds = (rows: DiffRow[] | undefined): string => (rows ?? []).map((row) => row.kind[0]).join('');

describe('filediff/added-file-all-add', () => {
  it('shows every line of a new file as an add, with new line numbers only', async () => {
    const change = await featureChange({ 'README.md': 'docs\n' }, { 'src/cart.ts': lines(4) }, repos);
    const diff = await computeFileDiff(change.request('src/cart.ts'), change.git);
    expect(diff).toMatchObject({
      kind: 'text',
      path: 'src/cart.ts',
      head: change.head,
      snapshotId: 1,
      stale: false,
      stats: { added: 4, removed: 0 },
      sizes: { before: null, after: lines(4).length },
      hunks: [{ first: 0, last: 3 }],
      folds: [],
    });
    expect(diff.rows?.map((row) => [row.kind, row.old, row.new, row.text])).toEqual([
      ['add', null, 1, 'line 1'],
      ['add', null, 2, 'line 2'],
      ['add', null, 3, 'line 3'],
      ['add', null, 4, 'line 4'],
    ]);
  });
});

describe('filediff/deleted-file-all-del', () => {
  it('shows every line of a removed file as a del, with old line numbers only', async () => {
    const change = await featureChange({ 'src/cart.ts': lines(3), 'README.md': 'docs\n' }, { 'src/cart.ts': null }, repos);
    const diff = await computeFileDiff(change.request('src/cart.ts'), change.git);
    expect(diff).toMatchObject({ kind: 'text', stale: false, stats: { added: 0, removed: 3 }, sizes: { before: lines(3).length, after: null } });
    expect(diff.rows?.map((row) => [row.kind, row.old, row.new])).toEqual([
      ['del', 1, null],
      ['del', 2, null],
      ['del', 3, null],
    ]);
  });
});

describe('filediff/modified-rows-and-hunks', () => {
  it('lists context, removed and added rows in file order, and a hunk per run of changed rows', async () => {
    const before = lines(20);
    const after = lines(20, { 5: 'five', 15: 'fifteen' });
    const change = await featureChange({ 'src/cart.ts': before }, { 'src/cart.ts': after }, repos);
    const diff = await computeFileDiff(change.request('src/cart.ts'), change.git);
    expect(diff.kind).toBe('text');
    expect(diff.stats).toEqual({ added: 2, removed: 2 });
    expect(diff.rows).toHaveLength(22);
    expect(diff.rows?.slice(3, 8).map((row) => [row.kind, row.old, row.new, row.text])).toEqual([
      ['ctx', 4, 4, 'line 4'],
      ['del', 5, null, 'line 5'],
      ['add', null, 5, 'five'],
      ['ctx', 6, 6, 'line 6'],
      ['ctx', 7, 7, 'line 7'],
    ]);
    expect(diff.hunks).toEqual([
      { first: 4, last: 5 },
      { first: 15, last: 16 },
    ]);
  });
});

describe('filediff/folds-keep-3-context', () => {
  it('folds a run of more than 8 unchanged rows, leaving 3 rows on each side', async () => {
    const change = await featureChange({ 'src/cart.ts': lines(30) }, { 'src/cart.ts': lines(30, { 15: 'fifteen' }) }, repos);
    const diff = await computeFileDiff(change.request('src/cart.ts'), change.git);
    // Rows 0-13 are context, 14 and 15 the change, 16-30 context.
    expect(kinds(diff.rows)).toBe(`${'c'.repeat(14)}da${'c'.repeat(15)}`);
    expect(diff.folds).toEqual([
      { first: 3, last: 10 },
      { first: 19, last: 27 },
    ]);
  });

  it('keeps a run of 8 rows or fewer unfolded', () => {
    const run = (count: number) => Array.from({ length: count }, () => ({ kind: 'ctx' as const }));
    expect(foldsOf([...run(8), { kind: 'add' }, ...run(9)])).toEqual([{ first: 12, last: 14 }]);
    expect(hunksOf([{ kind: 'ctx' }, { kind: 'del' }, { kind: 'add' }, { kind: 'ctx' }, { kind: 'add' }])).toEqual([
      { first: 1, last: 2 },
      { first: 4, last: 4 },
    ]);
  });
});

describe('filediff/symbol-span-mod', () => {
  it('spans the after-range of a symbol, removed rows inside it included, and focuses the asked one', async () => {
    const before = 'function a() {\n  return 1;\n}\nfunction b() {\n  const x = 1;\n  return x;\n}\n';
    const after = 'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n';
    const change = await featureChange({ 'src/cart.ts': before }, { 'src/cart.ts': after }, repos);
    const symbols = [
      { id: 'src/cart.ts#a', status: 'same' as const, range: { start: 1, end: 3 } },
      { id: 'src/cart.ts#b', status: 'mod' as const, range: { start: 4, end: 6 } },
    ];
    const diff = await computeFileDiff(change.request('src/cart.ts', { symbols, focus: 'src/cart.ts#b' }), change.git);
    expect(diff.rows?.map((row) => `${row.kind[0] ?? ''}:${row.text}`)).toEqual([
      'c:function a() {',
      'c:  return 1;',
      'c:}',
      'c:function b() {',
      'd:  const x = 1;',
      'd:  return x;',
      'a:  return 2;',
      'c:}',
    ]);
    expect(diff.symbols).toEqual([
      { id: 'src/cart.ts#a', first: 0, last: 2 },
      { id: 'src/cart.ts#b', first: 3, last: 7 },
    ]);
    expect(diff.focus).toEqual({ id: 'src/cart.ts#b', first: 3, last: 7 });
  });
});

describe('filediff/symbol-span-del-uses-before-range', () => {
  it('spans a deleted symbol by its before-range, in the removed rows', async () => {
    const before = 'function a() {\n  return 1;\n}\nfunction gone() {\n  return 0;\n}\nfunction c() {\n  return 3;\n}\n';
    const after = 'function a() {\n  return 1;\n}\nfunction c() {\n  return 3;\n}\n';
    const change = await featureChange({ 'src/cart.ts': before }, { 'src/cart.ts': after }, repos);
    const symbols = [
      { id: 'src/cart.ts#gone', status: 'del' as const, range: { start: 4, end: 6 } },
      // After-range: lines 4-6 of the after file (function c), not the deleted function's.
      { id: 'src/cart.ts#c', status: 'same' as const, range: { start: 4, end: 5 } },
    ];
    const diff = await computeFileDiff(change.request('src/cart.ts', { symbols, focus: 'src/cart.ts#gone' }), change.git);
    expect(kinds(diff.rows)).toBe('cccdddccc');
    expect(diff.focus).toEqual({ id: 'src/cart.ts#gone', first: 3, last: 5 });
    expect(diff.symbols).toEqual([
      { id: 'src/cart.ts#gone', first: 3, last: 5 },
      { id: 'src/cart.ts#c', first: 6, last: 7 },
    ]);
  });

  it('skips a range with no line in the rows', () => {
    const rows = [{ old: 1, new: 1 }];
    expect(symbolSpans(rows, [{ id: 'x', status: 'mod', range: { start: 5, end: 9 } }]).size).toBe(0);
  });
});

describe('filediff/rename-old-path', () => {
  it('diffs a renamed and edited file against its old path', async () => {
    const before = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n';
    const after = 'export const a = 1;\nexport const b = 20;\nexport const c = 3;\nexport const d = 4;\n';
    const change = await featureChange({ 'src/old-cart.ts': before }, { 'src/old-cart.ts': null, 'src/cart.ts': after }, repos);
    const diff = await computeFileDiff(change.request('src/cart.ts', { oldPath: 'src/old-cart.ts' }), change.git);
    expect(diff).toMatchObject({ kind: 'text', path: 'src/cart.ts', oldPath: 'src/old-cart.ts', stats: { added: 1, removed: 1 } });
    expect(kinds(diff.rows)).toBe('cdacc');
  });

  it('shows a pure rename as context rows', async () => {
    const text = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';
    const change = await featureChange({ 'src/old-cart.ts': text }, { 'src/old-cart.ts': null, 'src/cart.ts': text }, repos);
    const diff = await computeFileDiff(change.request('src/cart.ts', { oldPath: 'src/old-cart.ts' }), change.git);
    expect(diff).toMatchObject({ kind: 'text', oldPath: 'src/old-cart.ts', stale: false, stats: { added: 0, removed: 0 } });
    expect(kinds(diff.rows)).toBe('ccc');
  });
});

describe('filediff/binary', () => {
  it('answers binary with the sizes and no rows when git sees a NUL byte', async () => {
    const change = await featureChange({ 'README.md': 'docs\n' }, { 'img/logo.bin': 'a\0b\0' }, repos);
    const diff = await computeFileDiff(change.request('img/logo.bin', { language: 'other' }), change.git);
    expect(diff.kind).toBe('binary');
    expect(diff.sizes).toEqual({ before: null, after: 4 });
    expect(diff.rows).toBeUndefined();
  });
});

describe('filediff/too-large-bytes', () => {
  it('answers too-large without rows when a side is over 2 MiB, with the stats of numstat', async () => {
    const big = `${'x'.repeat(1023)}\n`.repeat(2049);
    const change = await featureChange({ 'src/data.ts': 'one\n' }, { 'src/data.ts': big }, repos);
    const diff = await computeFileDiff(change.request('src/data.ts'), change.git);
    expect(diff.kind).toBe('too-large');
    expect(diff.reason).toBeDefined();
    expect(diff.sizes).toEqual({ before: 4, after: big.length });
    expect(diff.stats).toEqual({ added: 2049, removed: 1 });
    expect(diff.rows).toBeUndefined();
  });
});

describe('filediff/too-large-lines', () => {
  it('answers too-large when a side has more than 50,000 lines', async () => {
    const many = lines(50_001);
    const change = await featureChange({ 'src/data.ts': 'one\n' }, { 'src/data.ts': many }, repos);
    const diff = await computeFileDiff(change.request('src/data.ts'), change.git);
    expect(diff.kind).toBe('too-large');
    expect(diff.stats).toEqual({ added: 50_001, removed: 1 });
    expect(diff.rows).toBeUndefined();
  });
});

describe('filediff/long-line-cut', () => {
  it('cuts a row at 4,000 characters, marks it, and still hashes the whole file', async () => {
    const long = `const s = "${'ab'.repeat(3000)}";`;
    const after = `short\n${long}\nend\n`;
    const change = await featureChange({ 'src/a.ts': 'short\n' }, { 'src/a.ts': after }, repos);
    const diff = await computeFileDiff(change.request('src/a.ts'), change.git);
    const cut = diff.rows?.find((row) => row.cut === true);
    expect(cut?.text).toHaveLength(4000);
    expect(cut?.text).toBe(long.slice(0, 4000));
    expect(diff.rows?.filter((row) => row.cut === true)).toHaveLength(1);
    // Highlights stay inside the cut text.
    expect(cut?.hl?.every(([start, end]) => start < end && end <= 4000)).toBe(true);
    expect(diff.stale).toBe(false);
  });
});

describe('filediff/unchanged-file-ctx-only', () => {
  it('returns every line of an untouched file as context', async () => {
    const change = await featureChange({ 'src/cart.ts': lines(12), 'src/other.ts': 'a\n' }, { 'src/other.ts': 'b\n' }, repos);
    const diff = await computeFileDiff(change.request('src/cart.ts'), change.git);
    expect(diff).toMatchObject({ kind: 'unchanged', stale: false, stats: { added: 0, removed: 0 }, sizes: { before: lines(12).length, after: lines(12).length } });
    expect(diff.rows).toHaveLength(12);
    expect(kinds(diff.rows)).toBe('c'.repeat(12));
    expect(diff.rows?.[11]).toMatchObject({ old: 12, new: 12, text: 'line 12' });
  });
});

describe('filediff/highlight-classes-ts', () => {
  it('maps tree-sitter captures to the ten classes, in UTF-16 columns', async () => {
    const source = [
      '// note',
      'export function total(items: number[]): Cart {',
      '  const label = "é😀";',
      '  return items.length + 1;',
      '}',
      '',
    ].join('\n');
    const change = await featureChange({ 'README.md': 'docs\n' }, { 'src/cart.ts': source }, repos);
    const diff = await computeFileDiff(change.request('src/cart.ts'), change.git);
    const hl = (index: number) => diff.rows?.[index]?.hl ?? [];
    expect(hl(0)).toEqual([[0, 7, 'com']]);
    const classes = new Set(diff.rows?.flatMap((row) => (row.hl ?? []).map(([, , cls]) => cls)));
    for (const cls of ['kw', 'str', 'num', 'com', 'type', 'fn', 'prop', 'op', 'punc', 'var']) expect(classes).toContain(cls);
    // `"é😀"` starts at column 16: two quotes, é and a surrogate pair make 5 UTF-16 units.
    expect(hl(2)).toContainEqual([16, 21, 'str']);
    expect(hl(1)).toContainEqual([16, 21, 'fn']);
  });

  it('highlights a removed row from the before text', async () => {
    const change = await featureChange({ 'src/a.ts': 'const old = 1;\nkeep();\n' }, { 'src/a.ts': 'keep();\n' }, repos);
    const diff = await computeFileDiff(change.request('src/a.ts'), change.git);
    expect(diff.rows?.[0]).toMatchObject({ kind: 'del', text: 'const old = 1;' });
    expect(diff.rows?.[0]?.hl).toContainEqual([0, 5, 'kw']);
  });

  it('gives other languages no highlights', async () => {
    const change = await featureChange({ 'README.md': 'docs\n' }, { 'query.sql': 'select 1;\n' }, repos);
    const diff = await computeFileDiff(change.request('query.sql', { language: 'sql' }), change.git);
    expect(diff.kind).toBe('text');
    expect(diff.rows?.some((row) => row.hl !== undefined)).toBe(false);
  });
});

describe('filediff/no-highlight-over-512k', () => {
  it('leaves the rows without hl when a side is over 512 KiB', async () => {
    const big = 'const value = 1;\n'.repeat(Math.ceil((512 * 1024 + 1) / 17));
    expect(big.length).toBeGreaterThan(512 * 1024);
    const change = await featureChange({ 'README.md': 'docs\n' }, { 'src/big.ts': big }, repos);
    const diff = await computeFileDiff(change.request('src/big.ts'), change.git);
    expect(diff.kind).toBe('text');
    expect(diff.rows?.length).toBeGreaterThan(30_000);
    expect(diff.rows?.some((row) => row.hl !== undefined)).toBe(false);
  });
});

describe('filediff/stale-worktree', () => {
  it('is stale when the working tree changed after the snapshot, and not otherwise', async () => {
    const before = lines(6);
    const snapshotted = lines(6, { 3: 'three' });
    const change = await featureChange({ 'src/cart.ts': before }, { 'src/other.ts': 'x\n' }, repos);
    await change.repo.git('checkout', '--quiet', 'main');
    await change.repo.write({ 'src/cart.ts': snapshotted });
    const request = change.request('src/cart.ts', { worktree: true, after: snapshotted });
    const fresh = await computeFileDiff({ ...request, mergeBase: await change.repo.head() }, change.git);
    expect(fresh).toMatchObject({ kind: 'text', stale: false, stats: { added: 1, removed: 1 } });

    await change.repo.write({ 'src/cart.ts': lines(6, { 3: 'three', 5: 'five' }) });
    const stale = await computeFileDiff({ ...request, mergeBase: await change.repo.head() }, change.git);
    expect(stale).toMatchObject({ kind: 'text', stale: true, stats: { added: 2, removed: 2 } });
  });

  it('diffs an untracked new file and a file without a trailing newline', async () => {
    const change = await featureChange({ 'README.md': 'docs\n' }, { 'README.md': 'docs\n' }, repos);
    await change.repo.git('checkout', '--quiet', 'main');
    await change.repo.write({ 'src/new.ts': 'a\nb' });
    const mergeBase = await change.repo.head();
    const request = { ...change.request('src/new.ts', { worktree: true, after: 'a\nb' }), mergeBase };
    const diff = await computeFileDiff(request, change.git);
    expect(diff).toMatchObject({ kind: 'text', stale: false, stats: { added: 2, removed: 0 }, sizes: { before: null, after: 3 } });
    expect(sha('a\nb')).toBe(request.fingerprint.after);
  });
});

describe('filediff/untracked-unreadable-unavailable', () => {
  it('is unavailable, not an empty unchanged file, when the temporary index of an untracked file cannot be made', async () => {
    const change = await featureChange({ 'README.md': 'docs\n' }, { 'README.md': 'docs\n' }, repos);
    await change.repo.git('checkout', '--quiet', 'main');
    await change.repo.write({ 'src/new.ts': 'a\nb\n' });
    const mergeBase = await change.repo.head();
    const request = { ...change.request('src/new.ts', { worktree: true, after: 'a\nb\n' }), mergeBase };
    const noIndex = { ...change.git, withUntrackedIndex: <T>(_paths: readonly string[], fn: (env: Record<string, string> | undefined) => Promise<T>) => fn(undefined) };
    const diff = await computeFileDiff(request, noIndex);
    expect(diff.kind).toBe('unavailable');
    expect(diff.reason).toBeDefined();
    expect(diff.rows).toBeUndefined();
  });
});

describe('filediff/unavailable', () => {
  it('is unavailable without a merge-base and when git cannot read the object', async () => {
    const change = await featureChange({ 'src/cart.ts': lines(3) }, { 'src/cart.ts': lines(3, { 1: 'x' }) }, repos);
    const request = change.request('src/cart.ts');
    expect(await computeFileDiff({ ...request, mergeBase: null }, change.git)).toMatchObject({ kind: 'unavailable', reason: expect.any(String) as string });
    const missing = await computeFileDiff({ ...request, mergeBase: '0123456789abcdef0123456789abcdef01234567' }, change.git);
    expect(missing.kind).toBe('unavailable');
    expect(missing.rows).toBeUndefined();
  });
});

describe('parseUnifiedDiff', () => {
  it('takes a content line that looks like a header for content', () => {
    const output = Buffer.from('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-@@ -9 +9 @@\n+--- a/y\n ctx\n\\ No newline at end of file\n');
    const parsed = parseUnifiedDiff(output);
    expect(parsed.rows.map((row) => [row.kind, row.bytes.toString()])).toEqual([
      ['del', '@@ -9 +9 @@'],
      ['add', '--- a/y'],
      ['ctx', 'ctx'],
    ]);
    expect(parsed.noEolAfter).toBe(true);
    expect(parsed.noEolBefore).toBe(true);
  });
});

describe('git output limit', () => {
  it('stops git and rejects with output-limit when stdout passes maxOutput', async () => {
    const change = await featureChange({ 'src/cart.ts': lines(3) }, { 'src/cart.ts': lines(4) }, repos);
    await expect(change.git.run(['rev-parse', 'HEAD'], { maxOutput: 5 })).rejects.toMatchObject({ code: 'output-limit' });
    expect((await change.git.run(['rev-parse', 'HEAD'], { maxOutput: 1000 })).exitCode).toBe(0);
  });
});
