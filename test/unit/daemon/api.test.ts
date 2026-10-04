// The JSON API (ADR-017): repos, changes, the latest report and search, through
// fastify.inject on a seeded temporary database.

import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import { MAX_QUERY_LENGTH } from '../../../src/core/search/index.js';
import type { ChangeRecord, ChangeSummary, RepoDetail, RepoRecord, RepoSummary, SearchResult } from '../../../src/core/model/types.js';
import { registerApiRoutes } from '../../../src/daemon/api/routes.js';
import { buildHttpServer } from '../../../src/daemon/http/server.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import { createSseHub, type SseHub } from '../../../src/daemon/sse.js';
import { T0, addRepo, branchFields, daysAfter, sha, snapshotInput, tempDb, type TempDb } from '../db/db-helpers.js';

const PORT = 4321;
const HOST = { host: `127.0.0.1:${String(PORT)}` };
const NOW = '2026-09-20T12:00:00.000Z';

let temp: TempDb;
let db: Db;
let hub: SseHub;
let app: FastifyInstance;

interface Seed {
  shop: RepoRecord;
  orders: RepoRecord;
  docs: RepoRecord;
  discounts: ChangeRecord;
  session: ChangeRecord;
  draft: ChangeRecord;
  merged: ChangeRecord;
  deleted: ChangeRecord;
  retry: ChangeRecord;
}

let seed: Seed;

function created(changes: ChangeRecord[], index: number): ChangeRecord {
  const change = changes[index];
  if (change === undefined) throw new Error(`change ${String(index)} not created`);
  return change;
}

// sample-shop: a Branch, a PR and a Draft live, one merged and one deleted
// change archived. order-service: one older Branch, approved. docs-site:
// inactive, no changes.
function seedDb(): Seed {
  const shop = addRepo(db, 'sample-shop');
  const orders = addRepo(db, 'order-service');
  const docs = addRepo(db, 'docs-site', false);

  const shopChanges = db.changes.applyPlan(
    shop.id,
    {
      create: [
        branchFields('feature/order-discounts', { title: 'Add percentage discounts', lastEventAt: daysAfter(T0, 3) }),
        branchFields('session-refresh', {
          kind: 'pr',
          ref: 'pr:7',
          prNumber: 7,
          title: 'Refresh the session before it expires',
          lastEventType: 'agent',
          lastEventAt: daysAfter(T0, 5),
        }),
        branchFields('draft', {
          kind: 'draft',
          ref: 'draft:.',
          dirty: true,
          title: 'Uncommitted changes on main',
          reviewState: 'in-review',
          lastEventAt: daysAfter(T0, 4),
        }),
        branchFields('old-merged', { title: 'Merged long ago', lastEventAt: daysAfter(T0, 9) }),
        branchFields('old-deleted', { title: 'Deleted branch', lastEventAt: daysAfter(T0, 9) }),
      ],
      update: [],
      archive: [],
    },
    T0,
  ).created;
  const [discounts, session, draft, merged, deleted] = [0, 1, 2, 3, 4].map((i) => created(shopChanges, i)) as [
    ChangeRecord,
    ChangeRecord,
    ChangeRecord,
    ChangeRecord,
    ChangeRecord,
  ];
  db.changes.applyPlan(shop.id, { create: [], update: [], archive: [{ id: merged.id, reason: 'merged' }] }, daysAfter(T0, 10));
  db.changes.applyPlan(shop.id, { create: [], update: [], archive: [{ id: deleted.id, reason: 'deleted' }] }, daysAfter(T0, 11));

  const retry = created(
    db.changes.applyPlan(
      orders.id,
      { create: [branchFields('fix/retry', { title: 'Retry failed orders', reviewState: 'approved', lastEventAt: daysAfter(T0, 1) })], update: [], archive: [] },
      T0,
    ).created,
    0,
  );

  db.snapshots.put(snapshotInput(discounts.id, discounts.head, { touched: ['src/orders/discounts.ts', 'src/orders/cart.ts'] }));
  db.snapshots.put(snapshotInput(session.id, session.head, { touched: ['src/auth/session.ts'] }));
  db.snapshots.put(snapshotInput(retry.id, retry.head, { touched: ['lib/order-queue.ts'] }));

  return { shop, orders, docs, discounts, session, draft, merged, deleted, retry };
}

