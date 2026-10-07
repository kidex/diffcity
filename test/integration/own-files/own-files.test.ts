// diffcity's own files are never part of a change (SPEC.md section 3a,
// ADR-036 Q6): `.diffcity/findings.json` and `.diffcity/fix-queue.json` are
// left out of the touched files (diff against the base, untracked listing) and
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

const QUEUE = '{\n  "version": 1,\n  "items": []\n}\n';
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
    await repo.write({ '.diffcity/findings.json': FINDINGS, '.diffcity/fix-queue.json': QUEUE, '.diffcity/.fix-queue.json.4242.0123456789ab.tmp': QUEUE });
    expect(await touched(repo)).toEqual(['src/cart/total.ts']);
    expect(await dirty(repo)).toBe(false);
    const change = await resolveChange(repo.dir, { base: 'main' });
    expect(await listHeadFiles(change)).not.toContain('.diffcity/fix-queue.json');
  });

  it('own-files/not-in-touched-files (committed): own files committed on the branch or edited in place are left out too', async () => {
    const repo = await shopOnBranch();
    const head = await repo.commit('keep the queue', { '.diffcity/fix-queue.json': QUEUE, '.diffcity/findings.json': FINDINGS });
    expect(await touched(repo, head)).toEqual(['src/cart/total.ts']);
    await repo.write({ '.diffcity/fix-queue.json': '{\n  "version": 1,\n  "items": [{ "key": "f:0" }]\n}\n', '.diffcity/findings.json': null });
    expect(await touched(repo)).toEqual(['src/cart/total.ts']);
    expect(await dirty(repo)).toBe(false);
  });

  it('own-files/not-in-touched-files (base): on the base, own files alone make no Draft', async () => {
    const repo = await createRepo({ name: 'sample-shop', files: { 'README.md': '# sample-shop\n' } });
    repos.push(repo);
    await repo.write({ '.diffcity/fix-queue.json': QUEUE });
    expect(await dirty(repo)).toBe(false);
    expect(await touched(repo)).toEqual([]);
  });

  it('own-files/spec-md-is-a-normal-file: .diffcity/spec.md is a touched file and makes the tree dirty', async () => {
    const repo = await shopOnBranch();
    await repo.write({ '.diffcity/fix-queue.json': QUEUE, '.diffcity/spec.md': '# Totals\n\nThe total sums the items.\n' });
    expect(await touched(repo)).toEqual(['.diffcity/spec.md', 'src/cart/total.ts']);
    expect(await dirty(repo)).toBe(true);
  });

  it('own-files only at the root: a nested .diffcity/findings.json is a normal file', async () => {
    const repo = await shopOnBranch();
    await repo.write({ 'packages/cart/.diffcity/findings.json': FINDINGS });
    expect(await touched(repo)).toEqual(['packages/cart/.diffcity/findings.json', 'src/cart/total.ts']);
    expect(await dirty(repo)).toBe(true);
  });

  it('a tracked file next to the own files keeps the tree dirty', async () => {
    const repo = await shopOnBranch();
    await repo.write({ '.diffcity/fix-queue.json': QUEUE, 'README.md': '# sample-shop, edited\n' });
    expect(await dirty(repo)).toBe(true);
  });
});

describe('porcelainPaths', () => {
  it('reads plain entries, untracked directories, and skips the original path of a rename', () => {
    const output = ' M src/a.ts\0?? .diffcity/\0R  src/new.ts\0src/old.ts\0?? notes.md\0';
    expect(porcelainPaths(output)).toEqual(['src/a.ts', '.diffcity/', 'src/new.ts', 'notes.md']);
  });
});
