import { realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { checkoutRepo, cleanupRepos, collect, sampleShop } from './collect-helper.js';

isolateGitConfig();
cleanupRepos();

describe('working trees (L1)', () => {
  it('changes/draft-on-base (L1): a dirty tree on the base is a Draft', async () => {
    const repo = await sampleShop();
    await repo.write({ 'src/cart.ts': 'export const items: string[] = ["tea"];\n' });
    const { plan } = await collect(repo);
    expect(plan.create).toEqual([
      expect.objectContaining({
        kind: 'draft',
        ref: 'draft:.',
        head: await repo.head(),
        dirty: true,
        worktreePath: await realpath(repo.dir),
        title: 'Uncommitted changes on main',
        ahead: 0,
        behind: 0,
      }),
    ]);
  });

  it('an untracked file alone makes the tree dirty', async () => {
    const repo = await sampleShop();
    await repo.write({ 'src/coupon.ts': 'export const coupon = 1;\n' });
    expect((await collect(repo)).discovered.worktrees[0]?.dirty).toBe(true);
  });

  it('a clean tree on the base produces no change', async () => {
    const repo = await sampleShop();
    expect((await collect(repo)).plan.create).toEqual([]);
  });

  it('changes/draft-on-branch-folds (L1, L4, Q2): dirty on a branch with commits ahead is one change, dirty', async () => {
    const { repo, tip } = await checkoutRepo();
    await repo.checkout('feature/checkout');
    await repo.write({ 'src/checkout.ts': 'export const total = 1;\n' });
    const { plan } = await collect(repo);
    expect(plan.create).toEqual([
      expect.objectContaining({ kind: 'branch', ref: 'branch:feature/checkout', head: tip, dirty: true, worktreePath: await realpath(repo.dir) }),
    ]);
  });

  it('changes/draft-detached (L1, Q2): dirty on a detached HEAD is a Draft', async () => {
    const { repo, tip } = await checkoutRepo();
    await repo.git('checkout', '--quiet', '--detach', tip);
    await repo.git('branch', '-D', 'feature/checkout');
    await repo.write({ 'src/checkout.ts': 'export const total = 2;\n' });
    const { plan } = await collect(repo);
    expect(plan.create).toEqual([
      expect.objectContaining({ kind: 'draft', head: tip, title: 'Uncommitted changes', ahead: 2, behind: 1 }),
    ]);
  });

  it('changes/linked-worktree-same-repo (L1, Q2): a linked worktree is a working tree of the same repo', async () => {
    const repo = await sampleShop();
    const linked = join(dirname(await realpath(repo.dir)), 'sample-shop-agent');
    await repo.git('worktree', 'add', '--quiet', '--detach', linked);
    await writeFile(join(linked, 'src/cart.ts'), 'export const items: string[] = ["agent"];\n');
    const { discovered, plan } = await collect(repo);
    expect(discovered.worktrees.map((tree) => [tree.path, tree.dirty])).toEqual([
      [await realpath(repo.dir), false],
      [linked, true],
    ]);
    expect(plan.create).toEqual([
      expect.objectContaining({ kind: 'draft', ref: 'draft:../sample-shop-agent', worktreePath: linked, title: 'Uncommitted changes' }),
    ]);
  });

  it('changes/two-dirty-worktrees-same-head (L4, Q2): two dirty trees at the same HEAD are two Drafts', async () => {
    const repo = await sampleShop();
    const linked = join(dirname(await realpath(repo.dir)), 'sample-shop-agent');
    await repo.git('worktree', 'add', '--quiet', '--detach', linked);
    await repo.write({ 'src/cart.ts': 'export const items: string[] = ["main"];\n' });
    await writeFile(join(linked, 'src/cart.ts'), 'export const items: string[] = ["agent"];\n');
    const { plan } = await collect(repo);
    expect(plan.create.map((change) => [change.kind, change.ref, change.head])).toEqual([
      ['draft', 'draft:.', await repo.head()],
      ['draft', 'draft:../sample-shop-agent', await repo.head()],
    ]);
  });

  it('a prunable worktree (its directory removed) is skipped', async () => {
    const repo = await sampleShop();
    const linked = join(dirname(await realpath(repo.dir)), 'sample-shop-gone');
    await repo.git('worktree', 'add', '--quiet', '--detach', linked);
    await rm(linked, { recursive: true, force: true });
    const { discovered } = await collect(repo);
    expect(discovered.worktrees.map((tree) => tree.path)).toEqual([await realpath(repo.dir)]);
  });
});