beforeEach(async () => {
  temp = tempDb();
  db = temp.db;
  seed = seedDb();
  hub = createSseHub({ hello: () => ({ version: '9.9.9', startedAt: T0 }) });
  app = await buildHttpServer({
    version: '9.9.9',
    pid: 123,
    startedAt: T0,
    uiDir: '/nonexistent-ui',
    sse: hub,
    collecting: () => 0,
    log: createStreamLogger(new PassThrough()),
    port: () => PORT,
  });
  registerApiRoutes(app, {
    db,
    port: () => PORT,
    // Stands in for the collection plugin's handler, which stamps lastSeenAt on the daemon's clock.
    open: (repoId) => {
      db.repos.touchSeen(repoId, NOW);
    },
  });
});
afterEach(async () => {
  hub.close();
  await app.close();
  temp.cleanup();
});

async function get(url: string): Promise<{ status: number; body: string; json: () => unknown; contentType: string }> {
  const response = await app.inject({ method: 'GET', url, headers: HOST });
  return {
    status: response.statusCode,
    body: response.body,
    json: () => response.json(),
    contentType: String(response.headers['content-type']),
  };
}

describe('api/repos-ordered-by-last-event', () => {
  it('lists every repo by lastEventAt desc, repos without events last', async () => {
    const response = await get('/api/repos');
    expect(response.status).toBe(200);
    expect(response.contentType).toMatch(/^application\/json/);
    const repos = response.json() as RepoSummary[];
    expect(repos.map((repo) => [repo.name, repo.lastEventAt])).toEqual([
      ['sample-shop', daysAfter(T0, 5)],
      ['order-service', daysAfter(T0, 1)],
      ['docs-site', null],
    ]);
  });

  it('fleet/counters: counts by kind, unreviewed, highFindings 0 and lastAudit null, live changes only', async () => {
    const repos = (await get('/api/repos')).json() as RepoSummary[];
    expect(repos.map(({ name, counts, unreviewed, highFindings, lastAudit, active }) => ({ name, counts, unreviewed, highFindings, lastAudit, active }))).toEqual([
      { name: 'sample-shop', counts: { draft: 1, branch: 1, pr: 1 }, unreviewed: 2, highFindings: 0, lastAudit: null, active: true },
      { name: 'order-service', counts: { draft: 0, branch: 1, pr: 0 }, unreviewed: 0, highFindings: 0, lastAudit: null, active: true },
      { name: 'docs-site', counts: { draft: 0, branch: 0, pr: 0 }, unreviewed: 0, highFindings: 0, lastAudit: null, active: false },
    ]);
  });

  it('fleet/archived-count: archivedCount is on every summary of /api/repos and /api/repos/:id', async () => {
    const repos = (await get('/api/repos')).json() as RepoSummary[];
    expect(repos.map((repo) => [repo.name, repo.archivedCount])).toEqual([['sample-shop', 2], ['order-service', 0], ['docs-site', 0]]);
    const shop = repos.find((repo) => repo.name === 'sample-shop');
    const detail = (await get(`/api/repos/${String(shop?.id)}`)).json() as { repo: RepoSummary };
    expect(detail.repo.archivedCount).toBe(2);
  });
});

describe('api/repo-changes-excludes-archived', () => {
  it('GET /api/repos/:id returns the repo and its live changes by last event desc', async () => {
    const response = await get(`/api/repos/${String(seed.shop.id)}`);
    expect(response.status).toBe(200);
    const detail = response.json() as RepoDetail;
    expect(detail.repo.id).toBe(seed.shop.id);
    expect(detail.repo.name).toBe('sample-shop');
    expect(detail.changes.map((change) => change.id)).toEqual([seed.session.id, seed.draft.id, seed.discounts.id]);
    expect(detail.changes.every((change) => change.archivedAt === null)).toBe(true);
  });

  it('GET /api/repos/:id/changes lists the live changes too', async () => {
    const changes = (await get(`/api/repos/${String(seed.shop.id)}/changes`)).json() as ChangeSummary[];
    expect(changes.map((change) => change.id)).toEqual([seed.session.id, seed.draft.id, seed.discounts.id]);
  });
});

describe('api/archived-list', () => {
  it('/api/repos/:id/changes?archived=1 lists archived changes by archivedAt desc, with the reason', async () => {
    const response = await get(`/api/repos/${String(seed.shop.id)}/changes?archived=1`);
    expect(response.status).toBe(200);
    const changes = response.json() as ChangeSummary[];
    expect(changes.map(({ id, archivedAt, archiveReason }) => ({ id, archivedAt, archiveReason }))).toEqual([
      { id: seed.deleted.id, archivedAt: daysAfter(T0, 11), archiveReason: 'deleted' },
      { id: seed.merged.id, archivedAt: daysAfter(T0, 10), archiveReason: 'merged' },
    ]);
  });

  it('archived=0 is the live list', async () => {
    const changes = (await get(`/api/repos/${String(seed.shop.id)}/changes?archived=0`)).json() as ChangeSummary[];
    expect(changes).toHaveLength(3);
  });

  it('/api/repos/:id ignores archived and always lists the live changes', async () => {
    const detail = (await get(`/api/repos/${String(seed.shop.id)}?archived=1`)).json() as RepoDetail;
    expect(detail.changes.map((change) => change.id)).toEqual([seed.session.id, seed.draft.id, seed.discounts.id]);
  });

  it('any other archived value is a 400', async () => {
    const response = await get(`/api/repos/${String(seed.shop.id)}/changes?archived=maybe`);
    expect(response.status).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'bad-request', message: expect.any(String) as unknown } });
  });
});

