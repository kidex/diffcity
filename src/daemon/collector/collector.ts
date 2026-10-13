// The daemon's collector (ADR-019, ADR-020, ADR-021, SPEC.md section 3a). One
// collection of a repo runs, in order:
//
// 1. identity, trust and base: the base is cached per repo and resolved again
//    when diffcity.config.js or the repo's trust changes or the cached ref
//    disappears. The config is imported only for a repo root listed in
//    settings.json, checked on every collection (ADR-024, ADR-030); an
//    untrusted repo with a config file gets a note in its RepoSummary;
// 2. the sources (working trees, branches, PRs); gh goes through an injected
//    CommandRunner and is consulted on the repo's first collection in this
//    daemon, on `prs`, and on `full` once the PR cache is older than 15 min;
//    `gh pr list` runs alongside the git reads, and its outcome alone says
//    whether gh is usable (gh.ts);
// 3. reconcile, against the live and archived changes;
// 4. applyPlan, in one transaction with the `commit` events of new heads;
// 5. snapshots, in the worker pool, only for changes whose head or dirty flag
//    changed, that have none yet, or whose working tree may have new content;
//    each one is put, then reviewAfterSnapshot applies (`replaced` counts as
//    changed), with a `collect` event; in the same transaction the change's
//    review marks are reconciled against the new fingerprints (ADR-028). A put
//    whose Report is identical but whose fingerprints differ is `refreshed`: the
//    row takes them in place, marks are reconciled, SSE `review` goes out alone;
// 6. SSE `repo` and `changes` after the plan, `snapshot` per stored snapshot
//    followed by `review` (the marks of the change may have turned outdated),
//    `collect` around the whole collection.
//
// Requests coalesce by the ADR-021 key `<repoId>:sources`: requests for a repo
// whose collection is queued merge into it (scopes are unioned, the highest
// priority wins), and requests while it runs give exactly one more run. The
// sources stage runs on the main thread (git and gh are I/O); only snapshots
// go to worker threads. A failure is stored in repos.collectError and sent as
// SSE `collect` with state `error`; it never reaches the daemon itself.
//
// Only the daemon's main thread writes the database (ADR-018).

import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyAgent,
  detectBase,
  identifyRepo,
  fetchOpenPrs,
  listBranches,
  listWorktrees,
  readPrs,
  prBase,
  reconcile,
  reviewAfterSnapshot,
  worktreeContaining,
  type Discovered,
  type GhPullRequest,
  type RepoIdentity,
  type WorktreeInfo,
} from '../../core/changes/index.js';
import { CONFIG_FILE_NAME, loadConfig } from '../../core/config/index.js';
import { CONFIG_NOT_TRUSTED_NOTE, rulesKey as rulesKeyOf, type RuleSettingsReader, type TrustCheck, type UserRuleSettings } from '../../core/settings/index.js';
import type { Db } from '../../core/db/index.js';
import { defaultRunner, GitError, resolveBase, type CommandRunner, type ResolvedBase } from '../../core/git/index.js';
import type {
  ChangeRecord,
  CollectOutcome,
  CollectorPort,
  CollectPriority,
  CollectScope,
  RepoNote,
  RepoRecord,
  SseEvent,
} from '../../core/model/types.js';
import { reconcileOnSnapshot } from '../../core/review/index.js';
import type { SnapshotJobInput } from '../../core/report/snapshot.js';
import { errorMessage, type Logger } from '../log.js';
import { createGhGate, type GhGate } from './gh.js';
import { createPool, type Pool } from './pool.js';
import type { SnapshotPool } from './snapshot-pool.js';

/** The PR cache is refreshed by a `full` collection once it is older than this (ADR-020). */
export const PR_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

/** Repos whose sources are read at the same time. */
export const SOURCES_CONCURRENCY = 4;

/** A sources stage that takes longer than this fails (git hung on a network mount, say). */
export const SOURCES_TIMEOUT_MS = 120_000;

