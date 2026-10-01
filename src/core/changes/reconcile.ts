// The change list of a repo (SPEC.md section 3a, ADR-019), as a pure function:
// what the sources found + the stored changes -> what to create, update and archive.
//
// 1. Candidates: each open PR (`pr:<n>`) and each branch ahead of the base
//    (`branch:<name>`). Live PRs that gh did not list, or could not list, and
//    whose closing is not confirmed stay as candidates with their stored values.
// 2. Candidates are grouped by head; one change per group, the winner by
//    `pr > branch`, then checked out in a working tree, then the first ref.
// 3. A group keeps the identity of the live change matching one of its refs.
// 4. Live PRs and branches that matched no group are archived (L7).
// 5. A new group whose head is that of a change archived as merged or closed is
//    not recreated (Q4).
// 6. Each dirty working tree folds into the group at its HEAD; when there is
//    none, or another working tree already folded into it, it is a Draft (Q2).
// 7. Live Drafts that matched no dirty working tree are archived as clean.

import { relative, sep } from 'node:path';
import type { ArchiveReason, ChangeKind, ChangeRecord } from '../model/types.js';
import type { ChangeFields, ChangePlan, ChangeUpdate, Discovered, PrInfo, WorktreeInfo } from './types.js';

/** Precedence inside a group of candidates at the same head (L4). */
const KIND_RANK: Record<ChangeKind, number> = { pr: 0, branch: 1, draft: 2 };

/** Title of a Draft (L6). */
export function draftTitle(branch: string | null): string {
  return branch === null ? 'Uncommitted changes' : `Uncommitted changes on ${branch}`;
}

/** `draft:<working tree path relative to the main working tree>`, `.` for the main one. */
export function draftRef(repoPath: string, worktreePath: string): string {
  const rel = relative(repoPath, worktreePath).split(sep).join('/');
  return `draft:${rel === '' ? '.' : rel}`;
}

interface Candidate {
  kind: 'pr' | 'branch';
  ref: string;
  prNumber: number | null;
  head: string;
  headAvailable: boolean;
  base: string;
  title: string;
  ahead: number | null;
  behind: number | null;
  /** Committer date of the head; null when unknown (head not local, or a stored PR). */
  committedAt: string | null;
  /** Branch name a working tree has checked out when it works on this candidate. */
  checkoutName: string | null;
}

interface Group {
  head: string;
  candidates: Candidate[];
  winner: Candidate;
  match: ChangeRecord | null;
}

/** The parts of a change computed from the sources, before identity and events. */
type Observed = Omit<ChangeFields, 'reviewState' | 'lastEventType' | 'lastEventAt' | 'updatedAt'> & {
  committedAt: string | null;
};

function prCandidate(info: PrInfo): Candidate {
  return {
    kind: 'pr',
    ref: `pr:${String(info.number)}`,
    prNumber: info.number,
    head: info.headRefOid,
    headAvailable: info.headAvailable,
    base: info.baseRefName,
    title: info.title,
    ahead: info.ahead,
    behind: info.behind,
    committedAt: info.committedAt,
    checkoutName: info.isCrossRepository ? null : info.headRefName,
  };
}

/** A live PR whose state gh did not confirm: it stays as it is stored. */
function storedPrCandidate(change: ChangeRecord): Candidate {
  return {
    kind: 'pr',
    ref: change.ref,
    prNumber: change.prNumber,
    head: change.head,
    headAvailable: change.headAvailable,
    base: change.base,
    title: change.title,
    ahead: change.ahead,
    behind: change.behind,
    committedAt: null,
    checkoutName: null,
  };
}

function compareRefs(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function pickWinner(candidates: readonly Candidate[], checkedOut: ReadonlySet<string>): Candidate {
  const rank = (candidate: Candidate): number =>
    candidate.checkoutName !== null && checkedOut.has(candidate.checkoutName) ? 0 : 1;
  const sorted = [...candidates].sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || rank(a) - rank(b) || compareRefs(a.ref, b.ref),
  );
  const winner = sorted[0];
  if (winner === undefined) throw new Error('a group always has a candidate');
  return winner;
}

/** The live change a group continues: the one with the winner's ref, else the strongest kind, else the oldest. */
function pickMatch(matches: readonly ChangeRecord[], winner: Candidate): ChangeRecord | null {
  const sorted = [...matches].sort(
    (a, b) =>
      Number(b.ref === winner.ref) - Number(a.ref === winner.ref) || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id - b.id,
  );
  return sorted[0] ?? null;
}

function laterOf(a: string, b: string): string {
  return a > b ? a : b;
}