describe('api/repo-open-touches-last-seen', () => {
  it('GET /api/repos/:id sets lastSeenAt to now and returns it', async () => {
    expect(db.repos.get(seed.docs.id)?.lastSeenAt).toBe(T0);
    const detail = (await get(`/api/repos/${String(seed.docs.id)}`)).json() as RepoDetail;
    expect(detail.repo.lastSeenAt).toBe(NOW);
    expect(db.repos.get(seed.docs.id)?.lastSeenAt).toBe(NOW);
    expect(db.repos.get(seed.shop.id)?.lastSeenAt).toBe(T0);
  });

  const own = `http://127.0.0.1:${String(PORT)}`;

  it.each([
    ['a foreign Origin', { origin: 'http://evil.example' }],
    ['a foreign Referer', { referer: 'http://evil.example/page' }],
    ['an unparsable Referer', { referer: 'not a url' }],
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
    ['Origin: null', { origin: 'null' }],
    ['the own Origin and a foreign Referer', { origin: own, referer: 'http://evil.example/page' }],
  ])('a GET with %s is answered but leaves lastSeenAt unchanged', async (_what, headers: Record<string, string>) => {
    const response = await app.inject({ method: 'GET', url: `/api/repos/${String(seed.docs.id)}`, headers: { ...HOST, ...headers } });
    expect(response.statusCode).toBe(200);
    expect(response.json<RepoDetail>().repo.lastSeenAt).toBe(T0);
    expect(db.repos.get(seed.docs.id)?.lastSeenAt).toBe(T0);
  });

  it('a HEAD request never writes', async () => {
    const response = await app.inject({ method: 'HEAD', url: `/api/repos/${String(seed.docs.id)}`, headers: HOST });
    expect(response.statusCode).toBe(200);
    expect(db.repos.get(seed.docs.id)?.lastSeenAt).toBe(T0);
  });

  it.each([
    ['the own Origin, Referer and Sec-Fetch-Site: same-origin', { origin: own, referer: `${own}/#/repo/1`, 'sec-fetch-site': 'same-origin' }],
    ['a localhost Referer', { referer: `http://localhost:${String(PORT)}/` }],
    ['Sec-Fetch-Site: none', { 'sec-fetch-site': 'none' }],
  ])('a GET with %s updates lastSeenAt', async (_what, headers: Record<string, string>) => {
    const response = await app.inject({ method: 'GET', url: `/api/repos/${String(seed.docs.id)}`, headers: { ...HOST, ...headers } });
    expect(response.statusCode).toBe(200);
    expect(db.repos.get(seed.docs.id)?.lastSeenAt).toBe(NOW);
  });

  it('listing repos or a repo changes list does not touch it', async () => {
    await get('/api/repos');
    await get(`/api/repos/${String(seed.shop.id)}/changes`);
    expect(db.repos.get(seed.shop.id)?.lastSeenAt).toBe(T0);
  });

  it('an unknown repo is a 404 and touches nothing', async () => {
    const response = await get('/api/repos/999');
    expect(response.status).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not-found', message: 'repo 999 not found' } });
  });
});

describe('GET /api/changes/:id', () => {
  it('returns the ChangeSummary with stats from the latest snapshot', async () => {
    const response = await get(`/api/changes/${String(seed.session.id)}`);
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      id: seed.session.id,
      repoId: seed.shop.id,
      kind: 'pr',
      prNumber: 7,
      agentUnreviewed: true,
      stats: { touchedFiles: 2, tier1Files: ['src/auth/session.ts'] },
    });
  });

  it('stats is null while there is no snapshot', async () => {
    expect(((await get(`/api/changes/${String(seed.draft.id)}`)).json() as ChangeSummary).stats).toBeNull();
  });

  it('serves an archived change too', async () => {
    expect(((await get(`/api/changes/${String(seed.merged.id)}`)).json() as ChangeSummary).archiveReason).toBe('merged');
  });

  it('an unknown change is a 404', async () => {
    const response = await get('/api/changes/4242');
    expect(response.status).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not-found', message: 'change 4242 not found' } });
  });
});