export interface CollectorOptions {
  db: Db;
  snapshots: SnapshotPool;
  broadcast: (event: SseEvent) => void;
  log: Logger;
  /** Runs gh (and nothing else); defaults to the hardened tool runner without a daemon context (ADR-032). Tests inject a stub. */
  gh?: CommandRunner;
  now?: () => Date;
  /**
   * Whether a repo root may run its diffcity.config.js (ADR-030); asked on
   * every collection. Required, so no collector imports a config by default.
   */
  isTrusted: TrustCheck;
  /**
   * The user's rule lists for a repo root, from settings.json (ADR-030); read
   * on every collection. Without it, no user rule applies.
   */
  ruleSettings?: RuleSettingsReader;
  /** After the sources of a repo are read: its working trees, for the watchers (ADR-020). */
  onListed?: (repoId: number, worktrees: readonly WorktreeInfo[]) => void;
}

export interface Collector extends CollectorPort {
  /** Repos with a collection queued or running: the `collecting` of /api/health. */
  readonly collecting: number;
  isCollecting(repoId: number): boolean;
  /** Non-fatal notes on the repo from its last collection, for RepoSummary.notes. */
  notes(repoId: number): RepoNote[];
  /** False while gh is known to be unavailable for this repo (gh.ts); PR polling skips it then. */
  ghUsable(repoId: number): boolean;
  /**
   * `track --agent` (C3, ADR-001): marks the change of the working tree that
   * contains `dir` as "agent worked, not reviewed", or writes a repo-level
   * `agent` event when there is none. Run it after a collection. The event
   * carries `sessionId` when the hook's session was valid (ADR-038).
   */
  markAgent(repoId: number, dir: string, at: string, sessionId?: string): Promise<void>;
  /**
   * The working tree containing `dir` (a realpath) as the repo's last
   * collection listed it; null when none does or the repo was never listed.
   */
  worktreeOf(repoId: number, dir: string): WorktreeInfo | null;
  /** The repo's working trees as its last collection listed them; null when it was never listed. */
  worktreesOf(repoId: number): readonly WorktreeInfo[] | null;
  /** Refuses new requests, stops the pools and waits for the running collections. */
  close(): Promise<void>;
}

/** What a queued collection of a repo covers, merged across coalesced requests. */
interface Wanted {
  full: boolean;
  prs: boolean;
  /** Working trees whose uncommitted content may have changed. */
  worktrees: Set<string>;
  priority: CollectPriority;
}

interface Run {
  /** Settles once the snapshots of the run are stored. */
  done: Promise<CollectOutcome>;
}

const RANK: Record<CollectPriority, number> = { high: 0, normal: 1, low: 2 };

function mergeWanted(wanted: Wanted | undefined, scope: CollectScope, priority: CollectPriority): Wanted {
  const next: Wanted = wanted ?? { full: false, prs: false, worktrees: new Set(), priority };
  if (RANK[priority] < RANK[next.priority]) next.priority = priority;
  if (scope === 'full') next.full = true;
  else if (scope === 'prs') next.prs = true;
  else if (scope.startsWith('worktree:')) next.worktrees.add(scope.slice('worktree:'.length));
  return next;
}

/** mtime of the repo's diffcity.config.js, null when there is none. Only stats it: never reads it. */
async function configStamp(root: string): Promise<number | null> {
  try {
    return (await stat(join(root, CONFIG_FILE_NAME))).mtimeMs;
  } catch {
    return null;
  }
}

/** What a collection knows about the repo's config before it detects the base. */
interface ConfigState {
  /** The repo root is in settings.json's trustedRepos. */
  trusted: boolean;
  /** mtime of diffcity.config.js, null when there is none. */
  stamp: number | null;
  /** The user's rule lists for the repo, passed to the snapshot jobs. */
  rules: UserRuleSettings;
  /**
   * The hash of everything a snapshot's rules depend on besides the content:
   * trust, the config's mtime (only for a trusted repo, whose config runs) and
   * the user rules. Stored with each snapshot; a change whose latest snapshot
   * was stored under another key, or none, is computed again, also after a
   * restart (ADR-030, DC-121).
   */
  rulesKey: string;
}

