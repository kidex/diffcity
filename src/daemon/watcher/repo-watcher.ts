// The watchers of one active repo (ADR-020, SPEC.md section 3a C4):
//
// - git: one chokidar instance on the git common dir, filtered to HEAD,
//   packed-refs, refs/** and the HEAD of each linked worktree (gitIgnoreMatcher);
// - working trees: one chokidar instance per working tree, at most
//   MAX_WORKTREES, ignoring `.git`, `node_modules`, what git ignores and the
//   linked worktrees nested inside it. The ignored set is recomputed after each
//   collection (syncWorktrees) and on any `.gitignore` event.
//
// Budget: a working tree with more than DIR_BUDGET directories to watch is not
// watched, and the repo reports `git-only`. The directories are counted before
// chokidar starts (countWatchedDirs stops at the budget), so a huge tree never
// registers its watchers at all, and counted again after `ready`. A watcher
// error for exhausted resources (EMFILE, ENFILE, ENOSPC) also falls back to
// `git-only` for that working tree: on macOS chokidar holds one descriptor per
// watched file. The git watcher always stays.

import { basename } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { countWatchedDirs, gitIgnoreMatcher, ignoreMatcher, listIgnored, type IgnoredSet } from '../../core/watch/index.js';
import { errorMessage, type Logger } from '../log.js';

/** Working trees watched per repo (ADR-020). */
export const MAX_WORKTREES = 8;

/** Directories watched per working tree before the repo falls back to `git-only` (ADR-020). */
export const DIR_BUDGET = 10_000;

/** Watcher errors that mean the machine ran out of watch resources. */
const EXHAUSTED = new Set(['EMFILE', 'ENFILE', 'ENOSPC']);

const EMPTY: IgnoredSet = { dirs: new Set(), files: new Set() };

export interface RepoWatcherOptions {
  repoId: number;
  /** Realpath of the git common dir. */
  commonDir: string;
  log: Logger;
  budget?: number;
  /** A change under refs, packed-refs or a HEAD. */
  onGit(path: string): void;
  /** A change in the working tree at `worktree`. */
  onWorktree(worktree: string, path: string): void;
  /** The repo went from `full` to `git-only`. */
  onModeChange(): void;
}

export interface RepoWatcher {
  readonly mode: 'full' | 'git-only';
  /** Starts the git watcher. */
  start(): Promise<void>;
  /**
   * The repo's working trees (realpaths, main first), as the last collection
   * listed them: watches the first MAX_WORKTREES, stops the others, and
   * recomputes the ignored set of those already watched.
   */
  syncWorktrees(paths: readonly string[]): Promise<void>;
  /** The working trees with a running watcher. */
  watchedWorktrees(): string[];
  /** Closes every watcher; waits for the closes. */
  close(): Promise<void>;
}

