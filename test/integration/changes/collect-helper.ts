// Shared setup for the change-list integration tests: temp repos named
// sample-shop, and one collection = identity + base + sources + reconcile.

import { afterEach } from 'vitest';
import { identifyRepo } from '../../../src/core/changes/identity.js';
import { reconcile } from '../../../src/core/changes/reconcile.js';
import { collectSources, detectBase, type GhPullRequest } from '../../../src/core/changes/sources.js';
import type { ChangePlan, Discovered } from '../../../src/core/changes/types.js';
import type { CommandRunner } from '../../../src/core/git/index.js';
import type { ChangeRecord } from '../../../src/core/model/types.js';
import { ghForbidden } from '../../helpers/git-env.js';
import { createRepo, type CreateRepoOptions, type TempRepo } from '../../helpers/repo.js';

export const NOW = new Date('2026-02-01T00:00:00.000Z');
/** A commit sha that exists in no test repo. */
export const NOT_LOCAL = 'deadbeef'.repeat(5);

const repos: TempRepo[] = [];

/** Registers an afterEach that removes the repos created by sampleShop(). */
export function cleanupRepos(): void {
  afterEach(async () => {
    while (repos.length > 0) await repos.pop()?.cleanup();
  });
}

export async function sampleShop(options: CreateRepoOptions = {}): Promise<TempRepo> {
  const repo = await createRepo({
    name: 'sample-shop',
    files: { 'src/cart.ts': 'export const items: string[] = [];\n', 'README.md': '# sample-shop\n' },
    ...options,
  });
  repos.push(repo);
  return repo;
}

export interface CollectOptions {
  openPrs?: GhPullRequest[] | null;
  live?: ChangeRecord[];
  archived?: ChangeRecord[];
  runner?: CommandRunner;
}

export async function collect(repo: TempRepo, options: CollectOptions = {}): Promise<{ discovered: Discovered; plan: ChangePlan }> {
  const identity = await identifyRepo(repo.dir);
  const runner = options.runner ?? ghForbidden().runner;
  const base = await detectBase(identity, { runner });
  const live = options.live ?? [];
  const discovered = await collectSources(identity, {
    base,
    openPrs: options.openPrs ?? null,
    livePrNumbers: live.flatMap((change) => (change.prNumber === null ? [] : [change.prNumber])),
    runner,
  });
  return { discovered, plan: reconcile(live, options.archived ?? [], discovered, NOW) };
}

/** Stores the created changes as live records, the way the daemon's applyPlan would. */
export function stored(plan: ChangePlan): ChangeRecord[] {
  return plan.create.map((fields, index) => ({
    ...fields,
    id: index + 1,
    repoId: 1,
    updatedAt: NOW.toISOString(),
    archivedAt: null,
    archiveReason: null,
  }));
}

export function ghPr(number: number, headRefOid: string, partial: Partial<GhPullRequest> = {}): GhPullRequest {
  return {
    number,
    title: `Checkout flow ${String(number)}`,
    headRefName: 'feature/checkout',
    headRefOid,
    baseRefName: 'main',
    isCrossRepository: false,
    ...partial,
  };
}

/** A live PR whose head was never fetched. */
export function remotePr(number: number): ChangeRecord {
  return {
    id: 3,
    repoId: 1,
    kind: 'pr',
    ref: `pr:${String(number)}`,
    prNumber: number,
    head: NOT_LOCAL,
    headAvailable: false,
    dirty: false,
    worktreePath: null,
    base: 'main',
    title: 'Remote only',
    ahead: null,
    behind: null,
    reviewState: 'unreviewed',
    lastEventType: 'commit',
    lastEventAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archivedAt: null,
    archiveReason: null,
  };
}

/** A repo with `feature/checkout` two commits ahead of main and main one commit ahead of the fork point. */
export async function checkoutRepo(): Promise<{ repo: TempRepo; tip: string }> {
  const repo = await sampleShop();
  await repo.branch('feature/checkout');
  await repo.commit('add checkout total', { 'src/checkout.ts': 'export const total = 0;\n' });
  const tip = await repo.commit('round the checkout total', { 'src/checkout.ts': 'export const total = Math.round(0);\n' });
  await repo.checkout('main');
  await repo.commit('update readme', { 'README.md': '# sample-shop\n\nA shop.\n' });
  return { repo, tip };
}