export function createCollector(options: CollectorOptions): Collector {
  const { db, snapshots, broadcast, log } = options;
  const gh = options.gh ?? defaultRunner;
  const now = options.now ?? ((): Date => new Date());
  const ghGate: GhGate = createGhGate(now);

  const identities = new Map<number, RepoIdentity>();
  const bases = new Map<number, { name: string; config: string }>();
  const notes = new Map<number, RepoNote[]>();
  const prCache = new Map<number, { prs: GhPullRequest[] | null; at: number }>();
  const worktreesSeen = new Map<number, WorktreeInfo[]>();
  const wanted = new Map<number, Wanted>();
  const inFlight = new Map<number, number>();
  const runs = new Set<Promise<CollectOutcome>>();
  /** Sequence number of the most recently started run of each repo. */
  const latestRun = new Map<number, number>();
  let runCounter = 0;
  let closing = false;

  const sources: Pool<{ repoId: number }, Run> = createPool({
    size: SOURCES_CONCURRENCY,
    timeoutMs: SOURCES_TIMEOUT_MS,
    runner: {
      kind: 'inline',
      compute: ({ repoId }) => {
        const scope = wanted.get(repoId) ?? mergeWanted(undefined, 'refs', 'normal');
        wanted.delete(repoId);
        return runSources(repoId, scope);
      },
    },
  });

  async function identityOf(repo: RepoRecord): Promise<RepoIdentity> {
    const cached = identities.get(repo.id);
    // A repo moved or deleted since: identify it again, for an error that says so.
    if (cached !== undefined && existsSync(cached.path)) return cached;
    const identity = await identifyRepo(repo.path);
    identities.set(repo.id, identity);
    return identity;
  }

  /** Trust and config stamp of a repo, and its note: set when an untrusted repo has a config file. */
  async function configStateOf(repo: RepoRecord, identity: RepoIdentity): Promise<ConfigState> {
    const [trusted, stamp, rules] = await Promise.all([
      options.isTrusted(identity.path),
      configStamp(identity.path),
      options.ruleSettings?.(identity.path) ?? Promise.resolve({}),
    ]);
    const next = !trusted && stamp !== null ? [CONFIG_NOT_TRUSTED_NOTE] : [];
    const previous = notes.get(repo.id) ?? [];
    if (next.length === 0) notes.delete(repo.id);
    else notes.set(repo.id, next);
    if (JSON.stringify(next) !== JSON.stringify(previous)) broadcast({ event: 'repo', data: { repoId: repo.id } });
    return { trusted, stamp, rules, rulesKey: rulesKeyOf(trusted, stamp, rules) };
  }

  /** The repo base (L5), cached by name; its commit is resolved on every collection. */
  async function baseOf(repo: RepoRecord, identity: RepoIdentity, state: ConfigState): Promise<ResolvedBase> {
    // An untrusted repo's config is never loaded, so its edits do not matter until it is trusted.
    const config = state.trusted ? `trusted:${String(state.stamp)}` : 'untrusted';
    const cached = bases.get(repo.id);
    if (cached?.config === config) {
      try {
        return await resolveBase(identity.path, { flag: cached.name });
      } catch (error) {
        if (!(error instanceof GitError) || error.code !== 'no-base') throw error;
        // The cached ref disappeared: detect it again.
      }
    }
    const loaded = await loadConfig(identity.path, { trusted: state.trusted });
    const base = await detectBase(identity, { config: loaded.base, runner: gh });
    bases.set(repo.id, { name: base.name, config });
    if (repo.base !== base.name) db.repos.setBase(repo.id, base.name);
    return base;
  }

  /**
   * Open PRs for this collection: from the cache, or from one `gh pr list`
   * whose outcome also tells whether gh is usable (ADR-020, DC-49). Null when
   * gh is unavailable: then reconcile keeps the stored PRs and archives none.
   * Never rejects.
   */
  async function openPrsFor(repoId: number, identity: RepoIdentity, scope: Wanted): Promise<{ prs: GhPullRequest[] | null; fresh: boolean }> {
    const cached = prCache.get(repoId);
    const stale = cached === undefined || now().getTime() - cached.at >= PR_CACHE_MAX_AGE_MS;
    if (cached !== undefined && !scope.prs && !(scope.full && stale)) return { prs: cached.prs, fresh: false };
    if (!ghGate.usable(repoId)) {
      prCache.set(repoId, { prs: null, at: now().getTime() });
      return { prs: null, fresh: false };
    }
    const outcome = await fetchOpenPrs(identity.path, gh);
    ghGate.record(repoId, outcome);
    if (!outcome.ok && outcome.reason === 'timeout') {
      // Unavailable for this run only: the cache keeps its age, so the next collection asks again.
      return { prs: cached?.prs ?? null, fresh: false };
    }
    const prs = outcome.ok ? outcome.prs : null;
    prCache.set(repoId, { prs, at: now().getTime() });
    return { prs, fresh: prs !== null };
  }

  function needsSnapshot(change: ChangeRecord, scope: Wanted, rulesKey: string): boolean {
    if (!change.headAvailable) return false;
    const latest = db.snapshots.latestComputed(change.id);
    if (latest === null || latest.head !== change.head || latest.dirty !== change.dirty) return true;
    // Other rules than the stored snapshot's, or a snapshot stored before keys were (ADR-030).
    if (latest.rulesKey !== rulesKey) return true;
    if (!change.dirty) return false;
    return scope.full || (change.worktreePath !== null && scope.worktrees.has(change.worktreePath));
  }

  /**
   * The snapshot job of a change. Drafts and branches use the repo base; a PR
   * uses its own base as the local repo knows it (prBase: the local branch,
   * origin's, else the repo base), since gh's baseRefName need not exist locally.
   */
  async function snapshotInput(repo: RepoRecord, change: ChangeRecord, repoBase: ResolvedBase, config: ConfigState): Promise<SnapshotJobInput> {
    const at = now().toISOString();
    const base = change.kind === 'pr' ? (await prBase(repo.path, change.base, repoBase)).ref : repoBase.name;
    const trustConfig = config.trusted;
    const rules = Object.keys(config.rules).length === 0 ? {} : { userRules: config.rules };
    if (change.dirty && change.worktreePath !== null) return { repoDir: change.worktreePath, base, now: at, trustConfig, ...rules };
    return { repoDir: repo.path, base, head: change.head, now: at, trustConfig, ...rules };
  }

  /** Computes and stores one snapshot; true when the change list moved (review state or last event). */
  async function snapshotChange(
    repo: RepoRecord,
    change: ChangeRecord,
    repoBase: ResolvedBase,
    config: ConfigState,
    priority: CollectPriority,
  ): Promise<boolean> {
    const input = await snapshotInput(repo, change, repoBase, config);
    const computed = await snapshots.submit(`${String(repo.id)}:${String(change.id)}`, priority, input);
    for (const note of computed.notes ?? []) log.info(`snapshot of ${change.ref}: ${note}`);
    if (closing) return false;
    const at = now();
    const iso = at.toISOString();
    const { result, listMoved } = db.transaction(() => {
      const stored = db.snapshots.put({
        changeId: change.id,
        head: computed.headCommit,
        dirty: change.dirty,
        report: computed.reportJson,
        summary: computed.summary,
        touched: computed.touched,
        contentHash: computed.contentHash,
        computedAt: iso,
        mergeBase: computed.mergeBase,
        fingerprints: computed.fingerprintsJson,
        rulesKey: config.rulesKey,
      });
      if (stored === 'unchanged') return { result: stored, listMoved: false };
      // Same transaction as the put: no reader sees a new snapshot with stale current marks (ADR-028).
      reconcileOnSnapshot(db, change.id, stored, computed.fingerprintsJson, iso);
      const current = db.changes.get(change.id);
      const update = current === null || current.archivedAt !== null ? null : reviewAfterSnapshot(current, stored, at);
      if (update !== null) db.changes.applyPlan(repo.id, { create: [], update: [update], archive: [] }, iso);
      // A refreshed snapshot kept its Report: no `collect` event, only the marks moved.
      if (stored !== 'refreshed') {
        db.events.add({ repoId: repo.id, changeId: change.id, type: 'collect', at: iso, payload: { head: computed.headCommit } });
      }
      return { result: stored, listMoved: update !== null };
    });
    if (result !== 'unchanged') {
      if (result !== 'refreshed') broadcast({ event: 'snapshot', data: { repoId: repo.id, changeId: change.id, head: computed.headCommit } });
      broadcast({ event: 'review', data: { repoId: repo.id, changeId: change.id } });
    }
    return listMoved;
  }

  /** Steps 1-4; returns the changes that need a snapshot. */
  async function listChanges(repo: RepoRecord, scope: Wanted): Promise<{ pending: ChangeRecord[]; base: ResolvedBase; config: ConfigState }> {
    const identity = await identityOf(repo);
    const configState = await configStateOf(repo, identity);
    // gh reaches the network: it runs alongside the local git reads (base,
    // working trees, branches), never before them. Reconcile waits for both,
    // so a branch with an open PR folds into the PR change on the first run.
    const openPrsPending = openPrsFor(repo.id, identity, scope);
    const base = await baseOf(repo, identity, configState);
    const live = db.changes.listLive(repo.id);
    const [worktrees, refs, prs] = await Promise.all([
      listWorktrees(identity, base),
      listBranches(identity, base),
      // The PRs' local details (heads, ahead/behind) follow the list as soon as it is in.
      openPrsPending.then((openPrs) =>
        readPrs(
          identity,
          base,
          openPrs.prs,
          // The state of a PR that left the list is asked only right after the list itself.
          openPrs.fresh ? live.flatMap((change) => (change.prNumber === null ? [] : [change.prNumber])) : [],
          gh,
        ),
      ),
    ]);
    const discovered: Discovered = {
      repoPath: identity.path,
      base: base.name,
      worktrees,
      branches: refs.branches,
      localBranches: refs.localBranches,
      prs,
    };
    worktreesSeen.set(repo.id, discovered.worktrees);
    if (closing) return { pending: [], base, config: configState };
    try {
      options.onListed?.(repo.id, discovered.worktrees);
    } catch (error) {
      log.error(`collection: onListed failed: ${errorMessage(error)}`);
    }

    const at = now();
    const iso = at.toISOString();
    // Read again: an agent mark may have landed while the sources were read.
    const plan = reconcile(db.changes.listLive(repo.id), db.changes.listArchived(repo.id), discovered, at);
    const empty = plan.create.length + plan.update.length + plan.archive.length === 0;
    if (!empty) {
      db.transaction(() => {
        const applied = db.changes.applyPlan(repo.id, plan, iso);
        const moved = new Set(plan.update.filter((update) => update.head !== undefined).map((update) => update.id));
        for (const change of [...applied.created, ...applied.updated.filter((row) => moved.has(row.id))]) {
          db.events.add({ repoId: repo.id, changeId: change.id, type: 'commit', at: change.lastEventAt, payload: { head: change.head } });
        }
      });
      broadcast({ event: 'repo', data: { repoId: repo.id } });
      broadcast({ event: 'changes', data: { repoId: repo.id } });
    }
    return { pending: db.changes.listLive(repo.id).filter((change) => needsSnapshot(change, scope, configState.rulesKey)), base, config: configState };
  }

  /**
   * Records the end of a collection: the repo's error, the SSE signals. Runs of
   * one repo can finish out of order (a run's snapshots outlive the next run's
   * start), so only the most recently started run writes collectError and the
   * final `collect`; a superseded run only reports to its own callers.
   */
  function finish(repo: RepoRecord, run: number, errors: readonly string[], listMoved: boolean): CollectOutcome {
    if (closing) return { ok: false, error: 'the daemon is shutting down' };
    const repoId = repo.id;
    const error = errors.length === 0 ? null : errors.join('; ');
    if (latestRun.get(repoId) !== run) {
      if (listMoved) broadcast({ event: 'changes', data: { repoId } });
      return error === null ? { ok: true } : { ok: false, error };
    }
    const previous = db.repos.get(repoId)?.collectError ?? null;
    if (previous !== error) db.repos.setCollectError(repoId, error);
    if (listMoved) broadcast({ event: 'changes', data: { repoId } });
    if (listMoved || previous !== error) broadcast({ event: 'repo', data: { repoId } });
    if (error === null) {
      broadcast({ event: 'collect', data: { repoId, state: 'done' } });
      return { ok: true };
    }
    log.warn(`collection of ${repo.name} (repo ${String(repoId)}) failed: ${error}`);
    broadcast({ event: 'collect', data: { repoId, state: 'error', error } });
    return { ok: false, error };
  }

  /** Step 5 and the end of the collection; runs after the sources slot is released. */
  async function storeSnapshots(
    repo: RepoRecord,
    pending: readonly ChangeRecord[],
    base: ResolvedBase,
    config: ConfigState,
    priority: CollectPriority,
    run: number,
  ): Promise<CollectOutcome> {
    const errors: string[] = [];
    let listMoved = false;
    const results = await Promise.allSettled(pending.map((change) => snapshotChange(repo, change, base, config, priority)));
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') listMoved ||= result.value;
      else errors.push(`snapshot of ${pending[index]?.ref ?? 'a change'}: ${errorMessage(result.reason)}`);
    }
    return finish(repo, run, errors, listMoved);
  }

  /**
   * The `<repoId>:sources` job: steps 1-4 hold the slot, so collections of one
   * repo never overlap there; the snapshots continue in the background and
   * `done` settles once they are stored.
   */
  async function runSources(repoId: number, scope: Wanted): Promise<Run> {
    const repo = db.repos.get(repoId);
    if (repo === null) return { done: Promise.resolve({ ok: false, error: `repo ${String(repoId)} not found` }) };
    const run = ++runCounter;
    latestRun.set(repoId, run);
    broadcast({ event: 'collect', data: { repoId, state: 'started' } });
    let done: Promise<CollectOutcome>;
    const started = performance.now();
    try {
      const { pending, base, config } = await listChanges(repo, scope);
      const listed = performance.now();
      done = storeSnapshots(repo, pending, base, config, scope.priority, run).then((outcome) => {
        if (pending.length > 0 || !outcome.ok) {
          const end = performance.now();
          log.info(
            `collected ${repo.name} (repo ${String(repoId)}): sources ${(listed - started).toFixed(0)} ms, ` +
              `${String(pending.length)} snapshots in ${(end - listed).toFixed(0)} ms, total ${(end - started).toFixed(0)} ms`,
          );
        }
        return outcome;
      });
    } catch (error) {
      // The identity and base are looked up afresh next time (a moved or deleted repo).
      identities.delete(repoId);
      bases.delete(repoId);
      done = Promise.resolve().then(() => finish(repo, run, [errorMessage(error)], false));
    }
    const guarded = done.catch((error: unknown): CollectOutcome => {
      // A failure while recording the outcome (the database closed under us, say).
      log.error(`collection of repo ${String(repoId)} failed: ${errorMessage(error)}`);
      return { ok: false, error: errorMessage(error) };
    });
    runs.add(guarded);
    void guarded.finally(() => runs.delete(guarded));
    return { done: guarded };
  }

  const settle = (repoId: number): void => {
    const count = (inFlight.get(repoId) ?? 1) - 1;
    if (count <= 0) inFlight.delete(repoId);
    else inFlight.set(repoId, count);
  };

  return {
    get collecting() {
      return inFlight.size;
    },
    isCollecting: (repoId) => inFlight.has(repoId),
    notes: (repoId) => [...(notes.get(repoId) ?? [])],
    ghUsable: (repoId) => ghGate.usable(repoId),
    async request(repoId, scope, priority) {
      if (closing) return { ok: false, error: 'the daemon is shutting down' };
      wanted.set(repoId, mergeWanted(wanted.get(repoId), scope, priority));
      inFlight.set(repoId, (inFlight.get(repoId) ?? 0) + 1);
      try {
        const run = await sources.submit(`${String(repoId)}:sources`, priority, { repoId });
        return await run.done;
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      } finally {
        settle(repoId);
      }
    },
    worktreeOf: (repoId, dir) => worktreeContaining(worktreesSeen.get(repoId) ?? [], dir),
    worktreesOf: (repoId) => worktreesSeen.get(repoId) ?? null,
    async markAgent(repoId, dir, at, sessionId) {
      if (closing) return;
      const resolved = await realpath(dir).catch(() => dir);
      const worktree = worktreeContaining(worktreesSeen.get(repoId) ?? [], resolved);
      const iso = now().toISOString();
      db.transaction(() => {
        if (worktree === null) {
          db.events.add({ repoId, changeId: null, type: 'agent', at, payload: { worktree: resolved, ...(sessionId === undefined ? {} : { sessionId }) } });
          return;
        }
        const outcome = applyAgent(db.changes.listLive(repoId), worktree, at, sessionId);
        if (outcome.update !== null) db.changes.applyPlan(repoId, { create: [], update: [outcome.update], archive: [] }, iso);
        db.events.add({ repoId, ...outcome.event });
      });
      broadcast({ event: 'changes', data: { repoId } });
      broadcast({ event: 'repo', data: { repoId } });
    },
    async close() {
      closing = true;
      await Promise.all([sources.shutdown(), snapshots.shutdown()]);
      await Promise.allSettled([...runs]);
    },
  };
}
