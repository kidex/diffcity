// The watchers on real temporary repos (SPEC.md section 3a C4, ADR-020):
// chokidar runs on real time, the debounce on a manual clock, and the
// collector is a recorder. Each test lets the watchers settle after they
// start, so the events of the repo's own setup are not counted.

import { readdirSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectPriority, CollectScope, RepoRecord } from '../../../src/core/model/types.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import { DEFAULT_WORKTREE_BACKEND, DIR_BUDGET, type WorktreeBackend } from '../../../src/daemon/watcher/repo-watcher.js';
import { createWatchers, type WatchEvent, type Watchers } from '../../../src/daemon/watcher/watchers.js';
import { manualClock, type ManualClock } from '../../helpers/clock.js';
import { waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type CreateRepoOptions, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Request {
  repoId: number;
  scope: CollectScope;
  priority: CollectPriority;
}

interface Watched {
  repo: TempRepo;
  root: string;
  watchers: Watchers;
  clock: ManualClock;
  events: WatchEvent[];
  requests: Request[];
  modeChanges: number[];
  /** Waits for the events of the setup to pass, then forgets them. */
  settle(): Promise<void>;
  /** Rewrites `sentinel.txt` and waits for its event: the earlier writes have been delivered by then. */
  sentinel(): Promise<void>;
}

const REPO_ID = 7;

async function sampleRepo(options: CreateRepoOptions = {}): Promise<TempRepo> {
  const repo = await createRepo({
    name: 'sample-bakery',
    files: { 'src/oven.ts': 'export const heat = 1;\n', 'README.md': '# sample-bakery\n' },
    ...options,
  });
  cleanups.push(() => repo.cleanup());
  return repo;
}

async function watch(repo: TempRepo, options: { budget?: number; backend?: WorktreeBackend } = {}): Promise<Watched> {
  const root = await realpath(repo.dir);
  const record: RepoRecord = {
    id: REPO_ID,
    path: root,
    gitCommonDir: join(root, '.git'),
    name: 'sample-bakery',
    base: 'main',
    active: true,
    tier1Paths: null,
    lastAudit: null,
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    collectError: null,
  };
  const clock = manualClock();
  const events: WatchEvent[] = [];
  const requests: Request[] = [];
  const modeChanges: number[] = [];
  const watchers = createWatchers({
    collector: {
      request: (repoId, scope, priority) => {
        requests.push({ repoId, scope, priority });
        return Promise.resolve({ ok: true });
      },
    },
    clock,
    log: createStreamLogger(new PassThrough()),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.backend === undefined ? {} : { backend: options.backend }),
    onEvent: (event) => events.push(event),
    onModeChange: (repoId) => modeChanges.push(repoId),
  });
  cleanups.push(() => watchers.close());
  // The sentinel exists before the watchers start, so its writes are plain changes.
  await repo.write({ 'sentinel.txt': '0' });
  await watchers.start(record);
  let sentinels = 0;
  return {
    repo,
    root,
    watchers,
    clock,
    events,
    requests,
    modeChanges,
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 300));
      events.length = 0;
      requests.length = 0;
      clock.advance(60_000);
      requests.length = 0;
    },
    async sentinel() {
      sentinels++;
      await repo.write({ 'sentinel.txt': String(sentinels) });
      const path = join(root, 'sentinel.txt');
      await waitFor(() => events.some((event) => event.path === path), 10_000, 'the sentinel event');
    },
  };
}

const paths = (events: WatchEvent[], scope?: CollectScope): string[] =>
  events.filter((event) => scope === undefined || event.scope === scope).map((event) => event.path);

