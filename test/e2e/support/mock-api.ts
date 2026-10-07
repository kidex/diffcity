// Mocks the daemon's JSON API with page.route() from the fixtures in
// test/fixtures/ui/ (ADR-023). `/api/events` is left to the server: a route
// mock cannot hold an SSE stream open.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import type { ApiError, ChangeSummary, FileDiff, RepoDetail, RepoSummary, SearchResult } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import type { ReviewMock, ReviewSeed } from './review-api.js';
import { answerReview, createReviewMock } from './review-api.js';

const fixturesDir = fileURLToPath(new URL('../../fixtures/ui/', import.meta.url));

const load = (name: string): unknown => JSON.parse(readFileSync(`${fixturesDir}${name}`, 'utf8'));
const scenarioGolden = fileURLToPath(new URL('../../fixtures/scenarios/order-discounts/expected.json', import.meta.url));

/** The JSON fixtures in test/fixtures/ui/, with their DTO types. */
export const fixtures = {
  fleetThreeRepos: () => load('fleet-three-repos.json') as RepoSummary[],
  fleetIndicators: () => load('fleet-indicators.json') as RepoSummary[],
  fleetNewRepo: () => load('fleet-new-repo.json') as RepoSummary,
  fleetEmpty: () => load('fleet-empty.json') as RepoSummary[],
  fleetManyRepos: () => load('fleet-many-repos.json') as RepoSummary[],
  repoMixedChanges: () => load('repo-mixed-changes.json') as RepoDetail,
  repoEmpty: () => load('repo-empty.json') as RepoDetail,
  repoLongList: () => load('repo-long-list.json') as RepoDetail,
  repoArchived: () => load('repo-archived.json') as ChangeSummary[],
  reportOrderDiscounts: () => load('report-order-discounts.json') as Report,
  /** The golden order-discounts Report with its real steps (path, migrations, unconnected) and three findings on step symbols (gen-report-with-steps.mjs). */
  reportWithSteps: () => load('report-order-discounts-with-steps.json') as Report,
  /** The golden Report of the order-discounts scenario (17 files, the mockup's change). */
  reportGolden: () => JSON.parse(readFileSync(scenarioGolden, 'utf8')) as Report,
  /** The `large` preset: 2,000 files, about 20,000 floors, 300 touched, 40 packages; written by gen-large-city.mjs in the global setup. */
  reportLargeCity: () => load('generated/report-large-city.json') as Report,
  searchResults: () => load('search-results.json') as SearchResult[],
};

/** One request of the diff route, as the `diff` handler sees it. */
export interface DiffRequest {
  changeId: number;
  path: string;
  symbol: string | null;
  /** How many requests of this change's diff route came before this one. */
  call: number;
}

/** What the diff route answers: a FileDiff, or an error status and its body. */
export type DiffReply = FileDiff | { status: number; body: unknown };

export interface ApiData {
  repos: RepoSummary[];
  details: RepoDetail[];
  /** Archived changes per repo id, for `GET /api/repos/:id/changes?archived=1`. */
  archived: Record<number, ChangeSummary[]>;
  /** Reports per change id; a change without one answers 404 `no-snapshot`. */
  reports: Record<number, Report>;
  /** The search answer for a query; the default returns search-results.json for any query. */
  search: (query: string) => SearchResult[];
  /** The answer of `GET /api/changes/:id/diff`; the default says `unavailable`. May wait: the response is held until it settles. */
  diff: (request: DiffRequest) => DiffReply | Promise<DiffReply>;
  /**
   * The review state every change starts with (ADR-028). The routes keep it: see `MockedApi.review`. Absent
   * (the default), the review routes answer 409 `no-snapshot`, so the screen has no review controls.
   */
  review?: ReviewSeed;
  /** The review state per change id: pass the same Map to two pages and they share one daemon's marks. */
  reviewMocks: Map<number, ReviewMock>;
}

export interface MockedApi {
  /** Every mocked request, in order. */
  readonly requests: URL[];
  count(pathname: string): number;
  /** The review state of a change (marks, note, writes made, hooks to fail or hold a write), created on first use. */
  review(changeId: number): ReviewMock;
}

