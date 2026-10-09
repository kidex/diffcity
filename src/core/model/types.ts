// Shared collection contracts for phase 2: DB records (ADR-018), API DTOs and
// SSE events (ADR-017), the socket protocol v1 (ADR-016), daemon files
// (ADR-015) and the collector port (ADR-019, ADR-020, ADR-021).
//
// Types only, with no runtime code: the UI imports this file with `import type`
// (ADR-022). Times are ISO 8601 UTC strings everywhere, so every value survives
// JSON unchanged. Ids are SQLite integer row ids.

import type { Report, Status, Verdict } from '../report/types.js';
import type { FindingInput, ParseWarning } from '../findings/types.js';
import type { Activity, AgentRun, SessionDigest } from '../session/types.js';

// ---------------------------------------------------------------------------
// Enumerations (ADR-018 CHECK constraints, ADR-017, ADR-020)

/** Label of a change in the list (SPEC.md section 3a): Draft, Branch or PR #N. */
export type ChangeKind = 'draft' | 'branch' | 'pr';

/** Review state of a change (SPEC.md section 3a, ADR-019). */
export type ReviewState = 'unreviewed' | 'in-review' | 'approved';

/** Type of a recorded event; `review` and `import` arrive in phase 4, `audit` in phase 5. */
export type EventType = 'collect' | 'agent' | 'commit' | 'review' | 'import' | 'audit';

/**
 * Type of a row of `events`: every EventType, and `agent-run` (schema v4,
 * ADR-029, ADR-038), which is never a change's last event.
 */
export type EventLogType = EventType | 'agent-run';

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

/**
 * `snapshots.summary`: `Report.summary` plus the number of touched files and
 * of open high findings in the stored Report (its rule findings, ADR-030), for
 * the repo's `highFindings` (DC-120). `openHigh` is absent in snapshots stored
 * before it existed, which had no rule findings: read as 0.
 */
export type SnapshotSummary = Report['summary'] & { touchedFiles: number; openHigh?: number };

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
  /** The merge-base the before state was read from; null on a snapshot written before schema v2. */
  mergeBase: string | null;
  /** The serialized Fingerprints (ADR-027), verbatim; null on a snapshot written before schema v2. */
  fingerprints: string | null;
}