describe('api/report-latest-snapshot', () => {
  it('sends the latest snapshot report byte for byte, as JSON', async () => {
    // Spacing, key order and 1.50 would all change if the string were parsed and serialised again.
    const older = '{"meta":{"repo":"sample-shop"},"version":1}';
    const latest = '{ "version" : 1.50,\n  "meta": {"repo": "sample-shop", "generatedAt": "2026-09-02T00:00:00Z"} }';
    db.snapshots.put(snapshotInput(seed.draft.id, seed.draft.head, { report: older, contentHash: 'a', computedAt: T0 }));
    db.snapshots.put(snapshotInput(seed.draft.id, sha(), { report: latest, contentHash: 'b', computedAt: daysAfter(T0, 1) }));

    const response = await get(`/api/changes/${String(seed.draft.id)}/report`);
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/json; charset=utf-8');
    expect(response.body).toBe(latest);
  });
});

describe('api/report-no-snapshot-404', () => {
  it('a change without a snapshot is a 404 no-snapshot', async () => {
    const response = await get(`/api/changes/${String(seed.draft.id)}/report`);
    expect(response.status).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'no-snapshot', message: expect.any(String) as unknown } });
  });

  it('an unknown change is a 404 not-found, not no-snapshot', async () => {
    const response = await get('/api/changes/4242/report');
    expect(response.status).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('not-found');
  });
});

describe('api/search-repo-change-file', () => {
  it('ranks prefix above substring, and repo > change > file in each group', async () => {
    const response = await get('/api/search?q=order');
    expect(response.status).toBe(200);
    const results = response.json() as SearchResult[];
    expect(results.map((result) => [result.kind, result.label])).toEqual([
      ['repo', 'order-service'],
      ['file', 'lib/order-queue.ts'],
      ['change', 'Add percentage discounts'],
      ['change', 'Retry failed orders'],
      ['file', 'src/orders/discounts.ts'],
      ['file', 'src/orders/cart.ts'],
    ]);
  });

  it('a change result carries changeId; a file result carries changeId and path', async () => {
    const results = (await get('/api/search?q=session')).json() as SearchResult[];
    // The file name starts with "session" (prefix); the title only contains it (substring).
    expect(results).toEqual([
      {
        kind: 'file',
        label: 'src/auth/session.ts',
        detail: 'sample-shop, Refresh the session before it expires',
        repoId: seed.shop.id,
        changeId: seed.session.id,
        path: 'src/auth/session.ts',
      },
      { kind: 'change', label: 'Refresh the session before it expires', detail: 'sample-shop, PR #7', repoId: seed.shop.id, changeId: seed.session.id },
    ]);
  });

  it('archived changes are not searched', async () => {
    expect((await get('/api/search?q=merged')).json()).toEqual([]);
  });

  it('applies limit, default 20', async () => {
    expect(((await get('/api/search?q=order&limit=2')).json() as SearchResult[]).map((result) => result.label)).toEqual([
      'order-service',
      'lib/order-queue.ts',
    ]);
  });

  it('a missing or blank q gives no results', async () => {
    expect((await get('/api/search')).json()).toEqual([]);
    expect((await get('/api/search?q=%20%20')).json()).toEqual([]);
  });

  it(`caps q at ${String(MAX_QUERY_LENGTH)} characters`, async () => {
    const q = `sample-shop${'z'.repeat(1000)}`;
    const response = await get(`/api/search?q=${q}`);
    expect(response.status).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it.each(['0', '-1', 'ten', '2.5'])('limit=%s is a 400', async (limit) => {
    const response = await get(`/api/search?q=order&limit=${limit}`);
    expect(response.status).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('bad-request');
  });

  it('a repeated q is a 400', async () => {
    expect((await get('/api/search?q=a&q=b')).status).toBe(400);
  });
});

describe('id validation', () => {
  const routes = ['/api/repos/:id', '/api/repos/:id/changes', '/api/changes/:id', '/api/changes/:id/report'];
  const bad = ['0', '-1', 'abc', '1.5', '01', '1e3', '99999999999999999999', '%20'];

  it.each(routes.flatMap((route) => bad.map((id) => [route, id] as const)))('%s with id %s is a 400 JSON error', async (route, id) => {
    const response = await get(route.replace(':id', id));
    expect(response.status).toBe(400);
    expect(response.contentType).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ error: { code: 'bad-request', message: 'id must be a positive integer' } });
  });

  it.each(routes)('%s with an unknown id is a 404 JSON error', async (route) => {
    const response = await get(route.replace(':id', '777'));
    expect(response.status).toBe(404);
    expect(response.contentType).toMatch(/^application\/json/);
    expect((response.json() as { error: { code: string } }).error.code).toBe('not-found');
  });
});
