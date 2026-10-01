// Shared collection contracts for phase 2: DB records (ADR-018), API DTOs and
// SSE events (ADR-017), the socket protocol v1 (ADR-016), daemon files
// (ADR-015) and the collector port (ADR-019, ADR-020, ADR-021).
//
// Types only, with no runtime code: the UI imports this file with `import type`
// (ADR-022). Times are ISO 8601 UTC strings everywhere, so every value survives
// JSON unchanged. Ids are SQLite integer row ids.

import type { Report, Status, Verdict } from '../report/types.js';

// ---------------------------------------------------------------------------
// Enumerations (ADR-018 CHECK constraints, ADR-017, ADR-020)

/** Label of a change in the list (SPEC.md section 3a): Draft, Branch or PR #N. */
export type ChangeKind = 'draft' | 'branch' | 'pr';

/** Review state of a change (SPEC.md section 3a, ADR-019). */
export type ReviewState = 'unreviewed' | 'in-review' | 'approved';

/** Type of a recorded event; `review` and `import` arrive in phase 4, `audit` in phase 5. */
export type EventType = 'collect' | 'agent' | 'commit' | 'review' | 'import' | 'audit';

/** Why a change left the live list (ADR-019, SPEC.md section 3a L7). */
export type ArchiveReason = 'merged' | 'deleted' | 'closed' | 'clean';

/**
 * How a repo is watched (ADR-020): `full` = git + working trees, `git-only` =
 * working trees over the 10,000-directory budget, `off` = inactive repo.
 */
export type WatchMode = 'full' | 'git-only' | 'off';

// ---------------------------------------------------------------------------
// DB records (ADR-018, schema v1)
//
// One interface per table row, with the column names of the schema. The stores
// in src/core/db decode the storage forms: INTEGER 0/1 columns become booleans
// and JSON columns are parsed, except `snapshots.report`, which stays the
// serialized Report and is served verbatim.

/** `repos.lastAudit`: the last full audit; null until phase 5. */
export interface LastAudit {
  at: string;
  commit: string;
  model: string;
  rulesetVersion: string;
}

/** A row of `repos`. The repo identity is `gitCommonDir` (ADR-019). */
export interface RepoRecord {
  id: number;
  /** Realpath of the main working tree. */
  path: string;
  /** Realpath of `git rev-parse --git-common-dir`. */
  gitCommonDir: string;
  name: string;
  /** Resolved base ref, cached; null until resolved. */
  base: string | null;
  active: boolean;
  /** Effective tier 1 tokens after config; null = the defaults. */
  tier1Paths: string[] | null;
  lastAudit: LastAudit | null;
  lastSeenAt: string;
  createdAt: string;
  /** Last collection error; null when the last collection succeeded. */
  collectError: string | null;
}

/** A row of `changes`. Live while `archivedAt` is null; `(repoId, ref)` is unique among live rows. */
export interface ChangeRecord {
  id: number;
  repoId: number;
  kind: ChangeKind;
  /** Identity inside the repo (ADR-019): `pr:<number>`, `branch:<name>` or `draft:<worktree path relative to repos.path>`. */
  ref: string;
  /** Set for `pr` changes only. */
  prNumber: number | null;
  /** Commit sha. */
  head: string;
  /** False for a PR whose head commit is not in the local repo (no fetch, ADR-019). */
  headAvailable: boolean;
  /** Uncommitted changes are folded in (ADR-019). */
  dirty: boolean;
  /** Working tree where the change is checked out; null otherwise. */
  worktreePath: string | null;
  base: string;
  title: string;
  /** Null when the head is not available locally. */
  ahead: number | null;
  /** Null when the head is not available locally. */
  behind: number | null;
  reviewState: ReviewState;
  lastEventType: EventType;
  lastEventAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Set exactly when `archivedAt` is set. */
  archiveReason: ArchiveReason | null;
}

/** `snapshots.summary`: `Report.summary` plus the number of touched files. */
export type SnapshotSummary = Report['summary'] & { touchedFiles: number };

