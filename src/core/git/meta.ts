// Report meta for a resolved change (ADR-012).

import { basename } from 'node:path';
import type { Report } from '../report/types.js';
import type { ResolvedChange } from './change.js';
import { git } from './exec.js';

/** Commits in `mergeBase..headCommit`. */
export async function countCommits(change: ResolvedChange): Promise<number> {
  const output = await git(change.root, ['rev-list', '--count', `${change.mergeBase}..${change.headCommit}`]);
  return Number.parseInt(output.trim(), 10);
}

export async function computeMeta(change: ResolvedChange, now: Date = new Date()): Promise<Report['meta']> {
  return {
    repo: basename(change.root),
    base: change.base.name,
    head: change.head,
    commits: await countCommits(change),
    generatedAt: now.toISOString(),
  };
}
