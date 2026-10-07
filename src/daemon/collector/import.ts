// The `import` socket request (ADR-036, SPEC.md section 5.6): the findings a
// CLI parsed from its file, for the change checked out in `dir`.
//
// 1. The repo containing `dir` is identified (a `dir` outside a git repository
//    is an error) and seen like `track` sees it: registered when unknown,
//    active again when inactive.
// 2. A high-priority collection of the working tree containing `dir` (a full
//    one for a repo this request registered or reactivated) is asked for, and
//    awaited up to IMPORT_SNAPSHOT_WAIT_MS.
// 3. The change checked out there (ADR-019, as `track --agent` resolves it)
//    and its latest snapshot are read. When the collection did not end in
//    time, or failed, the findings still go against that snapshot and the
//    reply says `anchoredAgainst: 'previous-snapshot'`. No change, or a change
//    with no snapshot at all, is an error.
// 4. src/core plans the import (anchor, merged and skipped counts, fixed keys);
//    the batch and the `import` event are stored in one transaction, then SSE
//    `findings` goes out.

import { realpath } from 'node:fs/promises';
import { changeOfWorktree, identifyRepo, type RepoIdentity } from '../../core/changes/index.js';
import type { Db } from '../../core/db/index.js';
import { planImport } from '../../core/findings/index.js';
import { findRepoRoot } from '../../core/git/change.js';
import type { CollectOutcome, Fingerprints, ImportAnchor, RepoRecord, SocketResponseFor, SseEvent } from '../../core/model/types.js';
import type { Report } from '../../core/report/types.js';
import { storeFindingsImport } from '../findings.js';
import { errorMessage } from '../log.js';
import type { SocketRequestOf } from '../socket/server.js';
import type { Collector } from './collector.js';

/** How long an import waits for a snapshot at the current content (ADR-036). */
export const IMPORT_SNAPSHOT_WAIT_MS = 20_000;

export interface ImportDeps {
  db: Db;
  collector: Collector;
  broadcast: (event: SseEvent) => void;
  /** Registers the repo or marks it seen, as `track` does; `activated` when it was unknown or inactive. */
  see: (identity: RepoIdentity, at: string) => { repo: RepoRecord; activated: boolean };
  /** The request time, when valid; otherwise now. */
  time: (at: string) => string;
  waitMs: number;
}

/** The outcome of `pending`, or null when it is not settled within `ms`. */
function within<T>(pending: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    void pending.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

const fail = (error: string): SocketResponseFor<'import'> => ({ ok: false, error });

export async function handleImport(deps: ImportDeps, request: SocketRequestOf<'import'>): Promise<SocketResponseFor<'import'>> {
  const { db, collector } = deps;
  let identity: RepoIdentity;
  let root: string;
  try {
    identity = await identifyRepo(request.dir);
    root = await realpath(await findRepoRoot(request.dir));
  } catch (error) {
    return fail(errorMessage(error));
  }
  const dir = await realpath(request.dir).catch(() => root);
  const at = deps.time(request.at);
  const { repo, activated } = deps.see(identity, at);

  const scope = activated ? 'full' : (`worktree:${root}` as const);
  const outcome: CollectOutcome | null = await within(collector.request(repo.id, scope, 'high'), deps.waitMs);

  const worktree = collector.worktreeOf(repo.id, dir);
  if (worktree === null) {
    return fail(
      outcome === null
        ? `${repo.name} is still being collected for the first time; run the import again in a moment`
        : `no working tree of ${repo.name} contains ${request.dir}`,
    );
  }
  const change = changeOfWorktree(db.changes.listLive(repo.id), worktree);
  if (change === null) return fail(`no change is checked out in ${worktree.path}: nothing differs from the base`);
  const snapshot = db.snapshots.latest(change.id);
  if (snapshot === null) return fail(`${change.ref} has no snapshot yet; run the import again in a moment`);
  const current = outcome !== null && outcome.ok && snapshot.head === change.head && snapshot.dirty === change.dirty;
  const anchoredAgainst: ImportAnchor = current ? 'current-snapshot' : 'previous-snapshot';

  const sources = request.sources ?? [...new Set(request.findings.map((finding) => finding.source))];
  const plan = planImport({
    findings: request.findings,
    warnings: request.warnings,
    sources,
    // The daemon wrote both; they are trusted to be a Report and Fingerprints.
    report: JSON.parse(snapshot.report) as Report,
    fingerprints: snapshot.fingerprints === null ? undefined : (JSON.parse(snapshot.fingerprints) as Fingerprints),
    stored: db.findings.list(change.id),
  });
  const counts = { imported: plan.imported, merged: plan.merged, skipped: plan.skipped };
  const stored = storeFindingsImport(
    { db, broadcast: deps.broadcast },
    repo.id,
    { changeId: change.id, head: snapshot.head, findings: plan.findings, fixed: plan.fixed, at },
    // `fixed` is what the store fixed, in the event as in the reply.
    { payload: (result) => ({ head: snapshot.head, ...counts, fixed: result.fixed, sources, anchoredAgainst }) },
  );
  return {
    ok: true,
    change: { id: change.id, repoId: repo.id, ref: change.ref },
    ...counts,
    fixed: stored.fixed,
    warnings: plan.warnings,
    anchoredAgainst,
  };
}