describe('git watcher (C4)', () => {
  it('watch/branch-commit-refs-scope: a commit on a branch → scope `refs`, after 2 s', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/rack');
    const w = await watch(repo);
    await w.settle();
    await repo.git('commit', '--quiet', '--allow-empty', '-m', 'rack');
    const ref = join(w.root, '.git', 'refs', 'heads', 'feature', 'rack');
    await waitFor(() => paths(w.events, 'refs').includes(ref), 10_000, 'the ref event');
    expect(w.events.every((event) => event.scope === 'refs')).toBe(true);
    w.clock.advance(1999);
    expect(w.requests).toEqual([]);
    w.clock.advance(1);
    expect(w.requests).toEqual([{ repoId: REPO_ID, scope: 'refs', priority: 'normal' }]);
  });

  it('watch/head-checkout: a checkout moves HEAD → scope `refs`', async () => {
    const repo = await sampleRepo();
    await repo.git('branch', 'feature/rack');
    const w = await watch(repo);
    await w.settle();
    await repo.checkout('feature/rack');
    const head = join(w.root, '.git', 'HEAD');
    await waitFor(() => paths(w.events, 'refs').includes(head), 10_000, 'the HEAD event');
    w.clock.advance(2000);
    expect(w.requests).toEqual([{ repoId: REPO_ID, scope: 'refs', priority: 'normal' }]);
  });

  it('watch/packed-refs: a change in packed-refs alone → scope `refs`', async () => {
    const repo = await sampleRepo();
    await repo.git('branch', 'feature/old');
    await repo.git('pack-refs', '--all');
    const w = await watch(repo);
    await w.settle();
    // The branch lives only in packed-refs: deleting it rewrites that file.
    await repo.git('update-ref', '-d', 'refs/heads/feature/old');
    const packed = join(w.root, '.git', 'packed-refs');
    await waitFor(() => paths(w.events, 'refs').includes(packed), 10_000, 'the packed-refs event');
    w.clock.advance(2000);
    expect(w.requests).toEqual([{ repoId: REPO_ID, scope: 'refs', priority: 'normal' }]);
  });

  it('ignores the index, objects and logs: staging alone triggers nothing from git', async () => {
    const repo = await sampleRepo();
    await repo.write({ 'src/oven.ts': 'export const heat = 2;\n' });
    const w = await watch(repo);
    await w.settle();
    await repo.git('add', '--all');
    await w.sentinel();
    expect(paths(w.events, 'refs')).toEqual([]);
  });
});

// Both backends on macOS; chokidar only elsewhere (recursive fs.watch is the macOS backend).
const BACKENDS: WorktreeBackend[] = process.platform === 'darwin' ? ['recursive', 'chokidar'] : ['chokidar'];

