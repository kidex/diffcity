// The snapshot pool with both runners (ADR-021): the same snapshot inline and
// in a worker thread loaded from dist/ (built by test/global-setup.ts).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSnapshotPool, SNAPSHOT_WORKER_URL, type SnapshotPool } from '../../../src/daemon/collector/snapshot-pool.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const repos: TempRepo[] = [];
const pools: SnapshotPool[] = [];
afterEach(async () => {
  while (pools.length > 0) await pools.pop()?.shutdown();
  while (repos.length > 0) await repos.pop()?.cleanup();
});

async function sampleShop(): Promise<{ repo: TempRepo; tip: string }> {
  const repo = await createRepo({ name: 'sample-shop', files: { 'src/cart/total.ts': 'export const total = 0;\n' } });
  repos.push(repo);
  await repo.branch('feature/checkout');
  const tip = await repo.commit('add the checkout', {
    'src/cart/total.ts': 'export function total(): number {\n  return 1;\n}\n',
    'src/checkout/pay.ts': 'export class Pay {\n  run(): void {}\n}\n',
  });
  return { repo, tip };
}

describe('snapshot pool runners', () => {
  it('pool/thread-runner-dist: the default worker URL is the built dist/daemon/collector/worker.js', () => {
    const path = fileURLToPath(SNAPSHOT_WORKER_URL);
    expect(path.endsWith(['dist', 'daemon', 'collector', 'worker.js'].join('/'))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('pool/inline-runner: the same snapshot inline and in a thread', async () => {
    const { repo, tip } = await sampleShop();
    const input = { repoDir: repo.dir, base: 'main', head: tip, now: '2026-03-04T05:06:07.000Z' };
    const inline = createSnapshotPool({ runner: 'inline', size: 1 });
    const thread = createSnapshotPool({ runner: 'thread', size: 1 });
    pools.push(inline, thread);
    const [a, b] = await Promise.all([inline.submit('1:1', 'high', input), thread.submit('1:1', 'high', input)]);
    expect(b).toEqual(a);
    expect(a.touched).toEqual(['src/cart/total.ts', 'src/checkout/pay.ts']);
    expect(thread.workers).toBe(1);
  });

  it('a failing computation in a thread rejects with its message and keeps the daemon alive', async () => {
    const { repo } = await sampleShop();
    const thread = createSnapshotPool({ runner: 'thread', size: 1 });
    pools.push(thread);
    await expect(thread.submit('1:1', 'high', { repoDir: repo.dir, base: 'no-such-base', head: 'HEAD' })).rejects.toThrow(
      /base ref not found: no-such-base/,
    );
  });
});
