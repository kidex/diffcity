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
// Sessions (ADR-038): a `track --agent` with a `session` has it validated
// (src/core/session/validate.ts) before anything is read; a refusal is logged
// with a code and the track goes on without it. A valid session is stored in
// the repo its cwd is in (the track's repo when its cwd is in none), linked,
// and read in the session pool (src/daemon/session/tracker.ts). The `sessions`
// request answers `diff --with-sessions` for the change checked out in a
// directory.
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

import { realpath } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { changeOfWorktree, identifyRepo, type RepoIdentity, type WorktreeInfo } from '../../core/changes/index.js';
import { claudeConfigDir } from '../../core/claude/config-dir.js';
import { findRepoRoot } from '../../core/git/change.js';
import { claudeProjectsDir, validateSession, type ValidatedSession } from '../../core/session/validate.js';
import { createRuleSettingsReader, createTrustCheck } from '../../core/settings/index.js';
import type { Db } from '../../core/db/index.js';
import type { CommandRunner } from '../../core/git/index.js';
import type { RepoRecord, SocketSuccessResponses, TrackSession } from '../../core/model/types.js';
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
import { createSessionPool } from '../session/pool.js';
import { createSessionTracker, type SessionTracker } from '../session/tracker.js';
import { sessionViewsOf } from '../session/views.js';

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
  /** How long `import` waits for a snapshot at the current content; defaults to IMPORT_SNAPSHOT_WAIT_MS (tests shorten it). */
  importWaitMs?: number;
  /**
   * The Claude Code configuration directory whose `projects` holds the only
   * transcripts the daemon reads; defaults to CLAUDE_CONFIG_DIR or ~/.claude
   * from the daemon's environment. Tests pass a temporary directory.
   */
  claudeConfigDir?: string;
  /** The delay between a hook and its session read; defaults to SESSION_READ_DELAY_MS (tests shorten it). */
  sessionDelayMs?: number;
  /** The session pool's worker script, for the thread runner; the runner follows `runner`. */
  sessionWorkerUrl?: URL;
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
  /** The session tracker, created in setup; null when the Claude config directory could not be resolved. */
  sessions(): SessionTracker | null;
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
  let sessions: SessionTracker | null = null;
  let projectsDir: string | null = null;
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

  /** The session of a track request when it passes validation; a refusal is logged by code only (ADR-038). */
  async function acceptSession(context: DaemonContext, session: TrackSession): Promise<ValidatedSession | null> {
    if (projectsDir === null || sessions === null) {
      context.log.warn('session refused: no-claude-config-dir');
      return null;
    }
    const checked = await validateSession(session, projectsDir);
    if (!checked.ok) {
      context.log.warn(`session refused: ${checked.code}`);
      return null;
    }
    return checked.session;
  }

  /** Stores and links a valid session in the repo its cwd is in, or in the track's repo when it is in none. */
  async function hookSession(context: DaemonContext, trackRepo: RepoRecord, trackIdentity: RepoIdentity, session: ValidatedSession, at: string): Promise<void> {
    const tracker = need(sessions, 'session tracker');
    let repoId = trackRepo.id;
    const identity = await identifyRepo(session.cwd).catch(() => null);
    if (identity !== null && identity.gitCommonDir !== trackIdentity.gitCommonDir) {
      repoId = see(context, identity, at).repo.id;
      await need(collector, 'collector').request(repoId, 'full', 'high');
    }
    await tracker.hook(repoId, session, at);
  }

  async function track(context: DaemonContext, request: SocketRequestOf<'track'>): Promise<SocketSuccessResponses['track']> {
    const active = need(collector, 'collector');
    const identity = await identifyRepo(request.dir);
    const at = requestTime(request.at, now());
    const { repo } = see(context, identity, at);
    later(async () => {
      // Validated before anything else touches it: a refused session is never read.
      const session = request.agent && request.session !== undefined ? await acceptSession(context, request.session) : null;
      await active.request(repo.id, 'full', 'high');
      if (request.agent) await active.markAgent(repo.id, request.dir, at, session?.sessionId);
      if (session !== null) await hookSession(context, repo, identity, session, at);
    }, context);
    return { ok: true, repo: { id: repo.id, name: repo.name } };
  }

  /** `sessions` (diff --with-sessions): the change checked out in the directory and its sessions, as the API serves them. */
  async function sessionsOfDir(request: SocketRequestOf<'sessions'>): Promise<SocketSuccessResponses['sessions']> {
    const store = need(db, 'database');
    const active = need(collector, 'collector');
    const identity = await identifyRepo(request.dir);
    const repo = store.repos.getByGitCommonDir(identity.gitCommonDir);
    if (repo === null) throw new Error(`${identity.name} is not tracked yet; run diffcity track in it first`);
    const root = await realpath(await findRepoRoot(request.dir));
    const dir = await realpath(request.dir).catch(() => root);
    const worktree = active.worktreeOf(repo.id, dir) ?? { path: root, head: '' };
    const change = changeOfWorktree(store.changes.listLive(repo.id), worktree);
    if (change === null) throw new Error(`no change is checked out in ${worktree.path}: nothing differs from the base`);
    return { ok: true, change: { id: change.id, repoId: repo.id, ref: change.ref }, sessions: sessionViewsOf(store, change) };
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
        // Read with the trust, on every collection: a rules edit needs no restart either.
        ruleSettings: createRuleSettingsReader(context.paths.settings),
        onListed: (repoId, worktrees) => {
          listed.emit(repoId, worktrees);
        },
      });
      collector = created;
      try {
        projectsDir = claudeProjectsDir(options.claudeConfigDir ?? claudeConfigDir(context.env));
      } catch (error) {
        context.log.warn(`sessions: no Claude Code configuration directory: ${errorMessage(error)}`);
        projectsDir = null;
      }
      if (projectsDir !== null) {
        const sessionRunner = options.runner === 'inline' ? 'inline' : 'thread';
        sessions = createSessionTracker({
          db: opened,
          pool: createSessionPool({
            runner: sessionRunner,
            ...(options.sessionWorkerUrl === undefined ? {} : { workerUrl: options.sessionWorkerUrl }),
            onWorkerLost: (reason) => {
              context.log.warn(`session worker replaced: ${reason}`);
            },
          }),
          log: context.log,
          projectsDir,
          worktreeOf: (repoId, dir) => created.worktreeOf(repoId, dir),
          broadcast: (event) => {
            context.broadcast(event);
          },
          now,
          ...(options.sessionDelayMs === undefined ? {} : { delayMs: options.sessionDelayMs }),
        });
      }
      context.setCollectingCounter(() => created.collecting);
      provideRuntime(context, {
        collecting: (repoId) => created.isCollecting(repoId),
        notes: (repoId) => created.notes(repoId),
      });
      provideRepoOpen(context, (repoId) => open(context, repoId));
      context.socket.handle('track', (request) => track(context, request));
      context.socket.handle('register', (request) => register(context, request));
      context.socket.handle('sessions', (request) => sessionsOfDir(request));
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
      const tracker = sessions;
      sessions = null;
      await tracker?.close();
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
    sessions: () => sessions,
  };
}