export function defaultApiData(): ApiData {
  const results = fixtures.searchResults();
  return {
    repos: fixtures.fleetThreeRepos(),
    details: [fixtures.repoMixedChanges()],
    archived: { 1: fixtures.repoArchived() },
    reports: { 11: fixtures.reportOrderDiscounts() },
    search: () => results,
    reviewMocks: new Map(),
    diff: ({ path }) => ({
      snapshotId: 1,
      head: 'aaaaaaa',
      path,
      language: 'typescript',
      kind: 'unavailable',
      reason: 'no diff in this mock',
      stale: false,
      stats: { added: 0, removed: 0 },
      sizes: { before: null, after: null },
    }),
  };
}

const notFound = (message: string): ApiError => ({ error: { code: 'not-found', message } });

export async function mockApi(page: Page, overrides: Partial<ApiData> = {}): Promise<MockedApi> {
  const data = { ...defaultApiData(), ...overrides };
  const requests: URL[] = [];
  let diffCalls = 0;
  const reviews = data.reviewMocks;
  const review = (changeId: number): ReviewMock => {
    let mock = reviews.get(changeId);
    if (mock === undefined) {
      mock = createReviewMock({ ...data.review, marks: [...(data.review?.marks ?? [])] });
      reviews.set(changeId, mock);
    }
    return mock;
  };

  const answer = async (route: Route, body: unknown, status = 200): Promise<void> => {
    await route.fulfill({ status, json: body });
  };

  await page.route(
    (url) => url.pathname.startsWith('/api/') && url.pathname !== '/api/events',
    async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      const path = url.pathname;
      let match: RegExpExecArray | null;
      if (path === '/api/repos') return answer(route, data.repos);
      if ((match = /^\/api\/repos\/(\d+)$/.exec(path))) {
        const id = Number(match[1]);
        const detail = data.details.find((candidate) => candidate.repo.id === id);
        const repo = data.repos.find((candidate) => candidate.id === id);
        if (detail) return answer(route, detail);
        return repo ? answer(route, { repo, changes: [] }) : answer(route, notFound('repo not found'), 404);
      }
      if ((match = /^\/api\/repos\/(\d+)\/changes$/.exec(path))) {
        if (url.searchParams.get('archived') !== '1') return answer(route, notFound('only ?archived=1 is listed'), 404);
        return answer(route, data.archived[Number(match[1])] ?? []);
      }
      if ((match = /^\/api\/changes\/(\d+)$/.exec(path))) {
        const id = Number(match[1]);
        const change = [...data.details.flatMap((detail) => detail.changes), ...Object.values(data.archived).flat()].find(
          (candidate) => candidate.id === id,
        );
        return change ? answer(route, change) : answer(route, notFound('change not found'), 404);
      }
      if ((match = /^\/api\/changes\/(\d+)\/report$/.exec(path))) {
        const report = data.reports[Number(match[1])];
        return report ? answer(route, report) : answer(route, { error: { code: 'no-snapshot', message: 'no snapshot yet' } }, 404);
      }
      if ((match = /^\/api\/changes\/(\d+)\/review(\/.*)?$/.exec(path))) {
        const id = Number(match[1]);
        // Without a seed (and no shared state) the daemon has nothing to review: 409 no-snapshot.
        if (data.review === undefined && !reviews.has(id)) return answer(route, { error: { code: 'no-snapshot', message: 'no snapshot yet' } }, 409);
        return answerReview(route, review(id), data.reports[id], match[2] ?? '');
      }
      if ((match = /^\/api\/changes\/(\d+)\/diff$/.exec(path))) {
        const reply = await data.diff({ changeId: Number(match[1]), path: url.searchParams.get('path') ?? '', symbol: url.searchParams.get('symbol'), call: diffCalls++ });
        // A held request the page gave up on (an aborted fetch) cannot be answered any more.
        try {
          if ('status' in reply) await answer(route, reply.body, reply.status);
          else await answer(route, reply);
        } catch {
          // The page aborted the request while it was held.
        }
        return;
      }
      if (path === '/api/search') return answer(route, data.search(url.searchParams.get('q') ?? ''));
      return answer(route, notFound(`no mock for ${path}`), 404);
    },
  );

  return {
    requests,
    count: (pathname) => requests.filter((url) => url.pathname === pathname).length,
    review,
  };
}
