// The shared collection contracts (src/core/model/types.ts): one value of each
// type, built exactly as ADR-015..020 describe them, plus the unions pinned.

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ApiError,
  ArchiveReason,
  ChangeKind,
  ChangeRecord,
  ChangeStats,
  ChangeSummary,
  CollectOutcome,
  CollectPriority,
  CollectScope,
  CollectorPort,
  DaemonInfo,
  DaemonState,
  EventRecord,
  EventType,
  HealthResponse,
  LastAudit,
  RepoDetail,
  RepoRecord,
  RepoSummary,
  ReviewState,
  SearchResult,
  SnapshotRecord,
  SnapshotSummary,
  SocketErrorResponse,
  SocketRequest,
  SocketResponse,
  SocketResponseFor,
  SseEvent,
  SseEventName,
  SseEventOf,
  WatchMode,
} from '../../../src/core/model/types.js';
import type { Status, Verdict } from '../../../src/core/report/types.js';

const AT = '2026-03-02T10:00:00.000Z';
const HEAD = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const byStatus: Record<Status, number> = { add: 2, mod: 1, sig: 1, del: 0, same: 9 };
const byVerdict: Record<Verdict, number> = { eyes: 1, risky: 0, spec: 0, ok: 2, same: 6 };

const lastAudit: LastAudit = { at: AT, commit: HEAD, model: 'sample-model', rulesetVersion: '1' };

const repoRecord: RepoRecord = {
  id: 1,
  path: '/work/sample-shop',
  gitCommonDir: '/work/sample-shop/.git',
  name: 'sample-shop',
  base: 'main',
  active: true,
  tier1Paths: ['auth', 'payment'],
  lastAudit: null,
  lastSeenAt: AT,
  createdAt: AT,
  collectError: null,
};

const changeRecord: ChangeRecord = {
  id: 7,
  repoId: 1,
  kind: 'pr',
  ref: 'pr:42',
  prNumber: 42,
  head: HEAD,
  headAvailable: true,
  dirty: false,
  worktreePath: null,
  base: 'main',
  title: 'Add invoice totals',
  ahead: 3,
  behind: 0,
  reviewState: 'unreviewed',
  lastEventType: 'commit',
  lastEventAt: AT,
  updatedAt: AT,
  archivedAt: null,
  archiveReason: null,
};

const snapshotSummary: SnapshotSummary = { files: 12, byStatus, byVerdict, tier1Files: ['lib/auth/session.ts'], touchedFiles: 3 };

const snapshotRecord: SnapshotRecord = {
  id: 3,
  changeId: 7,
  head: HEAD,
  dirty: false,
  report: '{"meta":{}}',
  summary: snapshotSummary,
  touched: ['lib/auth/session.ts', 'lib/ledger/invoice.ts', 'db/orders.sql'],
  contentHash: 'a'.repeat(64),
  computedAt: AT,
  mergeBase: 'b'.repeat(40),
  fingerprints: '{"files":{},"symbols":{}}',
};

const eventRecord: EventRecord = { id: 11, repoId: 1, changeId: null, type: 'agent', at: AT, payload: { dir: '/work/sample-shop' } };

const repoSummary: RepoSummary = {
  id: 1,
  name: 'sample-shop',
  path: '/work/sample-shop',
  active: true,
  lastSeenAt: AT,
  lastEventAt: AT,
  counts: { draft: 1, branch: 2, pr: 1 },
  unreviewed: 3,
  highFindings: 0,
  archivedCount: 2,
  lastAudit: null,
  collecting: false,
  error: null,
  watch: 'full',
  notes: [],
};

const stats: ChangeStats = { touchedFiles: 3, symbolsByStatus: byStatus, filesByVerdict: byVerdict, tier1Files: ['lib/auth/session.ts'] };

const changeSummary: ChangeSummary = {
  id: 7,
  repoId: 1,
  kind: 'pr',
  ref: 'pr:42',
  prNumber: 42,
  head: HEAD,
  headAvailable: true,
  dirty: false,
  base: 'main',
  title: 'Add invoice totals',
  ahead: 3,
  behind: 0,
  reviewState: 'unreviewed',
  agentUnreviewed: false,
  lastEvent: { type: 'commit', at: AT },
  updatedAt: AT,
  archivedAt: null,
  archiveReason: null,
  stats,
  approvedHead: null,
  approvedAt: null,
};

const searchResults: SearchResult[] = [
  { kind: 'repo', label: 'sample-shop', detail: '/work/sample-shop', repoId: 1 },
  { kind: 'change', label: 'Add invoice totals', detail: 'PR #42', repoId: 1, changeId: 7 },
  { kind: 'file', label: 'invoice.ts', detail: 'lib/ledger/invoice.ts', repoId: 1, changeId: 7, path: 'lib/ledger/invoice.ts' },
];

const sseEvents: SseEvent[] = [
  { event: 'hello', data: { version: '0.1.0', startedAt: AT } },
  { event: 'repo', data: { repoId: 1 } },
  { event: 'changes', data: { repoId: 1 } },
  { event: 'snapshot', data: { repoId: 1, changeId: 7, head: HEAD } },
  { event: 'review', data: { repoId: 1, changeId: 7 } },
  { event: 'collect', data: { repoId: 1, state: 'started' } },
  { event: 'collect', data: { repoId: 1, state: 'done' } },
  { event: 'collect', data: { repoId: 1, state: 'error', error: 'git failed' } },
];

