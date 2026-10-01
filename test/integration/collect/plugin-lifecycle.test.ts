// The collection plugin's lifecycle (ADR-015, ADR-021) and the main thread's
// responsiveness while every snapshot worker is busy (SPEC.md section 10).

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollection } from '../../../src/daemon/collector/plugin.js';
import { startDaemon } from '../../../src/daemon/daemon.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import type { DaemonPlugin } from '../../../src/daemon/plugin.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const BUSY_WORKER = new URL('../../fixtures/pool/busy-snapshot-worker.mjs', import.meta.url);

let home: TempHome | null = null;
afterEach(async () => {
  await home?.cleanup();
  home = null;
});

describe('collection plugin lifecycle', () => {
  it('stop is safe when setup never ran', async () => {
    const collection = createCollection({ runner: 'inline' });
    // The context is not used when nothing was opened.
    await collection.plugin.stop?.({} as Parameters<NonNullable<DaemonPlugin['stop']>>[0]);
    expect(() => collection.db()).toThrow(/not open/);
  });

  it('stop after setup without start (a later plugin failed) closes the database and the pool', async () => {
    home = await tempHome();
    const collection = createCollection({ runner: 'thread' });
    const failing: DaemonPlugin = {
      name: 'failing',
      setup() {
        throw new Error('later plugin failed');
      },
    };
    await expect(
      startDaemon({ env: home.env, port: 0, plugins: [collection.plugin, failing], log: createStreamLogger(new PassThrough()) }),
    ).rejects.toThrow('later plugin failed');
    expect(() => collection.db()).toThrow(/not open/);
    expect(() => collection.collector()).toThrow(/not open/);
  });

  it('a daemon start collects every active repo once, at low priority', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/menu');
    await repo.commit('add the menu', { 'src/menu.ts': 'export const menu = [];\n' });
    const first = await startTestDaemon({ gh: ghNotInstalled() });
    const response = await first.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await first.idle();
    await first.daemon.shutdown('restart');

    const collection = createCollection({ runner: 'inline', gh: ghNotInstalled() });
    // The same home as the first daemon, so the repo is already registered.
    const result = await startDaemon({
      env: first.home.env,
      port: 0,
      plugins: [collection.plugin],
      log: createStreamLogger(new PassThrough()),
    });
    if (result.status !== 'started') throw new Error(result.status);
    try {
      await waitFor(() => collection.collector().isCollecting(response.repo.id), 5000, 'the start collection');
      await waitFor(() => collection.collector().collecting === 0, 30_000, 'the start collection to finish');
      expect(collection.db().repos.get(response.repo.id)?.collectError).toBeNull();
    } finally {
      await result.daemon.shutdown('test');
    }
  });
});

describe('pool/health-responsive-while-busy', () => {
  it('/api/health answers in under 200 ms while every worker is busy', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/a');
    await repo.commit('a', { 'src/a.ts': 'export const a = 1;\n' });
    await repo.checkout('main');
    await repo.branch('feature/b');
    await repo.commit('b', { 'src/b.ts': 'export const b = 1;\n' });
    const test = await startTestDaemon({ runner: 'thread', workerUrl: BUSY_WORKER, poolSize: 2, gh: ghNotInstalled() });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    const db = test.collection.db();
    await waitFor(() => db.changes.listLive(response.repo.id).length === 2, 20_000, 'two changes');
    // Both snapshot jobs are submitted right after the plan; give the workers time to start.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const health = await fetch(`http://127.0.0.1:${String(test.daemon.info.port)}/api/health`);
      const body = (await health.json()) as { collecting: number };
      timings.push(performance.now() - started);
      expect(body.collecting).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(Math.max(...timings)).toBeLessThan(200);
    expect(test.collection.collector().isCollecting(response.repo.id)).toBe(true);
    await test.idle();
    expect(db.repos.get(response.repo.id)?.collectError).toMatch(/busy worker: no snapshot/);
  });
});
