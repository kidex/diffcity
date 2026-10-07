// own-files/no-recollect-loop (SPEC.md section 3a, ADR-036 Q6), end to end:
// the real collector and working tree watcher, a branch checked out with no
// uncommitted change, an import over the socket, a fix queued through the
// DC-100 route (which writes .diffcity/fix-queue.json) and a
// .diffcity/findings.json written as /code-review would. None of it reaches
// the watcher, no snapshot is computed and the change stays clean. Then
// .diffcity/spec.md, a normal file, does reach it.

import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sendRequest } from '../../../src/daemon/client.js';
import { createWatch, type Watch } from '../../../src/daemon/watcher/plugin.js';
import type { WatchEvent } from '../../../src/daemon/watcher/watchers.js';
import { waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon } from '../collect/collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

/** Longer than the watcher's 2 s debounce: a collection an event asked for would have started. */
const QUIET_MS = 3500;

describe('own files and the watcher (ADR-036 Q6)', () => {
  it('own-files/no-recollect-loop: an import, a queued fix and findings.json cause no event, no snapshot and no dirty flag', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/totals');
    await repo.commit('sum the cart', { 'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n' });
    const events: WatchEvent[] = [];
    let watch: Watch | null = null;
    const test = await startTestDaemon(
      { gh: ghNotInstalled() },
      {
        api: true,
        plugins: (collection) => {
          watch = createWatch(collection, { onEvent: (event) => events.push(event) });
          return [watch.plugin];
        },
      },
    );
    const tracked = await test.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    const repoId = tracked.repo.id;
    const root = await realpath(repo.dir);
    await waitFor(() => (watch?.watchers().watchedWorktrees(repoId) ?? []).includes(root), 10_000, 'the working tree watcher');
    await test.idle();

    const db = test.collection.db();
    const change = db.changes.listLive(repoId).find((candidate) => candidate.ref === 'branch:feature/totals');
    if (change === undefined) throw new Error('change not collected');
    expect(change.dirty).toBe(false);
    const before = db.snapshots.latest(change.id);
    if (before === null) throw new Error('no snapshot');

    const imported = await sendRequest(
      test.daemon.info.socket,
      {
        v: 1,
        type: 'import',
        dir: repo.dir,
        findings: [{ source: 'claude', severity: 'high', category: 'correctness', file: 'src/cart/total.ts', line: 2, title: 'Total ignores refunds', message: 'An invented finding.' }],
        warnings: [],
        sources: ['claude'],
        at: new Date().toISOString(),
      },
      { timeoutMs: 40_000 },
    );
    expect(imported).toMatchObject({ ok: true, imported: 1, anchoredAgainst: 'current-snapshot' });
    await test.idle();
    const settled = db.snapshots.latest(change.id);
    const startedBefore = test.events().filter((record) => record.event === 'collect' && record.data['state'] === 'started').length;
    events.length = 0;

    const [stored] = db.findings.list(change.id);
    if (stored === undefined) throw new Error('finding not stored');
    const queued = await call(test.daemon.info.port, 'POST', `/api/changes/${String(change.id)}/findings/${stored.key}/fix`);
    expect(queued.status).toBe(200);
    expect(existsSync(join(repo.dir, '.diffcity', 'fix-queue.json'))).toBe(true);
    await repo.write({ '.diffcity/findings.json': '[]\n' });

    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    expect(events).toEqual([]);
    expect(test.events().filter((record) => record.event === 'collect' && record.data['state'] === 'started')).toHaveLength(startedBefore);
    await test.idle();
    expect(db.snapshots.latest(change.id)).toEqual(settled);
    expect(settled?.id).toBe(before.id);
    expect(db.changes.get(change.id)?.dirty).toBe(false);
    expect(db.changes.listLive(repoId).filter((candidate) => candidate.kind === 'draft')).toEqual([]);

    // The watcher is live, and .diffcity/spec.md is a normal file.
    await repo.write({ '.diffcity/spec.md': '# Totals\n' });
    await waitFor(() => events.some((event) => event.path === join(root, '.diffcity', 'spec.md')), 10_000, 'the spec.md event');
    await waitFor(() => db.changes.get(change.id)?.dirty === true, 15_000, 'the change to turn dirty');
    await test.idle();
  });
});
