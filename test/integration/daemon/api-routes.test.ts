// Every JSON API route of phase 2 (ADR-017) on the real daemon from dist/, over
// HTTP, against a database seeded in a temporary home: status, content type,
// bodies, the verbatim report bytes, lastSeenAt only for same-origin GETs, and
// a 2 MB report served quickly.

import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homePaths } from '../../../src/core/home.js';
import type { ApiError, ChangeSummary, DaemonInfo, RepoDetail, RepoSummary, SearchResult } from '../../../src/core/model/types.js';
import { readDaemonInfo } from '../../../src/daemon/files.js';
import { ODD_REPORT, T0, seedApiHome, type ApiSeed } from '../../helpers/api-seed.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { DaemonTracker, waitFor } from '../../helpers/daemon.js';

let temp: TempHome;
let seed: ApiSeed;
let port: number;
const daemons = new DaemonTracker();

beforeAll(async () => {
  temp = await tempHome();
  const paths = homePaths(temp.home);
  seed = await seedApiHome(paths);
  daemons.spawnDaemon(temp.env);
  const info: DaemonInfo = await waitFor(() => readDaemonInfo(paths).then((value) => value ?? undefined), 20_000, 'daemon.json');
  port = info.port;
}, 60_000);
afterAll(async () => {
  await daemons.cleanup();
  await temp.cleanup();
});

interface Answer {
  status: number;
  contentType: string;
  body: Buffer;
  json(): unknown;
}

/** A raw GET with full control over browser headers (Origin, Referer). */
function get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type']),
          body,
          json: (): unknown => JSON.parse(body.toString('utf8')),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const JSON_TYPE = /^application\/json; charset=utf-8$/;

async function lastSeenOf(repoId: number): Promise<string> {
  const repos = (await get('/api/repos')).json() as RepoSummary[];
  const repo = repos.find((entry) => entry.id === repoId);
  if (repo === undefined) throw new Error(`repo ${String(repoId)} missing`);
  return repo.lastSeenAt;
}

