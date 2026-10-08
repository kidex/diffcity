// The collection plugin (ADR-016, ADR-019, ADR-020, ADR-021): uses the
// shared database (src/daemon/db.ts), owns the snapshot pool and the collector, and serves the `track`
// and `register` socket requests.
//
// track (C2, C3): identifies the repo, registers it if missing (active, seen
// now) or reactivates it, answers `{ ok, repo }`, and only then collects at
// high priority; the repo's first collection in this daemon also lists its PRs.
// With `agent`, the agent mark follows the collection (ADR-001).
//
// register (scan, Q6): registers the new repos as inactive and collects each
// new one once, at low priority. Known repos keep their state.
//
// import (ADR-036): sees the repo like `track`, waits for a collection of the
// working tree and stores the findings (import.ts).
//
// On start, every active repo gets one low-priority collection (ADR-020).
//
// Opening a repo in the UI (provideRepoOpen, called by GET /api/repos/:id)
// counts as seeing it, exactly like `track` (Q6): its 7-day window moves
// forward on this plugin's clock, active or not, and an inactive repo is
// active again and collected once. An open of an active repo collects nothing.
//
// Two hooks for the watchers (DC-33): onActivated fires when `track` registers
// a repo or reactivates an inactive one, and when the UI opens an inactive
// repo; onListed fires after each collection read a repo's working trees.

import { availableParallelism } from 'node:os';
import { identifyRepo, type RepoIdentity, type WorktreeInfo } from '../../core/changes/index.js';
import { createGhRunner } from '../../core/exec/index.js';
import { createRuleSettingsReader, createTrustCheck, readToolSetting } from '../../core/settings/index.js';
import type { Db } from '../../core/db/index.js';
import type { CommandRunner } from '../../core/git/index.js';
import type { RepoRecord, SocketSuccessResponses } from '../../core/model/types.js';
import { provideRepoOpen } from '../activation.js';
import { getDb } from '../db.js';
import { errorMessage } from '../log.js';
import type { DaemonContext, DaemonPlugin } from '../plugin.js';
import { provideRuntime } from '../runtime.js';
import type { SocketRequestOf } from '../socket/server.js';
import { createCollector, type Collector } from './collector.js';
import { handleImport, IMPORT_SNAPSHOT_WAIT_MS } from './import.js';
import { defaultPoolSize } from './pool.js';
import { createSnapshotPool, type SnapshotRunnerKind } from './snapshot-pool.js';

/** Directories identified at the same time by one `register` request. */
const REGISTER_CONCURRENCY = 8;

export interface CollectionPluginOptions {
  /** Snapshot runner; defaults to `thread` (ADR-021). */
  runner?: SnapshotRunnerKind;
  /** The thread runner's worker script, for tests. */
  workerUrl?: URL;
  /** Snapshot workers; defaults to clamp(availableParallelism() - 1, 1, 4). */
  poolSize?: number;
  /** Snapshot job timeout; defaults to 120 s. */
  jobTimeoutMs?: number;
  /** Runs gh; defaults to the hardened tool runner (ADR-032) with this daemon's settings, repos and log. Tests inject a stub. */
  gh?: CommandRunner;
  now?: () => Date;
  /** How long `import` waits for a snapshot at the current content; defaults to IMPORT_SNAPSHOT_WAIT_MS (tests shorten it). */
  importWaitMs?: number;
}

export interface Collection {
  readonly plugin: DaemonPlugin;
  /** The daemon's database, opened in setup; throws before setup and after stop. */
  db(): Db;
  /** The collector, created in setup; throws before setup and after stop. */
  collector(): Collector;
  /** Calls `listener` when `track` registers a repo or reactivates it; returns the unsubscribe. */
  onActivated(listener: (repoId: number) => void): () => void;
  /** Calls `listener` after each collection read a repo's working trees; returns the unsubscribe. */
  onListed(listener: (repoId: number, worktrees: readonly WorktreeInfo[]) => void): () => void;
}

