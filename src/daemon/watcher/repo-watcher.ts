// The watchers of one active repo (ADR-020, SPEC.md section 3a C4):
//
// - git: one chokidar instance on the git common dir, filtered to HEAD,
//   packed-refs, refs/** and the HEAD of each linked worktree (gitIgnoreMatcher);
// - working trees: one watcher per working tree, at most MAX_WORKTREES,
//   ignoring `.git`, `node_modules`, what git ignores and the linked worktrees
//   nested inside it. The ignored set is recomputed after each collection
//   (syncWorktrees) and on any `.gitignore` event.
//
// The working tree backend depends on the platform (ADR-020 amendment):
//
// - macOS: one recursive `fs.watch` per working tree, a single FSEvents stream
//   that holds no descriptor per file or directory; events are filtered by the
//   same ignore matcher. chokidar would open one kqueue descriptor per file.
// - elsewhere: chokidar, which skips the ignored directories entirely (one
//   inotify watch per watched directory on Linux).
//
// Budget: a working tree with more than DIR_BUDGET directories to watch is not
// watched, and the repo reports `git-only`, on both backends. The directories
// are counted before the watcher starts (countWatchedDirs stops at the budget),
// so a huge tree never registers its watchers at all; chokidar's are counted
// again after `ready`. A watcher error for exhausted resources (EMFILE, ENFILE,
// ENOSPC) also falls back to `git-only` for that working tree, on both
// backends. The git watcher always stays.
//
// Reconcile (chokidar only): on Linux chokidar reads a new directory and only
// then puts its inotify watch on it, so a file or subdirectory created in
// between is never watched, and edits inside a missed subdirectory produce no
// event at all. Each `addDir` schedules a re-scan of that directory
// RECONCILE_DELAY_MS later, and every refresh (after each collection, and on a
// `.gitignore` event) re-scans the whole working tree within the budget. What
// the watcher does not hold is added to it and reported as an event, so the
// debounce asks for one collection of that working tree.
//
// Symlinks are never added: chokidar cannot hold a dangling one, and add() of a
// symlink lists it under its absolute path and emits `add` on every call, which
// would loop through collection, refresh and add again. A symlink the watcher
// does not hold is reported once, like any missed path, and then left alone:
// chokidar gives no event when a dangling link appears, so without that report
// a new one would wait for an unrelated collection.