/** Applies identity, the last event and the review state to what the sources observed. */
function fieldsFor(observed: Observed, existing: ChangeRecord | null, now: string): ChangeFields {
  const { committedAt, ...columns } = observed;
  if (existing === null) {
    return {
      ...columns,
      reviewState: 'unreviewed',
      lastEventType: 'commit',
      lastEventAt: committedAt ?? now,
      updatedAt: now,
    };
  }
  const headMoved = existing.head !== observed.head;
  return {
    ...columns,
    reviewState: headMoved && existing.reviewState === 'approved' ? 'unreviewed' : existing.reviewState,
    lastEventType: headMoved ? 'commit' : existing.lastEventType,
    lastEventAt: headMoved ? laterOf(committedAt ?? now, existing.lastEventAt) : existing.lastEventAt,
    updatedAt: existing.updatedAt,
  };
}

const COMPARED: readonly (keyof ChangeFields)[] = [
  'kind',
  'ref',
  'prNumber',
  'head',
  'headAvailable',
  'dirty',
  'worktreePath',
  'base',
  'title',
  'ahead',
  'behind',
  'reviewState',
  'lastEventType',
  'lastEventAt',
];

/** The writable columns of a stored change. */
export function storedFields(change: ChangeRecord): ChangeFields {
  return {
    kind: change.kind,
    ref: change.ref,
    prNumber: change.prNumber,
    head: change.head,
    headAvailable: change.headAvailable,
    dirty: change.dirty,
    worktreePath: change.worktreePath,
    base: change.base,
    title: change.title,
    ahead: change.ahead,
    behind: change.behind,
    reviewState: change.reviewState,
    lastEventType: change.lastEventType,
    lastEventAt: change.lastEventAt,
    updatedAt: change.updatedAt,
  };
}

function changed(fields: ChangeFields, existing: ChangeRecord): boolean {
  return COMPARED.some((key) => fields[key] !== existing[key]);
}