function listeners<A extends unknown[]>(): { add(fn: (...args: A) => void): () => void; emit(...args: A): void } {
  const set = new Set<(...args: A) => void>();
  return {
    add(fn) {
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(...args) {
      for (const fn of set) fn(...args);
    },
  };
}

/** The time of a request, when it is a valid date; otherwise `fallback`. */
function requestTime(at: string, fallback: Date): string {
  const time = Date.parse(at);
  return Number.isNaN(time) ? fallback.toISOString() : new Date(time).toISOString();
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createCollection(options: CollectionPluginOptions = {}): Collection {
  const now = options.now ?? ((): Date => new Date());
  let db: Db | null = null;
  let collector: Collector | null = null;
  const activated = listeners<[number]>();
  const listed = listeners<[number, readonly WorktreeInfo[]]>();

  const need = <T>(value: T | null, what: string): T => {
    if (value === null) throw new Error(`the ${what} is not open`);
    return value;
  };

  /** Runs after the socket response is written, so `track` never waits for git. */
  const later = (fn: () => Promise<unknown>, context: DaemonContext): void => {
    setImmediate(() => {
      fn().catch((error: unknown) => {
        context.log.error(`collection: ${errorMessage(error)}`);
      });
    });
  };

  function emitActivated(context: DaemonContext, repoId: number): void {
    try {
      activated.emit(repoId);
    } catch (error) {
      context.log.error(`collection: onActivated failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Seeing a known repo (Q6), for `track` and the UI: active, and its 7-day
   * window moved to `at` (never back). Returns true when it was inactive.
   */
  function markSeen(store: Db, repo: RepoRecord, at: string): boolean {
    if (!repo.active) store.repos.setActive(repo.id, true);
    if (at > repo.lastSeenAt) store.repos.touchSeen(repo.id, at);
    return !repo.active;
  }

  /**
   * Opening a repo in the UI (Q6): seen now. An inactive repo is also active
   * again, watched, and collected once; an active one only gets its window
   * moved, with no signal (the UI refetches the repo on a `repo` signal).
   */
  function open(context: DaemonContext, repoId: number): boolean {
    const store = need(db, 'database');
    const repo = store.repos.get(repoId);
    if (repo === null || !markSeen(store, repo, now().toISOString())) return false;
    emitActivated(context, repoId);
    context.broadcast({ event: 'repo', data: { repoId } });
    const active = need(collector, 'collector');
    later(() => active.request(repoId, 'full', 'normal'), context);
    return true;
  }

  /**
   * `track` and `import` see a repo (C2, Q6): registered (active, seen at
   * `at`) when unknown, else marked seen and active again. `activated` when it
   * was unknown or inactive.
   */
  function see(context: DaemonContext, identity: RepoIdentity, at: string): { repo: RepoRecord; activated: boolean } {
    const store = need(db, 'database');
    const { repo, created } = store.repos.upsert({ ...identity, active: true, seenAt: at });
    const reactivated = !created && markSeen(store, repo, at);
    if (created || reactivated) emitActivated(context, repo.id);
    context.broadcast({ event: 'repo', data: { repoId: repo.id } });
    return { repo, activated: created || reactivated };
  }

  async function track(context: DaemonContext, request: SocketRequestOf<'track'>): Promise<SocketSuccessResponses['track']> {
    const active = need(collector, 'collector');
    const identity = await identifyRepo(request.dir);
    const at = requestTime(request.at, now());
    const { repo } = see(context, identity, at);
    later(async () => {
      await active.request(repo.id, 'full', 'high');
      if (request.agent) await active.markAgent(repo.id, request.dir, at);
    }, context);
    return { ok: true, repo: { id: repo.id, name: repo.name } };
  }

  async function register(context: DaemonContext, request: SocketRequestOf<'register'>): Promise<SocketSuccessResponses['register']> {
    const store = need(db, 'database');
    const active = need(collector, 'collector');
    const identities = await mapLimit(request.dirs, REGISTER_CONCURRENCY, async (dir): Promise<RepoIdentity | null> => {
      try {
        return await identifyRepo(dir);
      } catch (error) {
        context.log.warn(`register: skipping ${dir}: ${errorMessage(error)}`);
        return null;
      }
    });
    const seen = new Set<string>();
    const fresh: number[] = [];
    let known = 0;
    const at = now().toISOString();
    for (const identity of identities) {
      if (identity === null || seen.has(identity.gitCommonDir)) continue;
      seen.add(identity.gitCommonDir);
      const { repo, created } = store.repos.upsert({ ...identity, active: false, seenAt: at });
      if (created) fresh.push(repo.id);
      else known++;
    }
    for (const repoId of fresh) context.broadcast({ event: 'repo', data: { repoId } });
    later(() => Promise.all(fresh.map((repoId) => active.request(repoId, 'full', 'low'))), context);
    return { ok: true, registered: fresh.length, known };
  }

  const plugin: DaemonPlugin = {
    name: 'collection',
    async setup(context: DaemonContext) {
      // The shared connection; dbPlugin, listed before this plugin, owns and closes it.
      const opened = await getDb(context);
      db = opened;
      const snapshots = createSnapshotPool({
        runner: options.runner ?? 'thread',
        size: options.poolSize ?? defaultPoolSize(availableParallelism()),
        ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
        ...(options.jobTimeoutMs === undefined ? {} : { timeoutMs: options.jobTimeoutMs }),
        onWorkerLost: (reason) => {
          context.log.warn(`snapshot worker replaced: ${reason}`);
        },
      });
      const created = createCollector({
        db: opened,
        snapshots,
        broadcast: (event) => {
          context.broadcast(event);
        },
        log: context.log,
        now,
        // gh runs through the hardened runner (ADR-032): settings.tools read on every call, no binary
        // inside a registered repo, every call in daemon.log with its stderr redacted.
        gh:
          options.gh ??
          createGhRunner({
            env: context.env,
            toolSetting: (name) => readToolSetting(context.paths.settings, name),
            repoRoots: () => opened.repos.list().map((repo) => repo.path),
            log: context.log,
          }),
        // settings.json is read on every collection, so `diffcity trust` needs no restart (ADR-030).
        isTrusted: createTrustCheck(context.paths.settings, {
          onInvalid: (message) => {
            context.log.warn(`settings: ${message}`);
          },
        }),
        // Read with the trust, on every collection: a rules edit needs no restart either.
        ruleSettings: createRuleSettingsReader(context.paths.settings),
        onListed: (repoId, worktrees) => {
          listed.emit(repoId, worktrees);
        },
      });
      collector = created;
      context.setCollectingCounter(() => created.collecting);
      provideRuntime(context, {
        collecting: (repoId) => created.isCollecting(repoId),
        notes: (repoId) => created.notes(repoId),
      });
      provideRepoOpen(context, (repoId) => open(context, repoId));
      context.socket.handle('track', (request) => track(context, request));
      context.socket.handle('register', (request) => register(context, request));
      context.socket.handle('import', (request) =>
        handleImport(
          {
            db: opened,
            collector: created,
            broadcast: (event) => {
              context.broadcast(event);
            },
            see: (identity, at) => see(context, identity, at),
            time: (at) => requestTime(at, now()),
            waitMs: options.importWaitMs ?? IMPORT_SNAPSHOT_WAIT_MS,
          },
          request,
        ),
      );
    },
    start(context) {
      const active = need(collector, 'collector');
      const repos = need(db, 'database')
        .repos.list()
        .filter((repo) => repo.active);
      later(() => Promise.all(repos.map((repo) => active.request(repo.id, 'full', 'low'))), context);
    },
    async stop() {
      // Safe whatever setup reached: only what was opened is closed.
      const current = collector;
      collector = null;
      if (current !== null) await current.close();
      // The connection belongs to dbPlugin, which closes it after this plugin stops.
      db = null;
    },
  };

  return {
    plugin,
    db: () => need(db, 'database'),
    collector: () => need(collector, 'collector'),
    onActivated: (listener) => activated.add(listener),
    onListed: (listener) => listed.add(listener),
  };
}