describe.each(BACKENDS)('working tree watcher (C4, ADR-020), backend %s', (backend) => {
  it('an edit → scope `worktree:<root>`, debounced', async () => {
    const repo = await sampleRepo();
    const w = await watch(repo, { backend });
    await w.settle();
    await repo.write({ 'src/oven.ts': 'export const heat = 2;\n' });
    await repo.write({ 'src/oven.ts': 'export const heat = 3;\n' });
    await waitFor(() => paths(w.events).includes(join(w.root, 'src', 'oven.ts')), 10_000, 'the edit event');
    w.clock.advance(2000);
    expect(w.requests).toEqual([{ repoId: REPO_ID, scope: `worktree:${w.root}`, priority: 'normal' }]);
  });

  it('watch/node-modules-ignored: a write in node_modules → nothing', async () => {
    const repo = await sampleRepo();
    await repo.write({ 'node_modules/left-pad/index.js': 'module.exports = 1;\n' });
    const w = await watch(repo, { backend });
    await w.settle();
    await repo.write({ 'node_modules/left-pad/index.js': 'module.exports = 2;\n', 'packages/cart/node_modules/qs/index.js': 'x\n' });
    await w.sentinel();
    expect(paths(w.events).filter((path) => path.includes('node_modules'))).toEqual([]);
  });

  it('watch/gitignored-dir-ignored: a write in a gitignored directory → nothing', async () => {
    const repo = await sampleRepo({ files: { '.gitignore': 'build/\n*.log\n', 'src/oven.ts': 'export const heat = 1;\n' } });
    await repo.write({ 'build/app.js': 'bundle\n', 'oven.log': 'cold\n' });
    const w = await watch(repo, { backend });
    await w.settle();
    await repo.write({ 'build/app.js': 'bundle 2\n', 'build/assets/new.css': 'body{}\n', 'oven.log': 'warm\n' });
    // oven.log existed when the ignored set was computed; a new ignored file is
    // only known after the next collection recomputes the set (ADR-020 ignores directories).
    await w.sentinel();
    expect(paths(w.events).filter((path) => path.includes('build') || path.endsWith('.log'))).toEqual([]);
  });

  it('watch/gitignore-change-refreshes: a directory newly listed in .gitignore stops producing events', async () => {
    const repo = await sampleRepo();
    await repo.write({ 'cache/data.txt': 'one\n' });
    const w = await watch(repo, { backend });
    await w.settle();
    const data = join(w.root, 'cache', 'data.txt');
    await repo.write({ 'cache/data.txt': 'two\n' });
    await waitFor(() => paths(w.events).includes(data), 10_000, 'the cache event before the ignore');

    await repo.write({ '.gitignore': 'cache/\n' });
    await waitFor(() => paths(w.events).includes(join(w.root, '.gitignore')), 10_000, 'the .gitignore event');
    // The ignored set is recomputed from git on that event.
    await new Promise((resolve) => setTimeout(resolve, 500));
    w.events.length = 0;
    await repo.write({ 'cache/data.txt': 'three\n', 'cache/more.txt': 'x\n' });
    await w.sentinel();
    expect(paths(w.events).filter((path) => path.includes(join(w.root, 'cache')))).toEqual([]);
  });

  it('watch/linked-worktree-own-watcher: a linked worktree has its own watcher and scope', async () => {
    const repo = await sampleRepo({ files: { '.gitignore': '.worktrees/\n', 'src/oven.ts': 'export const heat = 1;\n' } });
    await repo.git('worktree', 'add', '--quiet', '.worktrees/rack', '-b', 'feature/rack');
    const w = await watch(repo, { backend });
    const linked = join(w.root, '.worktrees', 'rack');
    expect(w.watchers.watchedWorktrees(REPO_ID).sort()).toEqual([w.root, linked].sort());
    await w.settle();

    await repo.write({ '.worktrees/rack/src/oven.ts': 'export const heat = 9;\n' });
    await waitFor(() => paths(w.events).includes(join(linked, 'src', 'oven.ts')), 10_000, 'the linked worktree event');
    expect(w.events.map((event) => event.scope)).toEqual(w.events.map(() => `worktree:${linked}`));
    w.clock.advance(2000);
    expect(w.requests).toEqual([{ repoId: REPO_ID, scope: `worktree:${linked}`, priority: 'normal' }]);

    // Its HEAD is watched by the git watcher.
    await repo.git('-C', linked, 'commit', '--quiet', '--allow-empty', '-m', 'rack');
    await waitFor(() => paths(w.events, 'refs').length > 0, 10_000, 'the linked worktree ref event');
  });

  it('follows the working trees a collection lists: a new one is watched, a removed one is not', async () => {
    const repo = await sampleRepo({ files: { '.gitignore': '.worktrees/\n', 'README.md': '# sample-bakery\n' } });
    const w = await watch(repo, { backend });
    await w.settle();
    await repo.git('worktree', 'add', '--quiet', '.worktrees/shelf', '-b', 'feature/shelf');
    const linked = join(w.root, '.worktrees', 'shelf');
    w.watchers.worktreesListed(REPO_ID, [w.root, linked]);
    await waitFor(() => w.watchers.watchedWorktrees(REPO_ID).includes(linked), 10_000, 'the new watcher');
    w.watchers.worktreesListed(REPO_ID, [w.root]);
    await waitFor(() => !w.watchers.watchedWorktrees(REPO_ID).includes(linked), 10_000, 'the removed watcher');
  });

  it('watch/budget-git-only: more than 10,000 directories → `git-only`, the git watcher stays', async () => {
    expect(DIR_BUDGET).toBe(10_000);
    const repo = await sampleRepo();
    const root = await realpath(repo.dir);
    // 101 × 100 empty directories (git does not track them, so none is ignored).
    for (let i = 0; i <= 100; i++) {
      await Promise.all(Array.from({ length: 100 }, (_, j) => mkdir(join(root, 'data', `d${String(i)}`, `e${String(j)}`), { recursive: true })));
    }
    const w = await watch(repo, { backend });
    expect(w.watchers.mode(REPO_ID)).toBe('git-only');
    expect(w.modeChanges).toEqual([REPO_ID]);
    expect(w.watchers.watchedWorktrees(REPO_ID)).toEqual([]);
    await w.settle();
    await repo.git('commit', '--quiet', '--allow-empty', '-m', 'still watched');
    await waitFor(() => paths(w.events, 'refs').length > 0, 10_000, 'the ref event');
  });

  it('a working tree under the budget is `full`', async () => {
    const w = await watch(await sampleRepo(), { backend });
    expect(w.watchers.mode(REPO_ID)).toBe('full');
    expect(w.watchers.watchedWorktrees(REPO_ID)).toEqual([w.root]);
  });
});

describe('descriptors (ADR-020 amendment)', () => {
  it('uses the recursive backend on macOS', () => {
    expect(DEFAULT_WORKTREE_BACKEND).toBe(process.platform === 'darwin' ? 'recursive' : 'chokidar');
  });

  it.skipIf(process.platform !== 'darwin')('a 2,000-file working tree holds no descriptor per file on macOS', async () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 20; d++) for (let f = 0; f < 100; f++) files[`src/d${String(d)}/f${String(f)}.ts`] = `export const v${String(f)} = ${String(d)};\n`;
    const repo = await sampleRepo({ files });
    const descriptors = (): number => readdirSync('/dev/fd').length;
    const before = descriptors();
    const w = await watch(repo);
    expect(w.watchers.watchedWorktrees(REPO_ID)).toEqual([w.root]);
    // The git watcher (chokidar on .git) holds a few, for HEAD and the refs; never one per working tree file.
    expect(descriptors() - before).toBeLessThan(50);
    await w.settle();
    await repo.write({ 'src/d3/f7.ts': 'export const changed = 1;\n' });
    await waitFor(() => paths(w.events).includes(join(w.root, 'src', 'd3', 'f7.ts')), 10_000, 'the edit event');
  });
});

