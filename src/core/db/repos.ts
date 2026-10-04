// The repos table (ADR-018) and the RepoSummary DTO (ADR-017). Summaries are
// built from SQL counters and never parse a report.

import type { Connection } from './driver.js';
import type { LastAudit, RepoRecord, RepoSummary, WatchMode } from '../model/types.js';
import { isoTime, jsonOrNull, parseJsonOrNull } from './time.js';

interface RepoRow {
  id: number;
  path: string;
  gitCommonDir: string;
  name: string;
  base: string | null;
  active: number;
  tier1Paths: string | null;
  lastAudit: string | null;
  lastSeenAt: string;
  createdAt: string;
  collectError: string | null;
}

interface RepoSummaryRow extends RepoRow {
  drafts: number;
  branches: number;
  prs: number;
  unreviewed: number;
  highFindings: number;
  archivedCount: number;
  lastRepoEventAt: string | null;
  lastChangeEventAt: string | null;
}

/** A repo to register; `active` and `seenAt` apply only when it is new. */
export interface RepoInput {
  /** Realpath of the main working tree. */
  path: string;
  /** Realpath of `git rev-parse --git-common-dir`: the identity of the repo. */
  gitCommonDir: string;
  name: string;
  active: boolean;
  seenAt: string;
}

/** Daemon state that is not in the database, merged into each RepoSummary. */
export interface RepoRuntime {
  collecting: boolean;
  watch: WatchMode;
  /** RepoSummary.notes. */
  notes: string[];
}

/** Runtime state for a repo; without one, a summary says not collecting and `full`/`off` by `active`. */
export type RepoRuntimeLookup = (repo: RepoRecord) => RepoRuntime;

export interface RepoStore {
  /**
   * Registers a repo by `gitCommonDir`. A known repo keeps its row, `active`
   * and `lastSeenAt`; only `path` and `name` are refreshed.
   */
  upsert(input: RepoInput): { repo: RepoRecord; created: boolean };
  get(id: number): RepoRecord | null;
  getByGitCommonDir(gitCommonDir: string): RepoRecord | null;
  /** Every repo, by id. */
  list(): RepoRecord[];
  setActive(id: number, active: boolean): void;
  touchSeen(id: number, at: string): void;
  setBase(id: number, base: string | null): void;
  setTier1Paths(id: number, tier1Paths: string[] | null): void;
  /** Records the last collection error; null after a successful collection. */
  setCollectError(id: number, error: string | null): void;
  /** RepoSummary for each repo, by `lastEventAt` desc (repos without events last), then name. */
  listSummaries(runtime?: RepoRuntimeLookup): RepoSummary[];
  getSummary(id: number, runtime?: RepoRuntimeLookup): RepoSummary | null;
}

function toRecord(row: RepoRow): RepoRecord {
  return {
    id: row.id,
    path: row.path,
    gitCommonDir: row.gitCommonDir,
    name: row.name,
    base: row.base,
    active: row.active === 1,
    tier1Paths: parseJsonOrNull(row.tier1Paths) as string[] | null,
    lastAudit: parseJsonOrNull(row.lastAudit) as LastAudit | null,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    collectError: row.collectError,
  };
}

const defaultRuntime: RepoRuntimeLookup = (repo) => ({ collecting: false, watch: repo.active ? 'full' : 'off', notes: [] });

function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function toSummary(row: RepoSummaryRow, runtime: RepoRuntimeLookup): RepoSummary {
  const repo = toRecord(row);
  const { collecting, watch, notes } = runtime(repo);
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    active: repo.active,
    lastSeenAt: repo.lastSeenAt,
    lastEventAt: laterOf(row.lastRepoEventAt, row.lastChangeEventAt),
    counts: { draft: row.drafts, branch: row.branches, pr: row.prs },
    unreviewed: row.unreviewed,
    highFindings: row.highFindings,
    archivedCount: row.archivedCount,
    lastAudit: repo.lastAudit === null ? null : { at: repo.lastAudit.at },
    collecting,
    error: repo.collectError,
    watch,
    notes,
  };
}

/** Sort order of `GET /api/repos`: latest event first, repos without events last, then name and id. */
function compareSummaries(a: RepoSummary, b: RepoSummary): number {
  if (a.lastEventAt !== b.lastEventAt) {
    if (a.lastEventAt === null) return 1;
    if (b.lastEventAt === null) return -1;
    return a.lastEventAt > b.lastEventAt ? -1 : 1;
  }
  return a.name.localeCompare(b.name) || a.id - b.id;
}

