// Small builders for the pure change-list tests: invented shas, paths and names.

import type { BranchInfo, Discovered, PrInfo, WorktreeInfo } from '../../../src/core/changes/types.js';
import type { ChangeRecord } from '../../../src/core/model/types.js';

export const REPO = '/work/sample-shop';
export const NOW = new Date('2026-03-10T12:00:00.000Z');
export const NOW_ISO = NOW.toISOString();

/** A 40-character fake sha built from a short label. */
export function sha(label: string): string {
  return label.padEnd(40, '0').replace(/[^0-9a-f]/g, 'f');
}

export const BASE_TIP = sha('ba5e');

export function worktree(partial: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: REPO,
    head: BASE_TIP,
    branch: 'main',
    dirty: false,
    ahead: 0,
    behind: 0,
    committedAt: '2026-03-01T09:00:00.000Z',
    ...partial,
  };
}

export function branch(name: string, head: string, partial: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name,
    head,
    ahead: 2,
    behind: 0,
    title: `first commit of ${name}`,
    committedAt: '2026-03-05T10:00:00.000Z',
    ...partial,
  };
}

export function pr(number: number, head: string, partial: Partial<PrInfo> = {}): PrInfo {
  return {
    number,
    title: `PR title ${String(number)}`,
    headRefName: `feature/pr-${String(number)}`,
    headRefOid: head,
    baseRefName: 'main',
    isCrossRepository: false,
    headAvailable: true,
    ahead: 3,
    behind: 1,
    committedAt: '2026-03-06T10:00:00.000Z',
    ...partial,
  };
}

export function discovered(partial: Partial<Discovered> = {}): Discovered {
  const branches = partial.branches ?? [];
  return {
    repoPath: REPO,
    base: 'main',
    worktrees: [worktree()],
    branches,
    localBranches: ['main', ...branches.map((b) => b.name)],
    prs: { available: true, open: [], states: {} },
    ...partial,
  };
}

let nextId = 1;

export function record(partial: Partial<ChangeRecord> = {}): ChangeRecord {
  const id = partial.id ?? nextId++;
  return {
    id,
    repoId: 7,
    kind: 'branch',
    ref: `branch:feature/r${String(id)}`,
    prNumber: null,
    head: sha(`c${String(id)}`),
    headAvailable: true,
    dirty: false,
    worktreePath: null,
    base: 'main',
    title: 'stored title',
    ahead: 1,
    behind: 0,
    reviewState: 'unreviewed',
    lastEventType: 'commit',
    lastEventAt: '2026-03-02T08:00:00.000Z',
    updatedAt: '2026-03-02T08:00:00.000Z',
    archivedAt: null,
    archiveReason: null,
    ...partial,
  };
}