const socketRequests: SocketRequest[] = [
  { v: 1, type: 'ping' },
  { v: 1, type: 'track', dir: '/work/sample-shop/lib', agent: true, at: AT },
  { v: 1, type: 'register', dirs: ['/work/sample-shop', '/work/order-service'] },
  { v: 1, type: 'shutdown' },
];

const socketError: SocketErrorResponse = { ok: false, error: 'not a git repository: /work/notes' };

const socketResponses: SocketResponse[] = [
  { ok: true, version: '0.1.0', pid: 4242, port: 4321 },
  { ok: true, repo: { id: 1, name: 'sample-shop' } },
  { ok: true, registered: 1, known: 1 },
  { ok: true },
  socketError,
];

const scopes: CollectScope[] = ['full', 'refs', 'prs', 'worktree:/work/sample-shop/.worktrees/feature-a'];
const priorities: CollectPriority[] = ['high', 'normal', 'low'];
const outcomes: CollectOutcome[] = [{ ok: true }, { ok: false, error: 'timeout after 120 s' }];

const collector: CollectorPort = {
  request: (repoId, scope, priority) => {
    expectTypeOf(repoId).toEqualTypeOf<number>();
    expectTypeOf(scope).toEqualTypeOf<CollectScope>();
    expectTypeOf(priority).toEqualTypeOf<CollectPriority>();
    return Promise.resolve({ ok: true });
  },
};

const health: HealthResponse = { version: '0.1.0', pid: 4242, startedAt: AT, collecting: 0 };
const detail: RepoDetail = { repo: repoSummary, changes: [changeSummary] };
const apiError: ApiError = { error: { code: 'no-snapshot', message: 'the report is being computed' } };
const daemonInfo: DaemonInfo = { pid: 4242, port: 4321, socket: '/work/home/daemon.sock', version: '0.1.0', startedAt: AT };
const daemonState: DaemonState = { port: 4321 };

describe('model types', () => {
  it('builds one value of each type', async () => {
    const values: unknown[] = [
      lastAudit,
      repoRecord,
      changeRecord,
      snapshotSummary,
      snapshotRecord,
      eventRecord,
      repoSummary,
      stats,
      changeSummary,
      searchResults,
      sseEvents,
      socketRequests,
      socketResponses,
      scopes,
      priorities,
      outcomes,
      health,
      detail,
      apiError,
      daemonInfo,
      daemonState,
    ];
    // Every DTO and record survives a JSON round trip unchanged: no Dates, no undefined.
    for (const value of values) expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    await expect(collector.request(1, 'refs', 'normal')).resolves.toEqual({ ok: true });
  });

  it('pins the enumerations to the values in ADR-017/018/019/020', () => {
    expectTypeOf<ChangeKind>().toEqualTypeOf<'draft' | 'branch' | 'pr'>();
    expectTypeOf<ReviewState>().toEqualTypeOf<'unreviewed' | 'in-review' | 'approved'>();
    expectTypeOf<EventType>().toEqualTypeOf<'collect' | 'agent' | 'commit' | 'review' | 'import' | 'audit'>();
    expectTypeOf<ArchiveReason>().toEqualTypeOf<'merged' | 'deleted' | 'closed' | 'clean'>();
    expectTypeOf<WatchMode>().toEqualTypeOf<'full' | 'git-only' | 'off'>();
    expectTypeOf<CollectPriority>().toEqualTypeOf<'high' | 'normal' | 'low'>();
    expectTypeOf<SseEventName>().toEqualTypeOf<'hello' | 'repo' | 'changes' | 'snapshot' | 'review' | 'findings' | 'collect'>();
    expectTypeOf<SocketRequest['type']>().toEqualTypeOf<'ping' | 'track' | 'register' | 'import' | 'sessions' | 'shutdown'>();
    expectTypeOf<SocketRequest['v']>().toEqualTypeOf<1>();
  });

  it('keeps the summary stats aligned with Report.summary', () => {
    expectTypeOf<ChangeStats['symbolsByStatus']>().toEqualTypeOf<Record<Status, number>>();
    expectTypeOf<ChangeStats['filesByVerdict']>().toEqualTypeOf<Record<Verdict, number>>();
    expectTypeOf<ChangeSummary['stats']>().toEqualTypeOf<ChangeStats | null>();
    expectTypeOf<RepoSummary['lastAudit']>().toEqualTypeOf<{ at: string } | null>();
  });

  it('narrows SSE events and socket responses by their discriminant', () => {
    expectTypeOf<SseEventOf<'snapshot'>['data']>().toEqualTypeOf<{ repoId: number; changeId: number; head: string }>();
    expectTypeOf<SocketResponseFor<'track'>>().toEqualTypeOf<
      { ok: true; repo: { id: number; name: string } } | SocketErrorResponse
    >();
    // A failed collection always carries its message; the others never do.
    // @ts-expect-error error is required with state 'error'
    const missing: SseEvent = { event: 'collect', data: { repoId: 1, state: 'error' } };
    // @ts-expect-error error is only allowed with state 'error'
    const extra: SseEvent = { event: 'collect', data: { repoId: 1, state: 'done', error: 'x' } };
    // @ts-expect-error a file result always names its change and path
    const file: SearchResult = { kind: 'file', label: 'a.ts', detail: 'a.ts', repoId: 1 };
    // @ts-expect-error scopes are 'full', 'refs', 'prs' or 'worktree:<path>'
    const scope: CollectScope = 'worktree';
    expect([missing, extra, file, scope]).toHaveLength(4);
  });
});