// Live = archivedAt IS NULL. The repo's last event covers repo-level events and
// those of live changes, plus each live change's lastEventAt (a commit time is
// not always an event row). High findings count open `high` findings on the
// head of each live change's latest snapshot; the table is empty until phase 4.
const SUMMARY_SELECT = `
SELECT r.*,
  (SELECT count(*) FROM changes c WHERE c.repoId = r.id AND c.archivedAt IS NULL AND c.kind = 'draft') AS drafts,
  (SELECT count(*) FROM changes c WHERE c.repoId = r.id AND c.archivedAt IS NULL AND c.kind = 'branch') AS branches,
  (SELECT count(*) FROM changes c WHERE c.repoId = r.id AND c.archivedAt IS NULL AND c.kind = 'pr') AS prs,
  (SELECT count(*) FROM changes c
     WHERE c.repoId = r.id AND c.archivedAt IS NULL AND c.reviewState = 'unreviewed') AS unreviewed,
  (SELECT count(*) FROM findings f JOIN changes c ON c.id = f.changeId
     WHERE c.repoId = r.id AND c.archivedAt IS NULL AND f.state = 'open'
       AND json_extract(f.finding, '$.severity') = 'high'
       AND f.head = (SELECT s.head FROM snapshots s WHERE s.changeId = c.id
                     ORDER BY s.computedAt DESC, s.id DESC LIMIT 1)) AS highFindings,
  (SELECT count(*) FROM changes c WHERE c.repoId = r.id AND c.archivedAt IS NOT NULL) AS archivedCount,
  (SELECT max(e.at) FROM events e LEFT JOIN changes c ON c.id = e.changeId
     WHERE e.repoId = r.id AND (e.changeId IS NULL OR c.archivedAt IS NULL)) AS lastRepoEventAt,
  (SELECT max(c.lastEventAt) FROM changes c
     WHERE c.repoId = r.id AND c.archivedAt IS NULL) AS lastChangeEventAt
FROM repos r`;

export function createRepoStore(db: Connection): RepoStore {
  const byId = db.prepare<[number], RepoRow>('SELECT * FROM repos WHERE id = ?');
  const byCommonDir = db.prepare<[string], RepoRow>('SELECT * FROM repos WHERE gitCommonDir = ?');
  const all = db.prepare<[], RepoRow>('SELECT * FROM repos ORDER BY id');
  const insert = db.prepare<[string, string, string, number, string, string], RepoRow>(
    `INSERT INTO repos (path, gitCommonDir, name, active, lastSeenAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  );
  const refresh = db.prepare<[string, string, number], RepoRow>(
    'UPDATE repos SET path = ?, name = ? WHERE id = ? RETURNING *',
  );
  const summaries = db.prepare<[], RepoSummaryRow>(SUMMARY_SELECT);
  const summaryById = db.prepare<[number], RepoSummaryRow>(`${SUMMARY_SELECT} WHERE r.id = ?`);

  function setColumn(column: string, id: number, value: string | number | null): void {
    // `column` is one of the literals passed below, never caller input.
    const result = db.prepare<[string | number | null, number]>(`UPDATE repos SET ${column} = ? WHERE id = ?`).run(value, id);
    if (result.changes === 0) throw new Error(`repo ${String(id)} not found`);
  }

  const upsert = (input: RepoInput): { repo: RepoRecord; created: boolean } => {
    const existing = byCommonDir.get(input.gitCommonDir);
    if (existing !== undefined) {
      const row = refresh.get(input.path, input.name, existing.id);
      if (row === undefined) throw new Error(`repo ${String(existing.id)} not found`);
      return { repo: toRecord(row), created: false };
    }
    const seenAt = isoTime(input.seenAt, 'seenAt');
    const row = insert.get(input.path, input.gitCommonDir, input.name, input.active ? 1 : 0, seenAt, seenAt);
    if (row === undefined) throw new Error(`repo ${input.gitCommonDir} was not inserted`);
    return { repo: toRecord(row), created: true };
  };

  return {
    upsert: (input) => db.transaction(() => upsert(input), { immediate: true }),
    get: (id) => {
      const row = byId.get(id);
      return row === undefined ? null : toRecord(row);
    },
    getByGitCommonDir: (gitCommonDir) => {
      const row = byCommonDir.get(gitCommonDir);
      return row === undefined ? null : toRecord(row);
    },
    list: () => all.all().map(toRecord),
    setActive: (id, active) => {
      setColumn('active', id, active ? 1 : 0);
    },
    touchSeen: (id, at) => {
      setColumn('lastSeenAt', id, isoTime(at, 'lastSeenAt'));
    },
    setBase: (id, base) => {
      setColumn('base', id, base);
    },
    setTier1Paths: (id, tier1Paths) => {
      setColumn('tier1Paths', id, jsonOrNull(tier1Paths));
    },
    setCollectError: (id, error) => {
      setColumn('collectError', id, error);
    },
    listSummaries: (runtime = defaultRuntime) =>
      summaries
        .all()
        .map((row) => toSummary(row, runtime))
        .sort(compareSummaries),
    getSummary: (id, runtime = defaultRuntime) => {
      const row = summaryById.get(id);
      return row === undefined ? null : toSummary(row, runtime);
    },
  };
}