/** A row of `events`. `changeId` is null for repo-level events (an agent run on a clean base). */
export interface EventRecord {
  id: number;
  repoId: number;
  changeId: number | null;
  type: EventLogType;
  at: string;
  /** Parsed JSON payload; null when the event has none. */
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Fingerprints (ADR-027) and review marks (ADR-028)

/** Hashes of one file's bytes (ADR-027): sha256 hex, null on the side where the file does not exist. */
export interface FileFingerprint {
  before: string | null;
  after: string | null;
  /** The path in the before state, for a renamed file. */
  oldPath?: string;
}

/**
 * What a snapshot fingerprints (ADR-027): `files` is keyed by `File.id`, every
 * file of the Report has an entry; `symbols` by `Symbol.id`, the hash covers the
 * symbol's before slice + `\0` + after slice. Untouched files have `before === after`.
 */
export interface Fingerprints {
  files: Record<string, FileFingerprint>;
  symbols: Record<string, string>;
}

/** Syntax highlight class of a span in a diff row (ADR-027). */
export type HighlightClass = 'kw' | 'str' | 'num' | 'com' | 'type' | 'fn' | 'prop' | 'op' | 'punc' | 'var';

/** One row of a file diff (ADR-027). */
export interface DiffRow {
  kind: 'ctx' | 'add' | 'del';
  /** Line number in before; null on an added row. */
  old: number | null;
  /** Line number in after; null on a deleted row. */
  new: number | null;
  /** At most 4,000 characters; `cut: true` when the line was longer. */
  text: string;
  cut?: true;
  hl?: [start: number, end: number, cls: HighlightClass][];
}

/** The diff of one file between before and after (ADR-027). */
export interface FileDiff {
  snapshotId: number;
  head: string;
  path: string;
  oldPath?: string;
  language: string;
  kind: 'text' | 'binary' | 'too-large' | 'unchanged' | 'unavailable';
  /** For `unavailable` and `too-large`. */
  reason?: string;
  /** The working tree changed since the snapshot. */
  stale: boolean;
  stats: { added: number; removed: number };
  /** Bytes. */
  sizes: { before: number | null; after: number | null };
  rows?: DiffRow[];
  hunks?: { first: number; last: number }[];
  folds?: { first: number; last: number }[];
  symbols?: { id: string; first: number; last: number }[];
  focus?: { id: string; first: number; last: number };
}

/** What a review mark says about its target (ADR-028). */
export type ReviewMarkValue = 'checked' | 'good' | 'rewrite';

/** A reviewer's mark on a file or symbol of a change (ADR-028); a row of `review_marks`. */
export interface ReviewMark {
  targetKind: 'file' | 'symbol';
  /** `File.id` or `Symbol.id` of the Report. */
  targetId: string;
  /** The file the target is in. */
  filePath: string;
  mark: ReviewMarkValue;
  /** Required for `rewrite`, 1..2000 characters. */
  note: string | null;
  lines: { side: 'old' | 'new'; start: number; end: number } | null;
  /** `outdated` once the target's fingerprint changed since the mark. */
  state: 'current' | 'outdated';
  createdAt: string;
  updatedAt: string;
  outdatedAt: string | null;
}

/** How far the review of a change has got (ADR-028); computed in the daemon. */
export interface ReviewProgress {
  attention: { done: number; total: number };
  touched: { done: number; total: number };
  /**
   * Touched tier 1 files (`summary.tier1Files`) with a current mark, out of all
   * of them; `done === total` exactly when the Approve gate (ADR-036) passes,
   * including when there are none.
   */
  tier1: { done: number; total: number };
  rewrite: number;
  outdated: number;
  allAttentionDone: boolean;
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
  /** Open `high` findings in the served Reports (ADR-036) of the live changes: rule and imported, merged, on files in the change (DC-106). */
  highFindings: number;
  /** Null until phase 5; the UI shows "never audited". */
  lastAudit: { at: string } | null;
  /** Archived changes still stored (merged, deleted, closed, cleaned; kept 90 days, ADR-019); what the Repo screen's closed list shows. */
  archivedCount: number;
  collecting: boolean;
  /** `repos.collectError`. */
  error: string | null;
  watch: WatchMode;
  /**
   * Non-fatal notes from the daemon, such as a config file not loaded because
   * the repo is not trusted (ADR-030); empty when there is nothing to say.
   */
  notes: RepoNote[];
}

/** A repo note: `code` is stable for the UI to word it, `text` is the daemon's own wording (the fallback for unknown codes). */
export interface RepoNote {
  code: string;
  text: string;
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
  /** The head the change was approved at; null when not approved (ADR-036). */
  approvedHead: string | null;
  /** When the change was approved (ISO 8601); null when not approved. */
  approvedAt: string | null;
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

/**
 * A run of a session as the sessions route serves it. `here`: it worked in the
 * change's working tree. `parentAgentId` names a run that is in the same
 * view; it is null for runs of the main agent and for a run whose parent was
 * left out, so it never points at a run the view does not have.
 */
export interface SessionRunView extends AgentRun {
  here: boolean;
}

/**
 * A session digest as served: no parse state (cursors, hashes, the runs'
 * working directories) and none of the fields SessionView already has
 * (sessionId, title, firstAt, lastAt). Runs that worked in another working
 * tree of the repo are left out and counted.
 *
 * Activity is scoped to what the view shows: `main` is the main agent's
 * activity when the session ran in the change's working tree, null otherwise;
 * each kept run carries its own. The session's totals over every agent, shown
 * or not, are in `sessionWide`.
 */
export type SessionDigestView = Omit<
  SessionDigest,
  'state' | 'runs' | 'sessionId' | 'title' | 'firstAt' | 'lastAt' | 'main' | 'files' | 'filesDropped' | 'outsideFiles'
> & {
  runs: SessionRunView[];
  /** Runs left out because they worked in another working tree of the repo. */
  runsElsewhere: number;
  main: Activity | null;
  sessionWide: {
    /** Repo-relative files edited by the main agent and every run. */
    files: string[];
    filesDropped: number;
    /** Distinct files edited outside the repo. */
    outsideFiles: number;
  };
};

/**
 * A Claude Code session linked to a change (ADR-038), served by
 * `GET /api/changes/:id/sessions` outside the Report (ADR-002).
 */
export interface SessionView {
  sessionId: string;
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
  /** The session ran in the change's working tree. */
  here: boolean;
  /** False once Claude Code reported the session ended (`SessionEnd`); true while it may go on. */
  active: boolean;
  /** No digest could ever be read: shown as "Session data could not be read", without content; `digest` is null. */
  unreadable: boolean;
  /** The last read failed; `digest` is the last good one. */
  stale: boolean;
  /** The change's head when the session was first and last linked to it. */
  firstHead: string | null;
  lastHead: string | null;
  linkedAt: string;
  /** Null until the transcript was read, and when it is `unreadable`. */
  digest: SessionDigestView | null;
}

/** `GET /api/changes/:id/sessions`: at most 20 sessions, newest first, and how many are linked in all. */
export interface SessionsResponse {
  sessions: SessionView[];
  total: number;
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
  | { event: 'review'; data: { repoId: number; changeId: number } }
  /** The findings of a change moved (an import, a state, a queued fix; ADR-036): refetch its Report. */
  | { event: 'findings'; data: { repoId: number; changeId: number } }
  /** A read of a session linked to the change was stored (ADR-038): refetch GET /api/changes/:id/sessions. No session content. */
  | { event: 'sessions'; data: { changeId: number } }
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
  /**
   * `dir` is absolute; `at` is the ISO time of the request. `session` comes
   * with `agent` when the Claude Code hook JSON was valid (ADR-038); daemons
   * that predate it ignore the field, and the daemon validates every value
   * before it touches a file.
   */
  | { v: SocketProtocolVersion; type: 'track'; dir: string; agent: boolean; at: string; session?: TrackSession }
  /** `dirs` are absolute repo roots (from `scan`). */
  | { v: SocketProtocolVersion; type: 'register'; dirs: string[] }
  /**
   * `diffcity import` (ADR-036): the findings the CLI parsed from its file, for
   * the change checked out in `dir` (absolute). `sources` are the sources the
   * import covers (ParseResult.sources); when absent, those of the findings.
   * The only request whose line may exceed 64 KiB (up to 4 MiB).
   */
  | {
      v: SocketProtocolVersion;
      type: 'import';
      dir: string;
      findings: FindingInput[];
      warnings: ParseWarning[];
      sources?: string[];
      at: string;
    }
  /**
   * `diff --with-sessions` (ADR-038): the sessions of the change checked out
   * in `dir` (absolute), as GET /api/changes/:id/sessions serves them.
   */
  | { v: SocketProtocolVersion; type: 'sessions'; dir: string }
  | { v: SocketProtocolVersion; type: 'shutdown' };

/** The session fields of a `track` request (ADR-038), forwarded from the hook JSON as they came. */
export interface TrackSession {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  /** `hook_event_name`; `Stop` when the hook gave none. */
  event: string;
}

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
  /**
   * `import` (ADR-036), once the findings are stored. `imported`: findings
   * anchored to the change, merged ones included; `merged`: those that
   * collapsed into an existing entry; `skipped`: entries skipped by the parser
   * plus findings outside the change; `fixed`: stored findings this import
   * fixed. `warnings`: the parse warnings, then one per finding outside the
   * change. `anchoredAgainst` is `previous-snapshot` when no snapshot at the
   * current content was ready within 20 s.
   */
  import: {
    ok: true;
    /** `ref` is the change's identity in its repo: `branch:<name>`, `pr:<n>` or `draft:<path>`. */
    change: { id: number; repoId: number; ref: string };
    imported: number;
    merged: number;
    skipped: number;
    fixed: number;
    warnings: ParseWarning[];
    anchoredAgainst: ImportAnchor;
  };
  /** `sessions` (ADR-038): the change checked out in the directory and its sessions. */
  sessions: { ok: true; change: { id: number; repoId: number; ref: string }; sessions: SessionView[]; total: number };
  shutdown: { ok: true };
}

/** Which snapshot an import was anchored against (ADR-036). */
export type ImportAnchor = 'current-snapshot' | 'previous-snapshot';

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
 * scheduler). Requests for one repo coalesce under the key `<repoId>:sources`
 * whatever their scope (ADR-021): a queued collection merges the scopes of the
 * requests it absorbs and keeps the highest priority; a request during a
 * running collection gives one more run afterwards.
 */
export interface CollectorPort {
  /** Resolves when a collection covering this request has finished; never rejects. */
  request(repoId: number, scope: CollectScope, priority: CollectPriority): Promise<CollectOutcome>;
}
