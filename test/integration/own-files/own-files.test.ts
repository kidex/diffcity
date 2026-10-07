// diffcity's own files are never part of a change (SPEC.md section 3a,
// ADR-036, DC-112): `.diffcity/findings.json` and the fix queue directories
// `.diffcity/fix-queue/` and `.diffcity/fix-queue.taking/` are left out of the touched files (diff against the base, untracked listing) and
// of the dirty check, committed or not. `.diffcity/spec.md` and every other
// file are normal files.

import { afterEach, describe, expect, it } from 'vitest';
import { identifyRepo, listWorktrees } from '../../../src/core/changes/index.js';
import { changedFiles, listHeadFiles, resolveBase, resolveChange } from '../../../src/core/git/index.js';
import { porcelainPaths } from '../../../src/core/changes/sources.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.cleanup();
});

const ITEM = '{\n  "key": "f:0000000000000001",\n  "file": "src/cart/total.ts",\n  "line": 2\n}\n';
const QUEUED = '.diffcity/fix-queue/0123456789abcdef0123456789abcdef.json';
const TEMP = '.diffcity/.fix-queue.0123456789abcdef0123456789abcdef.4242.0123456789ab.tmp';
const TAKEN = '.diffcity/fix-queue.taking/fedcba9876543210fedcba9876543210.json';
const FINDINGS = '[]\n';

async function shopOnBranch(): Promise<TempRepo> {
  const repo = await createRepo({
    name: 'sample-shop',
    files: { 'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.length;\n}\n', 'README.md': '# sample-shop\n' },
  });
  repos.push(repo);
  await repo.branch('feature/totals');
  await repo.commit('sum the cart', { 'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n' });
  return repo;
}

async function touched(repo: TempRepo, head?: string): Promise<string[]> {
  const change = await resolveChange(repo.dir, { base: 'main', head });
  return (await changedFiles(change)).map((file) => file.path);
}

async function dirty(repo: TempRepo): Promise<boolean> {
  const identity = await identifyRepo(repo.dir);
  const base = await resolveBase(identity.path, { flag: 'main' });
  const [tree] = await listWorktrees(identity, base);
  if (tree === undefined) throw new Error('no working tree listed');
  return tree.dirty;
}

describe('own files in git (SPEC.md section 3a)', () => {
  it('own-files/not-in-touched-files: untracked own files are not touched files and leave the working tree clean', async () => {
    const repo = await shopOnBranch();
    await repo.write({ '.diffcity/findings.json': FINDINGS, [QUEUED]: ITEM, [TEMP]: ITEM, [TAKEN]: ITEM });
    expect(await touched(repo)).toEqual(['src/cart/total.ts']);
    expect(await dirty(repo)).toBe(false);
    const change = await resolveChange(repo.dir, { base: 'main' });
    expect(await listHeadFiles(change)).not.toContain(QUEUED);
  });

  it('own-files/not-in-touched-files (committed): own files committed on the branch or edited in place are left out too', async () => {
    const repo = await shopOnBranch();
    const head = await repo.commit('keep the queue', { [QUEUED]: ITEM, '.diffcity/findings.json': FINDINGS });
    expect(await touched(repo, head)).toEqual(['src/cart/total.ts']);
    await repo.write({ [QUEUED]: null, [TAKEN]: ITEM, '.diffcity/findings.json': null });
    expect(await touched(repo)).toEqual(['src/cart/total.ts']);
    expect(await dirty(repo)).toBe(false);
  });

  it('own-files/not-in-touched-files (base): on the base, own files alone make no Draft', async () => {
    const repo = await createRepo({ name: 'sample-shop', files: { 'README.md': '# sample-shop\n' } });
    repos.push(repo);
    await repo.write({ [QUEUED]: ITEM });
    expect(await dirty(repo)).toBe(false);
    expect(await touched(repo)).toEqual([]);
  });

  it('own-files/spec-md-is-a-normal-file: .diffcity/spec.md is a touched file and makes the tree dirty', async () => {
    const repo = await shopOnBranch();
    await repo.write({ [QUEUED]: ITEM, '.diffcity/spec.md': '# Totals\n\nThe total sums the items.\n' });
    expect(await touched(repo)).toEqual(['.diffcity/spec.md', 'src/cart/total.ts']);
    expect(await dirty(repo)).toBe(true);
  });

  it('own-files/taking-dir-is-own: the queue renamed to fix-queue.taking/ by /diffcity-review is no touched file and leaves the tree clean', async () => {
    const repo = await shopOnBranch();
    await repo.write({ [TAKEN]: ITEM });
    expect(await touched(repo)).toEqual(['src/cart/total.ts']);
    expect(await dirty(repo)).toBe(false);
    const head = await repo.commit('keep the taken queue', { [TAKEN]: ITEM });
    expect(await touched(repo, head)).toEqual(['src/cart/total.ts']);
  });

  it('own-files/single-file-queue-is-normal: the single-file queue of the first design and look-alike names are normal files', async () => {
    const repo = await shopOnBranch();
    await repo.write({ '.diffcity/fix-queue.json': '{"version":1,"items":[]}\n', '.diffcity/fix-queue.bak/a.json': ITEM });
    expect(await touched(repo)).toEqual(['.diffcity/fix-queue.bak/a.json', '.diffcity/fix-queue.json', 'src/cart/total.ts']);
    expect(await dirty(repo)).toBe(true);
  });

  it('own-files only at the root: a nested fix queue directory is a normal file', async () => {
    const repo = await shopOnBranch();
    await repo.write({ 'packages/cart/.diffcity/fix-queue/0123456789abcdef0123456789abcdef.json': ITEM });
    expect(await touched(repo)).toEqual(['packages/cart/.diffcity/fix-queue/0123456789abcdef0123456789abcdef.json', 'src/cart/total.ts']);
  });

  it('own-files only at the root: a nested .diffcity/findings.json is a normal file', async () => {
    const repo = await shopOnBranch();
    await repo.write({ 'packages/cart/.diffcity/findings.json': FINDINGS });
    expect(await touched(repo)).toEqual(['packages/cart/.diffcity/findings.json', 'src/cart/total.ts']);
    expect(await dirty(repo)).toBe(true);
  });

  it('a tracked file next to the own files keeps the tree dirty', async () => {
    const repo = await shopOnBranch();
    await repo.write({ [QUEUED]: ITEM, 'README.md': '# sample-shop, edited\n' });
    expect(await dirty(repo)).toBe(true);
  });
});

describe('porcelainPaths', () => {
  it('reads plain entries, untracked directories, and skips the original path of a rename', () => {
    const output = ' M src/a.ts\0?? .diffcity/\0R  src/new.ts\0src/old.ts\0?? notes.md\0';
    expect(porcelainPaths(output)).toEqual(['src/a.ts', '.diffcity/', 'src/new.ts', 'notes.md']);
  });
});
