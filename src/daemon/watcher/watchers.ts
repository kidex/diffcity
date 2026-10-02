// The watchers of every active repo (ADR-020, SPEC.md section 3a C4). Events
// go through one debouncer keyed by (repo, scope):
//
// - a git event → scope `refs`;
// - an event in working tree W → scope `worktree:W`, so the collector
//   recomputes only the change W is folded into, or W's Draft.
//
// A debounced key asks the collector for that scope at `normal` priority.
// Inactive repos have no watcher. Starts run one repo at a time, so a daemon
// start with many active repos does not walk them all at once.

import { realpath } from 'node:fs/promises';
import { listWorktreeEntries } from '../../core/changes/identity.js';
import type { CollectorPort, CollectScope, RepoRecord, WatchMode } from '../../core/model/types.js';
import type { Clock } from '../clock.js';
import { errorMessage, type Logger } from '../log.js';
import { createDebouncer, type Debouncer } from './debounce.js';
import { createRepoWatcher, type RepoWatcher, type WorktreeBackend } from './repo-watcher.js';

export interface WatchEvent {
  repoId: number;
  scope: CollectScope;
  path: string;
}

export interface WatchersOptions {
  collector: CollectorPort;
  clock: Clock;
  log: Logger;
  /** Directory budget per working tree; defaults to DIR_BUDGET. */
  budget?: number;
  /** Working tree backend; defaults to DEFAULT_WORKTREE_BACKEND (recursive fs.watch on macOS). */
  backend?: WorktreeBackend;
  debounceMs?: number;
  maxWaitMs?: number;
  /** A repo's watch mode changed (it went `git-only`). */
  onModeChange?: (repoId: number) => void;
  /** Every event that passed the filters, before the debounce. For tests and logs. */
  onEvent?: (event: WatchEvent) => void;
}

export interface Watchers {
  /** Starts the watchers of an active repo; idempotent. Resolves once they are ready. */
  start(repo: RepoRecord): Promise<void>;
  /** Stops a repo's watchers and drops its pending events. */
  stop(repoId: number): Promise<void>;
  /** The working trees a collection just listed: watchers follow them and recompute their ignores. */
  worktreesListed(repoId: number, paths: readonly string[]): void;
  /** `full` or `git-only` for a watched repo, null when it is not watched. */
  mode(repoId: number): Exclude<WatchMode, 'off'> | null;
  /** Ids of the watched repos. */
  watched(): number[];
  /** The working trees watched in a repo. */
  watchedWorktrees(repoId: number): string[];
  /** Pending debounced keys. */
  pending(): number;
  /** Stops everything; waits for every watcher to close. */
  close(): Promise<void>;
}

const SEPARATOR = '\0';

/** The working trees of a repo (realpaths, main first), without bare or prunable ones. */
async function worktreePaths(dir: string): Promise<string[]> {
  const entries = (await listWorktreeEntries(dir)).filter((entry) => !entry.bare && !entry.prunable);
  const paths = await Promise.all(entries.map((entry) => realpath(entry.path).catch(() => null)));
  return paths.filter((path) => path !== null);
}

interface Entry {
  watcher: RepoWatcher;
  ready: Promise<void>;
}

export function createWatchers(options: WatchersOptions): Watchers {
  const { collector, log } = options;
  const entries = new Map<number, Entry>();
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const debouncer: Debouncer = createDebouncer({
    clock: options.clock,
    ...(options.debounceMs === undefined ? {} : { waitMs: options.debounceMs }),
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
    fire: (key) => {
      const at = key.indexOf(SEPARATOR);
      const repoId = Number(key.slice(0, at));
      const scope = key.slice(at + 1) as CollectScope;
      if (!entries.has(repoId)) return;
      void collector.request(repoId, scope, 'normal');
    },
  });

  const push = (repoId: number, scope: CollectScope, path: string): void => {
    options.onEvent?.({ repoId, scope, path });
    debouncer.push(`${String(repoId)}${SEPARATOR}${scope}`);
  };

  async function open(repo: RepoRecord, watcher: RepoWatcher): Promise<void> {
    try {
      await watcher.start();
      await watcher.syncWorktrees(await worktreePaths(repo.path));
    } catch (error) {
      log.warn(`watch: cannot watch ${repo.name} (repo ${String(repo.id)}): ${errorMessage(error)}`);
    }
  }

  return {
    start(repo) {
      const current = entries.get(repo.id);
      if (current !== undefined) return current.ready;
      if (closed) return Promise.resolve();
      const watcher = createRepoWatcher({
        repoId: repo.id,
        commonDir: repo.gitCommonDir,
        log,
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        ...(options.backend === undefined ? {} : { backend: options.backend }),
        onGit: (path) => {
          push(repo.id, 'refs', path);
        },
        onWorktree: (worktree, path) => {
          push(repo.id, `worktree:${worktree}`, path);
        },
        onModeChange: () => options.onModeChange?.(repo.id),
      });
      // One repo starts at a time; a repo stopped while queued is skipped.
      const ready = queue.then(() => (entries.get(repo.id)?.watcher === watcher ? open(repo, watcher) : undefined));
      queue = ready;
      entries.set(repo.id, { watcher, ready });
      return ready;
    },
    async stop(repoId) {
      const entry = entries.get(repoId);
      if (entry === undefined) return;
      entries.delete(repoId);
      debouncer.cancel((key) => key.startsWith(`${String(repoId)}${SEPARATOR}`));
      await entry.watcher.close();
    },
    worktreesListed(repoId, paths) {
      const entry = entries.get(repoId);
      if (entry === undefined) return;
      // After the start, so the first listing never races the initial one.
      void entry.ready.then(() => entry.watcher.syncWorktrees(paths));
    },
    mode: (repoId) => entries.get(repoId)?.watcher.mode ?? null,
    watched: () => [...entries.keys()],
    watchedWorktrees: (repoId) => entries.get(repoId)?.watcher.watchedWorktrees() ?? [],
    pending: () => debouncer.pending(),
    async close() {
      closed = true;
      debouncer.close();
      const all = [...entries.values()];
      entries.clear();
      await Promise.all(all.map((entry) => entry.watcher.close()));
    },
  };
}