import { watch as fsWatch, type FSWatcher as NativeWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { countWatchedDirs, gitIgnoreMatcher, ignoreMatcher, listIgnored, missingFromWatched, topmostDirs, unheldLinks, walkWatched, type IgnoredSet, type WalkEntry } from '../../core/watch/index.js';
import { systemClock, type Clock, type TimerHandle } from '../clock.js';
import { errorMessage, type Logger } from '../log.js';

/** Working trees watched per repo (ADR-020). */
export const MAX_WORKTREES = 8;

/** Directories watched per working tree before the repo falls back to `git-only` (ADR-020). */
export const DIR_BUDGET = 10_000;

/** Watcher errors that mean the machine ran out of watch resources. */
const EXHAUSTED = new Set(['EMFILE', 'ENFILE', 'ENOSPC']);

const EMPTY: IgnoredSet = { dirs: new Set(), files: new Set() };

/** Delay between a chokidar `addDir` and the re-scan of that directory. */
export const RECONCILE_DELAY_MS = 250;

/** The editor swap files chokidar ignores with `atomic` on, its default with fs.watch (chokidar's DOT_RE). */
const CHOKIDAR_ATOMIC = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;

/** How a working tree is watched: one recursive fs.watch (FSEvents), or chokidar. */
export type WorktreeBackend = 'recursive' | 'chokidar';

/** `recursive` on macOS, `chokidar` elsewhere (ADR-020 amendment). */
export const DEFAULT_WORKTREE_BACKEND: WorktreeBackend = process.platform === 'darwin' ? 'recursive' : 'chokidar';

export interface RepoWatcherOptions {
  repoId: number;
  /** Realpath of the git common dir. */
  commonDir: string;
  log: Logger;
  budget?: number;
  /** Defaults to DEFAULT_WORKTREE_BACKEND. */
  backend?: WorktreeBackend;
  /** Runs the reconcile timers (chokidar backend); defaults to the system clock. */
  reconcileClock?: Clock;
  /** Defaults to RECONCILE_DELAY_MS. */
  reconcileDelayMs?: number;
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
  /** A reconcile pass is scheduled or running in one of the working trees. */
  reconciling(): boolean;
  /** Closes every watcher; waits for the closes. */
  close(): Promise<void>;
}

interface WorktreeWatcher {
  start(): Promise<void>;
  refresh(): Promise<void>;
  close(): Promise<void>;
  readonly running: boolean;
  readonly reconciling: boolean;
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
  backend: WorktreeBackend;
  reconcileClock: Clock;
  reconcileDelayMs: number;
  log: Logger;
  onEvent(path: string): void;
  /** The working tree cannot be watched (over budget or out of resources); the watcher has closed. */
  onGiveUp(reason: string): void;
}

function createWorktreeWatcher(options: WorktreeWatcherOptions): WorktreeWatcher {
  const { root, budget, log } = options;
  let ignored = ignoreMatcher(root, EMPTY, options.others());
  let watcher: FSWatcher | null = null;
  let native: NativeWatcher | null = null;
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
  /** What chokidar leaves out: our ignores plus its own atomic-write filter. */
  const isUnwatched = (path: string): boolean => ignored(path) || CHOKIDAR_ATOMIC.test(path);

  // Reconcile state (chokidar backend).
  const { reconcileClock: clock } = options;
  /** Directories waiting for their re-scan. */
  const scheduled = new Set<string>();
  let timer: { handle: TimerHandle } | null = null;
  /** Passes run one at a time. */
  let passes: Promise<void> = Promise.resolve();
  let queuedPasses = 0;
  /**
   * Paths a pass already added and reported. A path the watcher still does not
   * hold afterwards (chokidar skips unreadable files, say) is added again but
   * not reported again, so a lasting difference cannot loop into collections.
   */
  let reported = new Set<string>();

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
        if (watcher !== null && !isClosed()) await enqueuePass([root], true);
      } while (askedAgain() && !isClosed());
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** Schedules a re-scan of `dirs`; one timer for every directory that arrives before it fires. */
  function scheduleReconcile(dirs: Iterable<string>): void {
    if (closed) return;
    for (const dir of dirs) scheduled.add(dir);
    if (timer !== null || scheduled.size === 0) return;
    const handle = clock.setTimeout(() => {
      timer = null;
      const batch = topmostDirs(scheduled);
      scheduled.clear();
      void enqueuePass(batch, false);
    }, options.reconcileDelayMs);
    timer = { handle };
  }

  function enqueuePass(dirs: readonly string[], whole: boolean): Promise<void> {
    queuedPasses++;
    const pass = passes
      .then(() => reconcile(dirs, whole))
      .catch((error: unknown) => {
        log.warn(`watch: cannot reconcile ${root}: ${errorMessage(error)}`);
      })
      .finally(() => {
        queuedPasses--;
      });
    passes = pass;
    return pass;
  }

  /**
   * Walks `dirs` (the whole working tree when `whole`), adds to chokidar what
   * it does not hold, and reports what is new as events. Past the budget, the
   * working tree falls back to `git-only`.
   */
  async function reconcile(dirs: readonly string[], whole: boolean): Promise<void> {
    const current = watcher;
    if (current === null || isClosed()) return;
    const found: WalkEntry[] = [];
    for (const dir of dirs) {
      if (dir !== root && isUnwatched(dir)) continue;
      const walk = await walkWatched(dir, isUnwatched, budget);
      if (isClosed() || watcher !== current) return;
      if (walk.over) {
        await giveUp(`more than ${String(budget)} directories`);
        return;
      }
      for (const entry of walk.entries) found.push(entry);
    }
    const watched = current.getWatched();
    const missing = missingFromWatched(found, watched);
    const links = unheldLinks(found, watched);
    const missingPaths = new Set(missing.map((entry) => entry.path));
    /** What the watcher still lacks: a path in `reported` stays there while it is. */
    const lacking = new Set([...missingPaths, ...links.map((entry) => entry.path)]);
    if (whole) reported = new Set([...reported].filter((path) => lacking.has(path)));
    else for (const entry of found) if (!lacking.has(entry.path)) reported.delete(entry.path);
    if (lacking.size === 0) return;
    if (missing.length > 0) {
      // add() reopens a closed chokidar watcher: checked right before, with no await in between.
      if (isClosed() || watcher !== current) return;
      current.add([...missingPaths]);
    }
    const fresh = [...missing, ...links].filter((entry) => !reported.has(entry.path));
    if (fresh.length === 0) return;
    for (const entry of fresh) reported.add(entry.path);
    log.info(`watch: ${root}: ${String(fresh.length)} paths the watcher missed, now watched or reported`);
    for (const entry of fresh) onPath(entry.path);
    // chokidar reads the added directories before watching them: the same gap, so look again.
    if (fresh.some((entry) => !entry.link)) scheduleReconcile([...dirs, ...fresh.filter((entry) => entry.dir).map((entry) => entry.path)]);
  }

  function stopReconcile(): void {
    if (timer !== null) clock.clearTimeout(timer.handle);
    timer = null;
    scheduled.clear();
  }

  async function giveUp(reason: string): Promise<void> {
    if (closed) return;
    closed = true;
    signalClosed();
    stopReconcile();
    closeAll();
    const current = watcher;
    watcher = null;
    await current?.close();
    options.onGiveUp(reason);
  }

  /** Closes the recursive watcher, if any (synchronous). */
  function closeAll(): void {
    native?.close();
    native = null;
  }

  const onError = (error: unknown): void => {
    const code = errorCode(error);
    log.warn(`watch: ${root}: ${errorMessage(error)}`);
    if (code !== undefined && EXHAUSTED.has(code)) void giveUp(`out of watch resources (${code})`);
  };

  const onPath = (path: string): void => {
    if (isClosed() || isIgnored(path)) return;
    if (basename(path) === '.gitignore') void refresh();
    options.onEvent(path);
  };

  /** The macOS backend: one FSEvents stream for the whole tree, filtered here. */
  function startRecursive(dirs: number): void {
    let created: NativeWatcher;
    try {
      created = fsWatch(root, { recursive: true, persistent: true }, (_event, filename) => {
        if (filename === null) return;
        onPath(join(root, filename));
      });
    } catch (error) {
      onError(error);
      return;
    }
    native = created;
    created.on('error', onError);
    log.info(`watching ${root}: ${String(dirs)} directories, one recursive fs.watch`);
  }

  return {
    get running() {
      return (watcher !== null || native !== null) && !closed;
    },
    get reconciling() {
      return timer !== null || queuedPasses > 0;
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
      if (options.backend === 'recursive') {
        startRecursive(dirs);
        return;
      }
      const created = watch(root, { ignoreInitial: true, followSymlinks: false, ignored: isIgnored });
      watcher = created;
      created.on('all', (event, path) => {
        if (event === 'addDir' && !isClosed() && !isIgnored(path)) scheduleReconcile([path]);
        onPath(path);
      });
      created.on('error', onError);
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
      stopReconcile();
      closeAll();
      const current = watcher;
      watcher = null;
      await current?.close();
      await refreshing?.catch(() => undefined);
      await passes;
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
      backend: options.backend ?? DEFAULT_WORKTREE_BACKEND,
      reconcileClock: options.reconcileClock ?? systemClock,
      reconcileDelayMs: options.reconcileDelayMs ?? RECONCILE_DELAY_MS,
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
    reconciling: () => [...worktrees.values()].some((watcher) => watcher.reconciling),
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