describe('bursts (C4, Q7)', () => {
  it('watch/checkout-no-pile-up: a checkout rewriting 30 files asks one collection per scope, `refs` and its working tree', { timeout: 60_000 }, async () => {
    const repo = await sampleRepo();
    await repo.git('checkout', '--quiet', '-b', 'feature/trays');
    const trays: Record<string, string> = {};
    for (let n = 0; n < 30; n++) trays[`src/trays/tray${String(n)}.ts`] = `export const tray${String(n)} = ${String(n)};\n`;
    await repo.write(trays);
    await repo.git('add', '--all');
    await repo.git('commit', '--quiet', '-m', 'thirty trays');
    await repo.checkout('main');
    const w = await watch(repo);
    await w.settle();

    await repo.checkout('feature/trays');
    await waitFor(() => paths(w.events, 'refs').includes(join(w.root, '.git', 'HEAD')), 10_000, 'the HEAD event');
    await w.sentinel();
    expect(w.events.length).toBeGreaterThan(30);
    w.clock.advance(2000);
    expect(w.requests).toHaveLength(2);
    expect(w.requests).toEqual(
      expect.arrayContaining([
        { repoId: REPO_ID, scope: 'refs', priority: 'normal' },
        { repoId: REPO_ID, scope: `worktree:${w.root}`, priority: 'normal' },
      ]),
    );
    w.clock.advance(60_000);
    expect(w.requests).toHaveLength(2);
  });

  it('watch/node-modules-churn: 5,000 files written under node_modules → no event, no collection', { timeout: 60_000 }, async () => {
    const repo = await sampleRepo();
    const w = await watch(repo);
    await w.settle();
    const files: Record<string, string> = {};
    for (let n = 0; n < 5000; n++) files[`node_modules/pkg${String(Math.floor(n / 50))}/lib/f${String(n % 50)}.js`] = `module.exports = ${String(n)};\n`;
    await repo.write(files);
    await w.sentinel();
    expect(paths(w.events).filter((path) => path.includes('node_modules'))).toEqual([]);
    w.clock.advance(60_000);
    expect(w.requests).toEqual([{ repoId: REPO_ID, scope: `worktree:${w.root}`, priority: 'normal' }]);
  });
});

describe('working tree limit (ADR-020)', () => {
  it('watch/max-8-worktrees: of 10 working trees only the first 8 are watched; an edit in the others is silent', { timeout: 120_000 }, async () => {
    const repo = await sampleRepo({ files: { '.gitignore': '.worktrees/\n', 'src/oven.ts': 'export const heat = 1;\n' } });
    for (let n = 0; n < 9; n++) await repo.git('worktree', 'add', '--quiet', `.worktrees/tray${String(n)}`, '-b', `feature/tray${String(n)}`);
    const w = await watch(repo);
    const watched = w.watchers.watchedWorktrees(REPO_ID);
    expect(watched).toHaveLength(8);
    expect(watched[0]).toBe(w.root);
    expect(w.watchers.mode(REPO_ID)).toBe('full');
    const all = [w.root, ...Array.from({ length: 9 }, (_, n) => join(w.root, '.worktrees', `tray${String(n)}`))];
    const unwatched = all.filter((path) => !watched.includes(path));
    expect(unwatched).toHaveLength(2);
    await w.settle();

    for (const dir of unwatched) await repo.write({ [join(dir.slice(w.root.length + 1), 'src', 'oven.ts')]: 'export const heat = 9;\n' });
    const lastWatched = watched[7];
    if (lastWatched === undefined) throw new Error('missing watcher');
    await repo.write({ [join(lastWatched.slice(w.root.length + 1), 'src', 'oven.ts')]: 'export const heat = 8;\n' });
    await waitFor(() => w.events.some((event) => event.scope === `worktree:${lastWatched}`), 10_000, 'the event of the 8th working tree');
    await w.sentinel();
    for (const dir of unwatched) expect(w.events.filter((event) => event.scope === `worktree:${dir}`)).toEqual([]);
  });
});

describe('stop', () => {
  it('stopping a repo drops its pending events and its watchers', async () => {
    const repo = await sampleRepo();
    const w = await watch(repo);
    await w.settle();
    await repo.write({ 'src/oven.ts': 'export const heat = 5;\n' });
    await waitFor(() => w.events.length > 0, 10_000, 'an event');
    expect(w.watchers.pending()).toBe(1);
    await w.watchers.stop(REPO_ID);
    expect(w.watchers.pending()).toBe(0);
    expect(w.watchers.watched()).toEqual([]);
    expect(w.clock.pending()).toBe(0);
    w.clock.advance(10_000);
    expect(w.requests).toEqual([]);
  });
});
