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
// On start, every active repo gets one low-priority collection (ADR-020).
//
// Two hooks for the watchers (DC-33): onActivated fires when `track` registers
// a repo or reactivates an inactive one, and when the UI opens an inactive repo
// (provideActivation, called by GET /api/repos/:id, which then also collects
// it once); onListed fires after each collection read a repo's working trees.

import { availableParallelism } from 'node:os';
import { identifyRepo, type RepoIdentity, type WorktreeInfo } from '../../core/changes/index.js';
import { createTrustCheck } from '../../core/settings/index.js';
import type { Db } from '../../core/db/index.js';
import type { CommandRunner } from '../../core/git/index.js';
import type { SocketSuccessResponses } from '../../core/model/types.js';
import { provideActivation } from '../activation.js';
import { getDb } from '../db.js';
import { errorMessage } from '../log.js';
import type { DaemonContext, DaemonPlugin } from '../plugin.js';
import { provideRuntime } from '../runtime.js';
import type { SocketRequestOf } from '../socket/server.js';
import { createCollector, type Collector } from './collector.js';
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
  /** Runs gh; defaults to execFile. Tests inject a stub. */
  gh?: CommandRunner;
  now?: () => Date;
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

  /** Opening an inactive repo in the UI (Q6): active again, watched, and collected once. */
  function reactivate(context: DaemonContext, repoId: number): boolean {
    const store = need(db, 'database');
    const repo = store.repos.get(repoId);
    if (repo === null || repo.active) return false;
    store.repos.setActive(repoId, true);
    emitActivated(context, repoId);
    context.broadcast({ event: 'repo', data: { repoId } });
    const active = need(collector, 'collector');
    later(() => active.request(repoId, 'full', 'normal'), context);
    return true;
  }

  async function track(context: DaemonContext, request: SocketRequestOf<'track'>): Promise<SocketSuccessResponses['track']> {
    const store = need(db, 'database');
    const active = need(collector, 'collector');
    const identity = await identifyRepo(request.dir);
    const at = requestTime(request.at, now());
    const { repo, created } = store.repos.upsert({ ...identity, active: true, seenAt: at });
    if (!created) {
      if (!repo.active) store.repos.setActive(repo.id, true);
      if (at > repo.lastSeenAt) store.repos.touchSeen(repo.id, at);
    }
    if (created || !repo.active) emitActivated(context, repo.id);
    context.broadcast({ event: 'repo', data: { repoId: repo.id } });
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
        ...(options.gh === undefined ? {} : { gh: options.gh }),
        // settings.json is read on every collection, so `diffcity trust` needs no restart (ADR-030).
        isTrusted: createTrustCheck(context.paths.settings, {
          onInvalid: (message) => {
            context.log.warn(`settings: ${message}`);
          },
        }),
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
      provideActivation(context, (repoId) => reactivate(context, repoId));
      context.socket.handle('track', (request) => track(context, request));
      context.socket.handle('register', (request) => register(context, request));
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