describe('api on the built daemon, every route', () => {
  it('GET /api/repos: by last event, with the Fleet counters', async () => {
    const answer = await get('/api/repos');
    expect(answer.status).toBe(200);
    expect(answer.contentType).toMatch(JSON_TYPE);
    const repos = answer.json() as RepoSummary[];
    expect(repos.map((repo) => repo.name)).toEqual(['sample-shop', 'order-service', 'docs-site']);
    const shop = repos[0];
    expect(shop?.counts).toEqual({ draft: 1, branch: 1, pr: 1 });
    expect(shop?.unreviewed).toBe(2);
    expect(shop?.highFindings).toBe(0);
    expect(shop?.lastAudit).toBeNull();
    expect(repos[2]).toMatchObject({ active: false, lastEventAt: null, counts: { draft: 0, branch: 0, pr: 0 }, unreviewed: 0 });
  });

  it('GET /api/repos/:id: the repo with its live changes only', async () => {
    const answer = await get(`/api/repos/${String(seed.shopId)}`);
    expect(answer.status).toBe(200);
    expect(answer.contentType).toMatch(JSON_TYPE);
    const detail = answer.json() as RepoDetail;
    expect(detail.repo.id).toBe(seed.shopId);
    expect(detail.changes.map((change) => change.ref)).toEqual(['branch:cart', 'pr:9', 'draft:.']);
    expect(detail.changes.every((change) => change.archivedAt === null)).toBe(true);
  });

  it('GET /api/repos/:id/changes and ?archived=1', async () => {
    const live = await get(`/api/repos/${String(seed.shopId)}/changes`);
    expect(live.contentType).toMatch(JSON_TYPE);
    expect((live.json() as ChangeSummary[]).map((change) => change.id)).not.toContain(seed.mergedId);

    const archived = await get(`/api/repos/${String(seed.shopId)}/changes?archived=1`);
    expect(archived.status).toBe(200);
    expect(archived.contentType).toMatch(JSON_TYPE);
    const list = archived.json() as ChangeSummary[];
    expect(list.map((change) => [change.id, change.archiveReason])).toEqual([[seed.mergedId, 'merged']]);
    expect(list[0]?.archivedAt).not.toBeNull();
  });

  it('GET /api/changes/:id: the summary, stats null without a snapshot', async () => {
    const cart = await get(`/api/changes/${String(seed.cartId)}`);
    expect(cart.status).toBe(200);
    expect(cart.contentType).toMatch(JSON_TYPE);
    expect(cart.json()).toMatchObject({ id: seed.cartId, repoId: seed.shopId, ref: 'branch:cart' });
    expect((cart.json() as ChangeSummary).stats).not.toBeNull();
    const retry = await get(`/api/changes/${String(seed.retryId)}`);
    expect((retry.json() as ChangeSummary).stats).toBeNull();
  });

  it('GET /api/changes/:id/report: the stored bytes, verbatim', async () => {
    const answer = await get(`/api/changes/${String(seed.cartId)}/report`);
    expect(answer.status).toBe(200);
    expect(answer.contentType).toMatch(JSON_TYPE);
    expect(answer.body.equals(Buffer.from(ODD_REPORT, 'utf8'))).toBe(true);
  });

  it('GET /api/changes/:id/report: 404 no-snapshot', async () => {
    const answer = await get(`/api/changes/${String(seed.retryId)}/report`);
    expect(answer.status).toBe(404);
    expect(answer.contentType).toMatch(JSON_TYPE);
    expect((answer.json() as ApiError).error.code).toBe('no-snapshot');
  });

  it('GET /api/changes/:id/report: a 2 MB report is served whole and quickly', async () => {
    await get(`/api/changes/${String(seed.sessionId)}/report`); // warm-up
    const started = performance.now();
    const answer = await get(`/api/changes/${String(seed.sessionId)}/report`);
    const elapsed = performance.now() - started;
    expect(answer.status).toBe(200);
    expect(answer.body.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(answer.body.equals(Buffer.from(seed.big, 'utf8'))).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('GET /api/search: prefix > substring, repo > change > file', async () => {
    const answer = await get('/api/search?q=order');
    expect(answer.status).toBe(200);
    expect(answer.contentType).toMatch(JSON_TYPE);
    expect((answer.json() as SearchResult[]).map((result) => [result.kind, result.label])).toEqual([
      ['repo', 'order-service'],
      ['change', 'Order totals in the cart'],
      ['change', 'Retry failed orders'],
      ['file', 'src/order/total.ts'],
    ]);
  });

  it.each([
    ['/api/repos/abc', 400, 'bad-request'],
    ['/api/repos/0', 400, 'bad-request'],
    ['/api/repos/999/changes?archived=2', 400, 'bad-request'],
    ['/api/search?q=a&limit=ten', 400, 'bad-request'],
    ['/api/repos/999', 404, 'not-found'],
    ['/api/repos/999/changes', 404, 'not-found'],
    ['/api/changes/999', 404, 'not-found'],
    ['/api/changes/999/report', 404, 'not-found'],
  ])('%s is a JSON %i %s', async (path, status, code) => {
    const answer = await get(path);
    expect(answer.status).toBe(status);
    expect(answer.contentType).toMatch(JSON_TYPE);
    expect((answer.json() as ApiError).error.code).toBe(code);
  });

  it('lastSeenAt: a cross-site GET leaves it, a same-origin GET updates it', async () => {
    const id = seed.ordersId;
    expect(await lastSeenOf(id)).toBe(T0);

    const evil = await get(`/api/repos/${String(id)}`, { Origin: 'http://evil.example', Referer: 'http://evil.example/page' });
    expect(evil.status).toBe(200);
    expect((evil.json() as RepoDetail).repo.lastSeenAt).toBe(T0);
    expect(await lastSeenOf(id)).toBe(T0);

    const own = `http://127.0.0.1:${String(port)}`;
    const mine = await get(`/api/repos/${String(id)}`, { Origin: own, Referer: `${own}/`, 'Sec-Fetch-Site': 'same-origin' });
    expect(mine.status).toBe(200);
    expect((mine.json() as RepoDetail).repo.lastSeenAt > T0).toBe(true);
    expect(await lastSeenOf(id)).toBe((mine.json() as RepoDetail).repo.lastSeenAt);
  });
});