export function reconcile(
  live: readonly ChangeRecord[],
  archived: readonly ChangeRecord[],
  discovered: Discovered,
  now: Date,
): ChangePlan {
  const at = now.toISOString();
  const plan: ChangePlan = { create: [], update: [], archive: [] };
  const archive = (change: ChangeRecord, reason: ArchiveReason): void => {
    plan.archive.push({ id: change.id, reason, at });
  };
  const emit = (observed: Observed, existing: ChangeRecord | null): void => {
    const fields = fieldsFor(observed, existing, at);
    if (existing === null) plan.create.push(fields);
    else if (changed(fields, existing)) plan.update.push({ id: existing.id, fields: { ...fields, updatedAt: at } });
  };

  const liveByRef = new Map(live.map((change) => [change.ref, change]));
  const checkedOut = new Set(discovered.worktrees.flatMap((tree) => (tree.branch === null ? [] : [tree.branch])));

  // 1. Candidates.
  const candidates: Candidate[] = [];
  const newlyArchived: ChangeRecord[] = [];
  const prs = discovered.prs;
  if (prs.available) candidates.push(...prs.open.map(prCandidate));
  const listed = new Set(candidates.map((candidate) => candidate.ref));
  for (const change of live) {
    if (change.kind !== 'pr' || listed.has(change.ref)) continue;
    const state = prs.available && change.prNumber !== null ? prs.states[change.prNumber] : undefined;
    if (state === 'MERGED' || state === 'CLOSED') {
      archive(change, state === 'MERGED' ? 'merged' : 'closed');
      newlyArchived.push(change);
    } else {
      // gh unavailable, or the state is OPEN or unknown: archive only on a confirmed state.
      candidates.push(storedPrCandidate(change));
    }
  }
  for (const branch of discovered.branches) {
    candidates.push({
      kind: 'branch',
      ref: `branch:${branch.name}`,
      prNumber: null,
      head: branch.head,
      headAvailable: true,
      base: discovered.base,
      title: branch.title,
      ahead: branch.ahead,
      behind: branch.behind,
      committedAt: branch.committedAt,
      checkoutName: branch.name,
    });
  }

  // 2-3. Groups by head, matched with the live changes.
  const byHead = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = byHead.get(candidate.head);
    if (group === undefined) byHead.set(candidate.head, [candidate]);
    else group.push(candidate);
  }
  const matched = new Set<number>();
  const groups: Group[] = [];
  for (const [head, members] of byHead) {
    const winner = pickWinner(members, checkedOut);
    const matches = members.flatMap((candidate) => {
      const change = liveByRef.get(candidate.ref);
      return change === undefined ? [] : [change];
    });
    const match = pickMatch(matches, winner);
    for (const change of matches) {
      matched.add(change.id);
      // Two live changes reached the same head: the group continues one; the other was merged into it.
      if (change !== match) archive(change, 'merged');
    }
    groups.push({ head, candidates: members, winner, match });
  }

  // 4. Live branches that left the candidates. (Live PRs are all candidates or archived above.)
  const localBranches = new Set(discovered.localBranches);
  for (const change of live) {
    if (change.kind !== 'branch' || matched.has(change.id)) continue;
    const name = change.ref.slice('branch:'.length);
    archive(change, localBranches.has(name) ? 'merged' : 'deleted');
  }

  // 5. Merged or closed changes do not come back while their head stays the same.
  const closedForGood = [
    ...archived.filter((change) => change.archiveReason === 'merged' || change.archiveReason === 'closed'),
    ...newlyArchived,
  ];
  const suppressed = (group: Group): boolean =>
    group.match === null &&
    closedForGood.some(
      (change) =>
        change.head === group.head &&
        (group.candidates.some((candidate) => candidate.ref === change.ref) ||
          // The local branch of a PR merged (or closed) on GitHub: same commits, other ref.
          (change.kind === 'pr' && group.candidates.every((candidate) => candidate.kind !== 'pr'))),
    );
  const kept = groups.filter((group) => !suppressed(group));

  // 6. Working trees: fold into the group at their HEAD, or become Drafts.
  const worktreesAt = new Map<string, WorktreeInfo[]>();
  for (const tree of discovered.worktrees) {
    const list = worktreesAt.get(tree.head);
    if (list === undefined) worktreesAt.set(tree.head, [tree]);
    else list.push(tree);
  }
  const drafts: WorktreeInfo[] = [];
  const keptHeads = new Set(kept.map((group) => group.head));
  for (const group of kept) {
    const trees = [...(worktreesAt.get(group.head) ?? [])].sort(
      (a, b) => Number(b.branch === group.winner.checkoutName) - Number(a.branch === group.winner.checkoutName),
    );
    const folded = trees.find((tree) => tree.dirty) ?? null;
    for (const tree of trees) if (tree.dirty && tree !== folded) drafts.push(tree);
    const { winner } = group;
    emit(
      {
        kind: winner.kind,
        ref: winner.ref,
        prNumber: winner.prNumber,
        head: winner.head,
        headAvailable: winner.headAvailable,
        dirty: folded !== null,
        worktreePath: (folded ?? trees[0])?.path ?? null,
        base: winner.base,
        title: winner.title,
        ahead: winner.ahead,
        behind: winner.behind,
        committedAt: winner.committedAt,
      },
      group.match,
    );
  }
  for (const tree of discovered.worktrees) {
    if (tree.dirty && !keptHeads.has(tree.head)) drafts.push(tree);
  }
  drafts.sort((a, b) => discovered.worktrees.indexOf(a) - discovered.worktrees.indexOf(b));

  // 7. Drafts, matched with live Drafts by ref or working tree.
  const liveDrafts = live.filter((change) => change.kind === 'draft');
  for (const tree of drafts) {
    const ref = draftRef(discovered.repoPath, tree.path);
    const match = liveDrafts.find((change) => change.ref === ref || change.worktreePath === tree.path) ?? null;
    if (match !== null) matched.add(match.id);
    emit(
      {
        kind: 'draft',
        ref,
        prNumber: null,
        head: tree.head,
        headAvailable: true,
        dirty: true,
        worktreePath: tree.path,
        base: discovered.base,
        title: draftTitle(tree.branch),
        ahead: tree.ahead,
        behind: tree.behind,
        committedAt: tree.committedAt,
      },
      match,
    );
  }
  for (const change of liveDrafts) {
    if (!matched.has(change.id)) archive(change, 'clean');
  }

  return plan;
}

/**
 * Review state and last event after a snapshot was stored (ADR-019, Q5), with
 * the result of the snapshot store: a snapshot with new content resets
 * `approved`; on a dirty change it is also a `collect` event. Null when the
 * change needs no update.
 */
export function reviewAfterSnapshot(
  change: ChangeRecord,
  result: 'created' | 'replaced' | 'unchanged',
  now: Date,
): ChangeUpdate | null {
  if (result === 'unchanged') return null;
  const resetsReview = change.reviewState === 'approved';
  if (!resetsReview && !change.dirty) return null;
  const at = now.toISOString();
  return {
    id: change.id,
    fields: {
      ...storedFields(change),
      reviewState: resetsReview ? 'unreviewed' : change.reviewState,
      lastEventType: change.dirty ? 'collect' : change.lastEventType,
      lastEventAt: change.dirty ? laterOf(at, change.lastEventAt) : change.lastEventAt,
      updatedAt: at,
    },
  };
}
