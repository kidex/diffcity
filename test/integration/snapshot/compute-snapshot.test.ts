// computeSnapshot (ADR-021) over a temp repo: the branch head and the working
// tree, the content hash stable across times, the repo config only when trusted.

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
    const snapshot = await computeSnapshot({ repoDir: repo.dir, base: 'main', head: tip, now: '2026-03-04T05:06:07.000Z', trustConfig: false });
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
    const first = await computeSnapshot({ repoDir: repo.dir, base: 'main', head: tip, now: '2026-03-04T05:06:07.000Z', trustConfig: false });
    const second = await computeSnapshot({ repoDir: repo.dir, base: 'main', head: tip, now: '2026-03-09T00:00:00.000Z', trustConfig: false });
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.reportJson).not.toBe(first.reportJson);
  });

  it('the working tree: uncommitted edits are part of the content, the head is HEAD', async () => {
    const { repo, tip } = await sampleShop();
    const clean = await computeSnapshot({ repoDir: repo.dir, base: 'main', trustConfig: false });
    await repo.write({ 'src/cart/line.ts': 'export const line = 2;\n' });
    const dirty = await computeSnapshot({ repoDir: repo.dir, base: 'main', trustConfig: false });
    expect(dirty.headCommit).toBe(tip);
    expect(dirty.touched).toEqual(['src/cart/line.ts', 'src/cart/total.ts', 'src/session/token.ts']);
    expect(dirty.contentHash).not.toBe(clean.contentHash);
  });

  it('snapshot/config-trust: the tier 1 override of diffcity.config.js applies only when the repo is trusted (ADR-030)', async () => {
    const { repo, tip } = await sampleShop();
    await repo.write({ 'diffcity.config.js': "export default { tier1: ['cart'] };\n" });
    const input = { repoDir: repo.dir, base: 'main', head: tip, now: '2026-03-04T05:06:07.000Z' };
    const untrusted = await computeSnapshot({ ...input, trustConfig: false });
    expect(untrusted.summary.tier1Files).toEqual(['src/session/token.ts']);
    const trusted = await computeSnapshot({ ...input, trustConfig: true });
    expect(trusted.summary.tier1Files).toEqual(['src/cart/total.ts']);
  });
});
