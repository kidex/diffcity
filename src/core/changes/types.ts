// Inputs and outputs of the change list (SPEC.md section 3a, ADR-019).
//
// `sources.ts` reads the repo into a `Discovered` value; `reconcile.ts` turns
// it, together with the stored changes, into a `ChangePlan` that the daemon
// applies in a single transaction. The stored records themselves are the
// shared types in src/core/model/types.ts.

import type { ArchiveReason, ChangeRecord } from '../model/types.js';

/** Who the repo is (ADR-019): the same for its root, any subfolder and any linked worktree. */
export interface RepoIdentity {
  /** Realpath of `git rev-parse --git-common-dir`. */
  gitCommonDir: string;
  /** Realpath of the main working tree (first entry of `git worktree list`). */
  path: string;
  /** Basename of `path`. */
  name: string;
}

/** A working tree of the repo (main or linked) that has at least one commit. */
export interface WorktreeInfo {
  /** Realpath of the working tree. */
  path: string;
  /** Sha of its HEAD. */
  head: string;
  /** Checked-out branch name, or null on a detached HEAD. */
  branch: string | null;
  /** `git status --porcelain` is not empty (untracked files included). */
  dirty: boolean;
  /** Commits of HEAD relative to the repo base. */
  ahead: number;
  behind: number;
  /** Committer date of HEAD, ISO 8601 UTC. */
  committedAt: string;
}

/** A local branch with commits ahead of the base (`for-each-ref --no-merged`). */
export interface BranchInfo {
  name: string;
  head: string;
  ahead: number;
  behind: number;
  /** Subject of the oldest commit in `<base>..<head>`. */
  title: string;
  /** Committer date of the tip, ISO 8601 UTC. */
  committedAt: string;
}

/** An open PR from `gh pr list`, completed with what the local repo knows about its head. */
export interface PrInfo {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  /** The head commit exists locally; diffcity never fetches it (ADR-019, Q3). */
  headAvailable: boolean;
  /** Null when the head is not available locally. */
  ahead: number | null;
  behind: number | null;
  /** Committer date of the head, ISO 8601 UTC; null when the head is not available locally. */
  committedAt: string | null;
}

/** State reported by `gh pr view <n> --json state`. */
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

/**
 * What `gh` told us. `available: false` when `gh` is missing, unauthenticated,
 * failing or not consulted: then no PR is archived (ADR-019).
 */
export type PrSource =
  | { available: false }
  | {
      available: true;
      open: PrInfo[];
      /** Confirmed states of PRs that are live but missing from `open`; a missing entry means "unknown". */
      states: Readonly<Record<number, PrState>>;
    };

/** Everything the sources found in one collection of a repo. */
export interface Discovered {
  /** `RepoIdentity.path`: draft refs are relative to it. */
  repoPath: string;
  /** Name of the repo base (e.g. `main`), stored as `ChangeRecord.base` for drafts and branches. */
  base: string;
  /** Working trees in `git worktree list` order, main first. */
  worktrees: WorktreeInfo[];
  /** Branches with commits ahead of the base, the base itself excluded. */
  branches: BranchInfo[];
  /** Every local branch name, merged or not; tells a deleted branch from a merged one. */
  localBranches: string[];
  prs: PrSource;
}

/**
 * The columns a plan writes. `id`, `repoId`, the archive columns and
 * `updatedAt` are set by the store, which stamps the times with its own `now`.
 */
export type ChangeFields = Omit<ChangeRecord, 'id' | 'repoId' | 'archivedAt' | 'archiveReason' | 'updatedAt'>;

/** A live change to update: only the columns that changed. */
export type ChangeUpdate = { id: number } & Partial<ChangeFields>;

/** A live change to archive; the store sets `archivedAt`. */
export interface ChangeArchive {
  id: number;
  reason: ArchiveReason;
}

/**
 * Output of `reconcile` (ADR-019), applied by the daemon in a single
 * transaction. The canonical plan type: src/core/db applies it as is.
 */
export interface ChangePlan {
  /** New live changes, `reviewState: 'unreviewed'`. */
  create: ChangeFields[];
  /** Live changes with at least one changed column; unchanged ones are left out. */
  update: ChangeUpdate[];
  archive: ChangeArchive[];
}
