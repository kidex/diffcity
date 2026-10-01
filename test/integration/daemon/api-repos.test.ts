// The JSON API on the real daemon from dist/ (ADR-017): the daemon opens the
// database seeded in its temporary home and serves GET /api/repos.

import { mkdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../../src/core/db/index.js';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import type { DaemonInfo, RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import { readDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { DaemonTracker, waitFor } from '../../helpers/daemon.js';

let temp: TempHome;
let paths: HomePaths;
const daemons = new DaemonTracker();

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
});
afterEach(async () => {
  await daemons.cleanup();
  await temp.cleanup();
});

const T0 = '2026-09-01T10:00:00.000Z';

function branch(name: string, head: string, lastEventAt: string) {
  return {
    kind: 'branch' as const,
    ref: `branch:${name}`,
    prNumber: null,
    head,
    headAvailable: true,
    dirty: false,
    worktreePath: null,
    base: 'main',
    title: `Add ${name}`,
    ahead: 1,
    behind: 0,
    reviewState: 'unreviewed' as const,
    lastEventType: 'commit' as const,
    lastEventAt,
  };
}

async function seed(): Promise<{ shopId: number }> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const db = openDb(paths.db);
  try {
    const add = (name: string) =>
      db.repos.upsert({ path: `/work/${name}`, gitCommonDir: `/work/${name}/.git`, name, active: true, seenAt: T0 }).repo;
    add('docs-site');
    const shop = add('sample-shop');
    const orders = add('order-service');
    db.changes.applyPlan(shop.id, { create: [branch('cart', 'a'.repeat(40), '2026-09-05T00:00:00.000Z')], update: [], archive: [] }, T0);
    db.changes.applyPlan(orders.id, { create: [branch('retry', 'b'.repeat(40), '2026-09-03T00:00:00.000Z')], update: [], archive: [] }, T0);
    return { shopId: shop.id };
  } finally {
    db.close();
  }
}

describe('api on the built daemon', () => {
  it('GET /api/repos serves the seeded repos by last event, without a SQLite warning', async () => {
    const { shopId } = await seed();
    const spawned = daemons.spawnDaemon(temp.env);
    const info: DaemonInfo = await waitFor(() => readDaemonInfo(paths).then((value) => value ?? undefined), 45_000, 'daemon.json');
    const base = `http://127.0.0.1:${String(info.port)}`;

    const response = await fetch(`${base}/api/repos`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const repos = (await response.json()) as RepoSummary[];
    expect(repos.map((repo) => [repo.name, repo.counts.branch, repo.unreviewed])).toEqual([
      ['sample-shop', 1, 1],
      ['order-service', 1, 1],
      ['docs-site', 0, 0],
    ]);

    const detail = (await (await fetch(`${base}/api/repos/${String(shopId)}`)).json()) as RepoDetail;
    expect(detail.repo.lastSeenAt > T0).toBe(true);
    expect(detail.changes.map((change) => change.ref)).toEqual(['branch:cart']);

    expect(spawned.stderr()).not.toMatch(/ExperimentalWarning/);
  });
});