/** A row of `snapshots`: one per `(changeId, head)`; the latest by `computedAt` is the one shown. */
export interface SnapshotRecord {
  id: number;
  changeId: number;
  head: string;
  dirty: boolean;
  /** The serialized Report (SPEC.md section 4.1), verbatim. */
  report: string;
  summary: SnapshotSummary;
  /** Touched file paths, for search. */
  touched: string[];
  /** sha256 of the report with `meta.generatedAt` emptied. */
  contentHash: string;
  computedAt: string;
}

/** A row of `events`. `changeId` is null for repo-level events (an agent run on a clean base). */
export interface EventRecord {
  id: number;
  repoId: number;
  changeId: number | null;
  type: EventType;
  at: string;
  /** Parsed JSON payload; null when the event has none. */
  payload: unknown;
}

// ---------------------------------------------------------------------------
// API DTOs (ADR-017)

/** An element of `GET /api/repos`, ordered by `lastEventAt` desc; also the header of `GET /api/repos/:id`. */
export interface RepoSummary {
  id: number;
  name: string;
  path: string;
  active: boolean;
  lastSeenAt: string;
  /** Time of the latest event of the repo or of its live changes; null when there is none yet. */
  lastEventAt: string | null;
  /** Live (non-archived) changes by kind. */
  counts: Record<ChangeKind, number>;
  /** Live changes with `reviewState: 'unreviewed'`; drives the lot size in Fleet. */
  unreviewed: number;
  /** Open `high` findings on the latest snapshots of live changes; 0 until phase 4. */
  highFindings: number;
  /** Null until phase 5; the UI shows "never audited". */
  lastAudit: { at: string } | null;
  collecting: boolean;
  /** `repos.collectError`. */
  error: string | null;
  watch: WatchMode;
}

/** Counters of a change, read from the latest snapshot's summary. */
export interface ChangeStats {
  touchedFiles: number;
  symbolsByStatus: Record<Status, number>;
  filesByVerdict: Record<Verdict, number>;
  /** Touched tier 1 file paths, as in `Report.summary.tier1Files`. */
  tier1Files: string[];
}

/** A change as listed by the API. */
export interface ChangeSummary {
  id: number;
  repoId: number;
  kind: ChangeKind;
  ref: string;
  prNumber: number | null;
  head: string;
  headAvailable: boolean;
  dirty: boolean;
  base: string;
  title: string;
  ahead: number | null;
  behind: number | null;
  reviewState: ReviewState;
  /** "Agent worked, not reviewed": `reviewState === 'unreviewed'` and the last event is `agent` (ADR-018). */
  agentUnreviewed: boolean;
  lastEvent: { type: EventType; at: string };
  updatedAt: string;
  archivedAt: string | null;
  archiveReason: ArchiveReason | null;
  /** Null while there is no snapshot ("computing"). */
  stats: ChangeStats | null;
}

/** `GET /api/repos/:id`: the repo and its live changes, ordered by `lastEvent.at` desc. */
export interface RepoDetail {
  repo: RepoSummary;
  changes: ChangeSummary[];
}

/** `GET /api/health`. */
export interface HealthResponse {
  version: string;
  pid: number;
  startedAt: string;
  /** Collections currently running or queued. */
  collecting: number;
}

/** Body of every API error response. */
export interface ApiError {
  error: { code: string; message: string };
}

/** A Cmd+K result from `GET /api/search`; computed in the daemon. */
export type SearchResult =
  | { kind: 'repo'; label: string; detail: string; repoId: number }
  | { kind: 'change'; label: string; detail: string; repoId: number; changeId: number }
  | { kind: 'file'; label: string; detail: string; repoId: number; changeId: number; path: string };

// ---------------------------------------------------------------------------
// SSE (ADR-017): small signals; the UI refetches over REST.

