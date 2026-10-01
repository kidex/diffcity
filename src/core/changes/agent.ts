// `track --agent` (SPEC.md section 3a C3, ADR-001, ADR-019): after a collection,
// the change of the working tree the agent worked in becomes "agent worked, not
// reviewed" (`reviewState: 'unreviewed'`, last event `agent`). With no change
// there (a clean working tree on the base), only a repo-level event is written.

import { sep } from 'node:path';
import type { ChangeRecord } from '../model/types.js';
import { storedFields } from './reconcile.js';
import type { ChangeUpdate, WorktreeInfo } from './types.js';

export interface AgentEvent {
  /** Null for a repo-level event. */
  changeId: number | null;
  type: 'agent';
  at: string;
  payload: { worktree: string };
}

export interface AgentOutcome {
  update: ChangeUpdate | null;
  event: AgentEvent;
}

/** The innermost working tree containing `dir` (both realpaths), or null. */
export function worktreeContaining<T extends Pick<WorktreeInfo, 'path'>>(worktrees: readonly T[], dir: string): T | null {
  let best: T | null = null;
  for (const tree of worktrees) {
    const inside = dir === tree.path || dir.startsWith(tree.path.endsWith(sep) ? tree.path : tree.path + sep);
    if (inside && (best === null || tree.path.length > best.path.length)) best = tree;
  }
  return best;
}

/**
 * Marks the change of `worktree`: the live change recorded on that working tree,
 * else the PR or Branch at its HEAD. `at` is the time of the request.
 */
export function applyAgent(
  live: readonly ChangeRecord[],
  worktree: Pick<WorktreeInfo, 'path' | 'head'>,
  at: string,
): AgentOutcome {
  const change =
    live.find((candidate) => candidate.worktreePath === worktree.path) ??
    live.find((candidate) => candidate.kind !== 'draft' && candidate.head === worktree.head) ??
    null;
  const payload = { worktree: worktree.path };
  if (change === null) return { update: null, event: { changeId: null, type: 'agent', at, payload } };
  return {
    update: {
      id: change.id,
      fields: { ...storedFields(change), reviewState: 'unreviewed', lastEventType: 'agent', lastEventAt: at, updatedAt: at },
    },
    event: { changeId: change.id, type: 'agent', at, payload },
  };
}
