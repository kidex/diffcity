// Mocks the daemon's JSON API with page.route() from the fixtures in
// test/fixtures/ui/ (ADR-023). `/api/events` is left to the server: a route
// mock cannot hold an SSE stream open.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import type {
  AgentRunsResponse,
  ApiError,
  ChangeSummary,
  FileDiff,
  RepoDetail,
  RepoSummary,
  SearchResult,
  SessionsResponse,
} from '../../../src/core/model/types.js';
import type { AgentPreview } from '../../../src/ui/data/api.js';
import type { Report } from '../../../src/core/report/types.js';
import { uncheckedTier1Files } from '../../../src/core/review/index.js';
import type { FindingsMock } from './findings-api.js';
import { answerFindings, createFindingsMock } from './findings-api.js';
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
  /** The steps Report with five findings (ADR-036): an open high one with two sources (its file risky), an open med one, an open rule finding, an intended and a fixed one. */
  reportFindingsMixed: () => load('report-findings-mixed.json') as Report,
  /** The golden Report of the order-discounts scenario (17 files, the mockup's change). */
  reportGolden: () => JSON.parse(readFileSync(scenarioGolden, 'utf8')) as Report,
  /** The `large` preset: 2,000 files, about 20,000 floors, 300 touched, 40 packages; written by gen-large-city.mjs in the global setup. */
  reportLargeCity: () => load('generated/report-large-city.json') as Report,
  searchResults: () => load('search-results.json') as SearchResult[],
  /** Two sessions of the golden change (ADR-038): a read one that ran here, with prompts, questions, nested agents and edits, and an untitled stale one. */
  sessionsTwo: () => load('sessions-two.json') as SessionsResponse,
  /** One session whose transcript was refused: unreadable, no digest. */
  sessionsParseError: () => load('sessions-parse-error.json') as SessionsResponse,
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
  /** The fix queue and the writes of the findings routes per change id (ADR-036), created on first use. */
  findingsMocks: Map<number, FindingsMock>;
  /**
   * `GET /api/changes/:id/sessions` per change id (ADR-038), read at each request: replace an entry and
   * emit SSE `sessions` to serve another answer. Without one, a change the mock knows (a Report, a live or
   * archived change) has no sessions, as the daemon answers; any other id answers 404.
   */
  sessions?: Record<number, SessionsResponse>;
}

/**
 * The "send review to agent" routes of one change (ADR-029), standing in for
 * the daemon: the preview a spec set, a run bound to its token and summary
 * hash (anything else is 409 `token-invalid`), the runs answer, and the
 * summary fix-queue item, queued once per hash.
 */
export interface AgentMock {
  /** What `POST /agent/preview` answers; a spec replaces it to show refusals or another session. */
  preview: AgentPreview;
  /** What `GET /agent/runs` answers; `run` sets it to the started run, a spec moves it on (and emits SSE `agent-run`). */
  runs: AgentRunsResponse;
  /** Every write the page made, in order. */
  readonly writes: { route: 'preview' | 'run' | 'queue'; body: unknown }[];
  /** Summary hashes in the fix queue. */
  readonly queued: string[];
  /** Answers the next write (once) with this status, code and message, whatever it is. */
  failNext: { status: number; code: string; message: string } | null;
  /** Holds every write until it settles (a slow daemon). */
  hold: Promise<void> | null;
}

/** A preview with nothing refused: resume the linked session in the change's working tree. */
export function agentPreview(over: Partial<AgentPreview> = {}): AgentPreview {
  const sessionId = '0f8d2c4e-5b1a-4c3d-9e7f-1a2b3c4d5e6f';
  return {
    mode: 'resume',
    argv: ['/opt/tools/claude', '--resume', sessionId, '-p', '--output-format', 'json'],
    cwd: '/work/order-desk',
    sessionId,
    session: { sessionId, title: 'Add order discounts', firstAt: '2026-05-02T10:14:00.000Z', lastAt: '2026-05-02T11:02:00.000Z' },
    newSessionReason: null,
    permissionMode: null,
    timeoutMinutes: 30,
    summary: ['# Review of feat/discounts', '', ...Array.from({ length: 60 }, (_, i) => `- note line ${String(i + 1)}`), '', 'End of the review.'].join('\n'),
    summaryHash: 'a'.repeat(64),
    refusals: [],
    token: 'token-1',
    ...over,
  };
}