/** An event on `GET /api/events`: `event` is the SSE event name, `data` its JSON payload. */
export type SseEvent =
  | { event: 'hello'; data: { version: string; startedAt: string } }
  | { event: 'repo'; data: { repoId: number } }
  | { event: 'changes'; data: { repoId: number } }
  | { event: 'snapshot'; data: { repoId: number; changeId: number; head: string } }
  | {
      event: 'collect';
      data: { repoId: number; state: 'started' | 'done' } | { repoId: number; state: 'error'; error: string };
    };

export type SseEventName = SseEvent['event'];

/** The SSE event with the given name. */
export type SseEventOf<E extends SseEventName> = Extract<SseEvent, { event: E }>;

// ---------------------------------------------------------------------------
// Socket protocol v1 (ADR-016): one JSON line each way per connection.

export type SocketProtocolVersion = 1;

export type SocketRequest =
  | { v: SocketProtocolVersion; type: 'ping' }
  /** `dir` is absolute; `at` is the ISO time of the request. */
  | { v: SocketProtocolVersion; type: 'track'; dir: string; agent: boolean; at: string }
  /** `dirs` are absolute repo roots (from `scan`). */
  | { v: SocketProtocolVersion; type: 'register'; dirs: string[] }
  | { v: SocketProtocolVersion; type: 'shutdown' };

export type SocketRequestType = SocketRequest['type'];

/** Any failed request, including an unknown `v` or `type` and invalid JSON. */
export interface SocketErrorResponse {
  ok: false;
  error: string;
}

/** Successful response for each request type. */
export interface SocketSuccessResponses {
  ping: { ok: true; version: string; pid: number; port: number };
  /** Sent once the repo is identified and registered; collection continues asynchronously. */
  track: { ok: true; repo: { id: number; name: string } };
  /** `registered`: repos newly registered by this request; `known`: repos that were already registered. */
  register: { ok: true; registered: number; known: number };
  shutdown: { ok: true };
}

/** What the client can receive for a request of type `T`. */
export type SocketResponseFor<T extends SocketRequestType> = SocketSuccessResponses[T] | SocketErrorResponse;

export type SocketResponse = SocketResponseFor<SocketRequestType>;

// ---------------------------------------------------------------------------
// Daemon files in DIFFCITY_HOME (ADR-015)

/** `daemon.json`, written once the socket and HTTP are both ready. */
export interface DaemonInfo {
  pid: number;
  port: number;
  /** The socket path actually in use (it may have moved to os.tmpdir()). */
  socket: string;
  version: string;
  startedAt: string;
}

/** `state.json`: the last port chosen with `up --port`, used on auto-start. */
export interface DaemonState {
  port: number;
}

// ---------------------------------------------------------------------------
// Collection (ADR-019, ADR-020, ADR-021)

/**
 * What a collection covers (ADR-020):
 * - `full`: sources + snapshots, with a PR refresh when the cache is stale (`track`, daemon start, `scan`);
 * - `refs`: a git event; sources listed again, snapshots only for changes whose head or dirty changed;
 * - `prs`: PR polling; open PRs refreshed and reconciled;
 * - `worktree:<absolute path>`: an event in that working tree; only its change is recomputed.
 */
export type CollectScope = 'full' | 'refs' | 'prs' | `worktree:${string}`;

/** Queue priority (ADR-021): `high` = `track`, `normal` = watchers, `low` = polling, start, `scan`. */
export type CollectPriority = 'high' | 'normal' | 'low';

/** How a requested collection ended. Failures are also recorded in `repos.collectError` and sent as SSE `collect`. */
export type CollectOutcome = { ok: true } | { ok: false; error: string };

/**
 * The daemon's collector as seen by its callers (socket handlers, watchers,
 * scheduler). Requests for the same repo and scope coalesce (ADR-021).
 */
export interface CollectorPort {
  /** Resolves when a collection covering this request has finished; never rejects. */
  request(repoId: number, scope: CollectScope, priority: CollectPriority): Promise<CollectOutcome>;
}
