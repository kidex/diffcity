// computeSnapshot (ADR-021) over a temp repo: the branch head and the working
// tree, the content hash stable across times.

import { afterEach, describe, expect, it } from 'vitest';
import { computeSnapshot } from '../../../src/core/report/snapshot.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const repos: TempRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

async function sampleShop(): Promise<{ repo: TempRepo; tip: string }> {
  const repo = await createRepo({
    name: 'sample-shop',
    files: {
      'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.length;\n}\n',
      'src/cart/line.ts': 'export const line = 1;\n',
    },
  });
  repos.push(repo);
  await repo.branch('feature/checkout');
  const tip = await repo.commit('sum the cart', {
    'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n',
    'src/session/token.ts': 'export const token = "";\n',
  });
  return { repo, tip };
}

describe('computeSnapshot', () => {
  it('snapshot/summary-and-touched: a branch head', async () => {
    const { repo, tip } = await sampleShop();
    await repo.checkout('main');
    const snapshot = await computeSnapshot({ repoDir: repo.dir, base: 'main', head: tip, now: '2026-03-04T05:06:07.000Z' });
    expect(snapshot.headCommit).toBe(tip);
    expect(snapshot.touched).toEqual(['src/cart/total.ts', 'src/session/token.ts']);
    expect(snapshot.summary.touchedFiles).toBe(2);
    expect(snapshot.summary.files).toBe(3);
    expect(snapshot.summary.tier1Files).toEqual(['src/session/token.ts']);
    const report = JSON.parse(snapshot.reportJson) as { meta: { generatedAt: string; head: string } };
    expect(report.meta.generatedAt).toBe('2026-03-04T05:06:07.000Z');
  });

  it('snapshot/content-hash-ignores-generated-at: two computations at different times', async () => {
    const { repo, tip } = await sampleShop();
    const first = await computeSnapshot({ repoDir: repo.dir, base: 'main', head: tip, now: '2026-03-04T05:06:07.000Z' });
    const second = await computeSnapshot({ repoDir: repo.dir, base: 'main', head: tip, now: '2026-03-09T00:00:00.000Z' });
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.reportJson).not.toBe(first.reportJson);
  });

  it('the working tree: uncommitted edits are part of the content, the head is HEAD', async () => {
    const { repo, tip } = await sampleShop();
    const clean = await computeSnapshot({ repoDir: repo.dir, base: 'main' });
    await repo.write({ 'src/cart/line.ts': 'export const line = 2;\n' });
    const dirty = await computeSnapshot({ repoDir: repo.dir, base: 'main' });
    expect(dirty.headCommit).toBe(tip);
    expect(dirty.touched).toEqual(['src/cart/line.ts', 'src/cart/total.ts', 'src/session/token.ts']);
    expect(dirty.contentHash).not.toBe(clean.contentHash);
  });
});