/** The approve route of one change (ADR-036): writes made and hooks, as for the findings routes. */
export interface ApprovalMock {
  /** Every approve request the page made, in order. */
  readonly writes: ('POST' | 'DELETE')[];
  /** The body of every POST, in order: null for the plain Approve, the confirmed list for "Check the rest and approve". */
  readonly bodies: unknown[];
  /** Reads of `GET /approve/remaining` (DC-135). */
  remainingReads: number;
  /** Holds every `GET /approve/remaining` until it settles (a slow daemon). */
  holdRemaining: Promise<void> | null;
  /** Answers the next request (once) with this status, code and message, whatever it is. */
  failNext: { status: number; code: string; message: string } | null;
  /** Holds every request until it settles (a slow daemon). */
  hold: Promise<void> | null;
}

export interface MockedApi {
  /** Every mocked request, in order. */
  readonly requests: URL[];
  count(pathname: string): number;
  /** The review state of a change (marks, note, writes made, hooks to fail or hold a write), created on first use. */
  review(changeId: number): ReviewMock;
  /** The findings routes' state of a change (writes made, fix queue, hooks to fail, drop or hold a write), created on first use. */
  findings(changeId: number): FindingsMock;
  /** The approve route's state of a change, created on first use. */
  approval(changeId: number): ApprovalMock;
  /** The agent routes' state of a change, created on first use. */
  agent(changeId: number): AgentMock;
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
    findingsMocks: new Map(),
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

/** The mock's token of "Check the rest and approve": 64 hex over the snapshot and the listed files, like the daemon's. */
const remainingToken = (snapshotId: number, files: readonly string[]): string =>
  createHash('sha256').update(`${String(snapshotId)}\n${files.join('\n')}`).digest('hex');

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

  const findings = (changeId: number): FindingsMock => {
    let mock = data.findingsMocks.get(changeId);
    if (mock === undefined) {
      mock = createFindingsMock();
      data.findingsMocks.set(changeId, mock);
    }
    return mock;
  };