interface WorktreeWatcher {
  start(): Promise<void>;
  refresh(): Promise<void>;
  close(): Promise<void>;
  readonly running: boolean;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** Resolves on `ready`, or as soon as `closed` resolves. */
function readyOrClosed(watcher: FSWatcher, closed: Promise<void>): Promise<void> {
  return Promise.race([new Promise<void>((resolve) => watcher.once('ready', () => { resolve(); })), closed]);
}

interface WorktreeWatcherOptions {
  root: string;
  /** Every other working tree of the repo, for the nested ones. */
  others: () => readonly string[];
  budget: number;
  log: Logger;
  onEvent(path: string): void;
  /** The working tree cannot be watched (over budget or out of resources); the watcher has closed. */
  onGiveUp(reason: string): void;
}

function createWorktreeWatcher(options: WorktreeWatcherOptions): WorktreeWatcher {
  const { root, budget, log } = options;
  let ignored = ignoreMatcher(root, EMPTY, options.others());
  let watcher: FSWatcher | null = null;
  /** Directories unwatched because they became ignored; watched again if they stop being ignored. */
  const unwatched = new Set<string>();
  let closed = false;
  // Read through a function: closed flips in other callbacks while a start awaits.
  const isClosed = (): boolean => closed;
  let signalClosed = (): void => undefined;
  const closedSignal = new Promise<void>((resolve) => {
    signalClosed = resolve;
  });
  let refreshing: Promise<void> | null = null;
  let again = false;
  const askedAgain = (): boolean => again;

  const isIgnored = (path: string): boolean => ignored(path);

  async function recompute(): Promise<void> {
    let set: IgnoredSet;
    try {
      set = await listIgnored(root);
    } catch (error) {
      // A working tree removed meanwhile, say: keep the previous set.
      log.warn(`watch: cannot list the ignored paths of ${root}: ${errorMessage(error)}`);
      return;
    }
    if (closed) return;
    ignored = ignoreMatcher(root, set, options.others());
    const current = watcher;
    if (current === null) return;
    for (const dir of Object.keys(current.getWatched())) {
      if (dir !== root && ignored(dir)) {
        current.unwatch(dir);
        unwatched.add(dir);
      }
    }
    for (const dir of [...unwatched]) {
      if (ignored(dir)) continue;
      unwatched.delete(dir);
      current.add(dir);
    }
  }

  /** Serialized: one recompute at a time, plus at most one more for requests that came meanwhile. */
  function refresh(): Promise<void> {
    if (refreshing !== null) {
      again = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        again = false;
        await recompute();
      } while (askedAgain() && !isClosed());
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function giveUp(reason: string): Promise<void> {
    if (closed) return;
    closed = true;
    signalClosed();
    const current = watcher;
    watcher = null;
    await current?.close();
    options.onGiveUp(reason);
  }

  return {
    get running() {
      return watcher !== null && !closed;
    },
    async start() {
      await refresh();
      if (closed) return;
      const dirs = await countWatchedDirs(root, isIgnored, budget);
      if (isClosed()) return;
      if (dirs > budget) {
        await giveUp(`more than ${String(budget)} directories`);
        return;
      }
      const created = watch(root, { ignoreInitial: true, followSymlinks: false, ignored: isIgnored });
      watcher = created;
      created.on('all', (_event, path) => {
        if (closed || isIgnored(path)) return;
        if (basename(path) === '.gitignore') void refresh();
        options.onEvent(path);
      });
      created.on('error', (error) => {
        const code = errorCode(error);
        log.warn(`watch: ${root}: ${errorMessage(error)}`);
        if (code !== undefined && EXHAUSTED.has(code)) void giveUp(`out of watch resources (${code})`);
      });
      await readyOrClosed(created, closedSignal);
      if (isClosed()) return;
      const watched = Object.keys(created.getWatched()).filter((dir) => dir === root || dir.startsWith(`${root}/`));
      if (watched.length > budget) {
        await giveUp(`more than ${String(budget)} directories`);
        return;
      }
      const files = Object.entries(created.getWatched())
        .filter(([dir]) => dir === root || dir.startsWith(`${root}/`))
        .reduce((sum, [, names]) => sum + names.length, 0);
      log.info(`watching ${root}: ${String(watched.length)} directories, ${String(files - watched.length + 1)} files`);
    },
    refresh,
    async close() {
      closed = true;
      signalClosed();
      const current = watcher;
      watcher = null;
      await current?.close();
      await refreshing?.catch(() => undefined);
    },
  };
}

export function createRepoWatcher(options: RepoWatcherOptions): RepoWatcher {
  const { commonDir, log } = options;
  const budget = options.budget ?? DIR_BUDGET;
  let git: FSWatcher | null = null;
  const worktrees = new Map<string, WorktreeWatcher>();
  /** Working trees that cannot be watched; not retried while the repo stays active. */
  const givenUp = new Set<string>();
  let listed: readonly string[] = [];
  let mode: 'full' | 'git-only' = 'full';
  let closed = false;
  const isClosed = (): boolean => closed;
  let signalClosed = (): void => undefined;
  const closedSignal = new Promise<void>((resolve) => {
    signalClosed = resolve;
  });
  let syncing: Promise<void> = Promise.resolve();

  function startWorktree(root: string): Promise<void> {
    const watcher = createWorktreeWatcher({
      root,
      others: () => listed.filter((path) => path !== root),
      budget,
      log,
      onEvent: (path) => {
        options.onWorktree(root, path);
      },
      onGiveUp: (reason) => {
        if (worktrees.get(root) === watcher) worktrees.delete(root);
        givenUp.add(root);
        log.warn(`working tree ${root} not watched (${reason}); repo ${String(options.repoId)} is git-only`);
        if (mode === 'full') {
          mode = 'git-only';
          options.onModeChange();
        }
      },
    });
    worktrees.set(root, watcher);
    return watcher.start().catch((error: unknown) => {
      log.warn(`watch: cannot watch ${root}: ${errorMessage(error)}`);
    });
  }

  async function sync(paths: readonly string[]): Promise<void> {
    if (closed) return;
    listed = paths;
    const wanted = new Set(paths.slice(0, MAX_WORKTREES));
    const closing: Promise<void>[] = [];
    for (const [root, watcher] of worktrees) {
      if (wanted.has(root)) continue;
      worktrees.delete(root);
      closing.push(watcher.close());
    }
    await Promise.all(closing);
    const work: Promise<void>[] = [];
    for (const root of wanted) {
      if (isClosed()) break;
      const current = worktrees.get(root);
      if (current !== undefined) work.push(current.refresh());
      else if (!givenUp.has(root)) work.push(startWorktree(root));
    }
    await Promise.all(work);
  }

  return {
    get mode() {
      return mode;
    },
    async start() {
      if (closed || git !== null) return;
      const ignored = gitIgnoreMatcher(commonDir);
      const created = watch(commonDir, { ignoreInitial: true, followSymlinks: false, ignored });
      git = created;
      created.on('all', (_event, path) => {
        if (closed || ignored(path)) return;
        options.onGit(path);
      });
      created.on('error', (error) => {
        log.warn(`watch: ${commonDir}: ${errorMessage(error)}`);
      });
      await readyOrClosed(created, closedSignal);
    },
    syncWorktrees(paths) {
      // One sync at a time, in call order.
      syncing = syncing.then(() => sync(paths));
      return syncing;
    },
    watchedWorktrees: () => [...worktrees].filter(([, watcher]) => watcher.running).map(([root]) => root),
    async close() {
      closed = true;
      signalClosed();
      const current = git;
      git = null;
      const all = [...worktrees.values()];
      worktrees.clear();
      await Promise.all([current?.close(), ...all.map((watcher) => watcher.close())]);
      await syncing.catch(() => undefined);
      // A sync that was starting a watcher when close() came: close what it opened.
      await Promise.all([...worktrees.values()].map((watcher) => watcher.close()));
      worktrees.clear();
    },
  };
}