  const approvals = new Map<number, ApprovalMock>();
  const approval = (changeId: number): ApprovalMock => {
    let mock = approvals.get(changeId);
    if (mock === undefined) {
      mock = { writes: [], bodies: [], remainingReads: 0, holdRemaining: null, failNext: null, hold: null };
      approvals.set(changeId, mock);
    }
    return mock;
  };
  const agents = new Map<number, AgentMock>();
  const agent = (changeId: number): AgentMock => {
    let mock = agents.get(changeId);
    if (mock === undefined) {
      mock = { preview: agentPreview(), runs: { running: false, latest: null }, writes: [], queued: [], failNext: null, hold: null };
      agents.set(changeId, mock);
    }
    return mock;
  };
  const liveChange = (id: number): ChangeSummary | undefined => data.details.flatMap((detail) => detail.changes).find((candidate) => candidate.id === id);

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
      // Before the review routes: `review/summary/queue` is an agent route (ADR-029).
      if ((match = /^\/api\/changes\/(\d+)\/(agent\/preview|agent\/run|agent\/runs|review\/summary\/queue)$/.exec(path))) {
        const id = Number(match[1]);
        const mock = agent(id);
        const which = match[2] ?? '';
        const method = route.request().method();
        if (which === 'agent/runs') return method === 'GET' ? answer(route, mock.runs) : answer(route, notFound('GET only'), 404);
        if (method !== 'POST') return answer(route, notFound('POST only'), 404);
        const body: unknown = route.request().postData() === null ? null : (route.request().postDataJSON() as unknown);
        const kind = which === 'agent/preview' ? 'preview' : which === 'agent/run' ? 'run' : 'queue';
        mock.writes.push({ route: kind, body });
        if (mock.hold !== null) await mock.hold;
        if (mock.failNext !== null) {
          const { status, code, message } = mock.failNext;
          mock.failNext = null;
          return answer(route, { error: { code, message } }, status);
        }
        if (kind === 'preview') return answer(route, mock.preview);
        const fields = (body ?? {}) as { token?: unknown; summaryHash?: unknown };
        if (fields.summaryHash !== mock.preview.summaryHash) {
          return answer(route, { error: { code: 'summary-changed', message: 'the summary is not the one previewed; preview again' } }, 409);
        }
        if (kind === 'queue') {
          const queued = !mock.queued.includes(mock.preview.summaryHash);
          if (queued) mock.queued.push(mock.preview.summaryHash);
          return answer(route, { key: `review-summary:${String(id)}:${mock.preview.summaryHash.slice(0, 16)}`, queued, count: mock.queued.length });
        }
        if (mock.preview.token === null || fields.token !== mock.preview.token) {
          return answer(route, { error: { code: 'token-invalid', message: 'the confirmation is unknown, used or expired; preview again' } }, 409);
        }
        const runId = '0123456789abcdef';
        mock.runs = {
          running: true,
          latest: { runId, state: 'running', mode: mock.preview.mode ?? 'new', startedAt: new Date().toISOString(), durationMs: null, exitCode: null, log: `${String(id)}-${runId}.log`, message: null },
        };
        return answer(route, { runId }, 202);
      }
      if ((match = /^\/api\/changes\/(\d+)\/review(\/.*)?$/.exec(path))) {
        const id = Number(match[1]);
        // Without a seed (and no shared state) the daemon has nothing to review: 409 no-snapshot.
        if (data.review === undefined && !reviews.has(id)) return answer(route, { error: { code: 'no-snapshot', message: 'no snapshot yet' } }, 409);
        return answerReview(route, review(id), data.reports[id], match[2] ?? '');
      }
      if ((match = /^\/api\/changes\/(\d+)\/findings\/([^/]+)\/([a-z]+)$/.exec(path))) {
        const id = Number(match[1]);
        return answerFindings(route, findings(id), data.reports[id], decodeURIComponent(match[2] ?? ''), match[3] ?? '');
      }
      if ((match = /^\/api\/changes\/(\d+)\/approve\/remaining$/.exec(path))) {
        // "Check the rest and approve" (DC-135): the unmarked touched tier 1 files of the latest snapshot, and a token over both.
        const id = Number(match[1]);
        if (route.request().method() !== 'GET') return answer(route, notFound('GET only'), 404);
        const mock = approval(id);
        mock.remainingReads += 1;
        if (mock.holdRemaining !== null) await mock.holdRemaining;
        const report = data.reports[id];
        if (report === undefined) return answer(route, { error: { code: 'no-snapshot', message: `change ${String(id)} has no snapshot yet` } }, 409);
        const snapshotId = reviews.get(id)?.snapshotId ?? 1;
        const files = uncheckedTier1Files(report, reviews.get(id)?.marks ?? []);
        return answer(route, { snapshotId, head: liveChange(id)?.head ?? report.meta.head, files, token: remainingToken(snapshotId, files) });
      }
      if ((match = /^\/api\/changes\/(\d+)\/approve$/.exec(path))) {
        // Stands in for the daemon (DC-100): the gate from the latest Report and the stored marks, with core's own rule.
        const id = Number(match[1]);
        const method = route.request().method();
        if (method !== 'POST' && method !== 'DELETE') return answer(route, notFound('no such approve route'), 404);
        const mock = approval(id);
        mock.writes.push(method);
        const body: unknown = method === 'POST' && route.request().postData() !== null ? (route.request().postDataJSON() as unknown) : null;
        if (method === 'POST') mock.bodies.push(body);
        if (mock.hold !== null) await mock.hold;
        if (mock.failNext !== null) {
          const { status, code, message } = mock.failNext;
          mock.failNext = null;
          return answer(route, { error: { code, message } }, status);
        }
        const change = liveChange(id);
        if (change === undefined) return answer(route, notFound(`change ${String(id)} not found`), 404);
        if (method === 'DELETE') {
          if (change.reviewState !== 'approved') return answer(route, { error: { code: 'not-approved', message: `change ${String(id)} is not approved` } }, 409);
          Object.assign(change, { reviewState: 'in-review', approvedHead: null, approvedAt: null });
          return answer(route, { reviewState: 'in-review', approvedHead: null, approvedAt: null });
        }
        const report = data.reports[id];
        if (report === undefined) return answer(route, { error: { code: 'no-snapshot', message: `change ${String(id)} has no snapshot yet` } }, 409);
        const bulk = body as { checkRemaining?: unknown; snapshotId?: unknown; files?: unknown; token?: unknown } | null;
        if (bulk?.checkRemaining === true) {
          // As the daemon does it: the token binds the snapshot and the list shown; the list must still be the one to mark.
          const review = reviews.get(id);
          const files = Array.isArray(bulk.files) ? (bulk.files as string[]) : [];
          if (review === undefined || bulk.snapshotId !== review.snapshotId || bulk.token !== remainingToken(review.snapshotId, files)) {
            return answer(route, { error: { code: 'snapshot-moved', message: 'the change was recomputed since the confirmation; look again before approving' } }, 409);
          }
          const now = uncheckedTier1Files(report, review.marks);
          if (now.length !== files.length || now.some((file, index) => file !== files[index])) {
            return answer(route, { error: { code: 'remaining-changed', message: 'the files without a mark are not the ones the confirmation listed; look again' } }, 409);
          }
          for (const file of report.packages.flatMap((pkg) => pkg.files).filter((candidate) => now.includes(candidate.path))) {
            const at = new Date().toISOString();
            review.marks = [
              ...review.marks.filter((other) => !(other.targetKind === 'file' && other.targetId === file.id)),
              { targetKind: 'file', targetId: file.id, filePath: file.path, mark: 'checked', note: null, lines: null, state: 'current', createdAt: at, updatedAt: at, outdatedAt: null },
            ];
          }
          if (change.reviewState !== 'approved') Object.assign(change, { reviewState: 'approved', approvedHead: change.head, approvedAt: new Date().toISOString() });
          return answer(route, { reviewState: 'approved', approvedHead: change.approvedHead, approvedAt: change.approvedAt, marked: now });
        }
        const unchecked = uncheckedTier1Files(report, reviews.get(id)?.marks ?? []);
        if (unchecked.length > 0) {
          const message = `${String(unchecked.length)} touched tier 1 file(s) have no current review mark: ${unchecked.join(', ')}`;
          return answer(route, { error: { code: 'tier1-unchecked', message } }, 409);
        }
        if (change.reviewState !== 'approved') Object.assign(change, { reviewState: 'approved', approvedHead: change.head, approvedAt: new Date().toISOString() });
        return answer(route, { reviewState: 'approved', approvedHead: change.approvedHead, approvedAt: change.approvedAt });
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
      if ((match = /^\/api\/changes\/(\d+)\/sessions$/.exec(path))) {
        const id = Number(match[1]);
        const sessions = data.sessions?.[id];
        if (sessions) return answer(route, sessions);
        const known = data.reports[id] !== undefined || liveChange(id) !== undefined || Object.values(data.archived).flat().some((change) => change.id === id);
        return known ? answer(route, { sessions: [], total: 0 }) : answer(route, notFound(`change ${String(id)} not found`), 404);
      }
      if (path === '/api/search') return answer(route, data.search(url.searchParams.get('q') ?? ''));
      return answer(route, notFound(`no mock for ${path}`), 404);
    },
  );

  return {
    requests,
    count: (pathname) => requests.filter((url) => url.pathname === pathname).length,
    review,
    findings,
    approval,
    agent,
  };
}
