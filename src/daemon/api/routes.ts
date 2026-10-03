// The JSON API of phase 2 (ADR-017): repos, changes, the latest report and
// search. Every answer is read from src/core (the db stores and core search);
// these handlers only validate, look up and send.

import type { FastifyInstance } from 'fastify';
import type { Db, RepoRuntimeLookup } from '../../core/db/index.js';
import type { ChangeSummary, RepoDetail, RepoSummary, SearchResult, SseEvent } from '../../core/model/types.js';
import { search } from '../../core/search/index.js';
import { HttpError } from '../http/errors.js';
import { isSameOrigin } from './origin.js';
import { registerReviewRoutes } from './review.js';
import { parseArchived, parseId, parseLimit, parseSearchQuery, type Query } from './params.js';

export interface ApiDeps {
  db: Db;
  /** The daemon's HTTP port, read per request: the own origin is `http://127.0.0.1:<port>` or `http://localhost:<port>`. */
  port: () => number;
  /** Daemon state merged into each RepoSummary (collecting, watch); the store default when absent. */
  runtime?: RepoRuntimeLookup;
  /**
   * A repo opened in the UI (Q6): seen now, so its 7-day window moves forward,
   * and an inactive repo is active again (watchers and PR polling start). The
   * daemon's collection plugin does it (src/daemon/activation.ts).
   */
  open: (repoId: number) => void;
  /** Sends an SSE signal; the review writes emit `review` and `changes` (ADR-028). A no-op when absent. */
  broadcast?: (event: SseEvent) => void;
  /** The clock of review writes; the system clock when absent. */
  now?: () => Date;
}

interface IdParams {
  id: string;
}

function notFound(what: 'repo' | 'change', id: number): HttpError {
  return new HttpError(404, 'not-found', `${what} ${String(id)} not found`);
}

/** Registers the /api routes on `http`. */
export function registerApiRoutes(http: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps;

  const repoSummary = (id: number): RepoSummary => {
    const summary = db.repos.getSummary(id, deps.runtime);
    if (summary === null) throw notFound('repo', id);
    return summary;
  };

  const changesOf = (repoId: number, archived: boolean): ChangeSummary[] =>
    archived ? db.changes.listArchivedSummaries(repoId) : db.changes.listLiveSummaries(repoId);

  http.get('/api/repos', (): RepoSummary[] => db.repos.listSummaries(deps.runtime));

  // Opening a repo in the UI counts as seeing it (ADR-020, Q6), like `track`:
  // it moves lastSeenAt forward on the daemon's clock, active or not, and
  // reactivates an inactive repo, but only for a GET from the daemon's own
  // origin: a HEAD or a cross-site request gets the same answer and writes
  // nothing. No SSE `repo` signal goes out for the touch: the UI
  // would refetch this route on it, and the refetch would signal again. A
  // reactivation signals once; the refetch finds the repo active.
  // Always the live changes (ADR-017); archived ones come from /api/repos/:id/changes?archived=1.
  http.get<{ Params: IdParams }>('/api/repos/:id', (request): RepoDetail => {
    const id = parseId('id', request.params.id);
    if (db.repos.get(id) === null) throw notFound('repo', id);
    if (request.method === 'GET' && isSameOrigin(request, deps.port())) {
      deps.open(id);
    }
    return { repo: repoSummary(id), changes: changesOf(id, false) };
  });

  http.get<{ Params: IdParams; Querystring: Query }>('/api/repos/:id/changes', (request): ChangeSummary[] => {
    const id = parseId('id', request.params.id);
    const archived = parseArchived(request.query);
    if (db.repos.get(id) === null) throw notFound('repo', id);
    return changesOf(id, archived);
  });

  http.get<{ Params: IdParams }>('/api/changes/:id', (request): ChangeSummary => {
    const id = parseId('id', request.params.id);
    const change = db.changes.getSummary(id);
    if (change === null) throw notFound('change', id);
    return change;
  });

  // The stored Report string is sent as it is (SPEC.md section 4.1), never
  // parsed and serialised again.
  http.get<{ Params: IdParams }>('/api/changes/:id/report', (request, reply) => {
    const id = parseId('id', request.params.id);
    if (db.changes.get(id) === null) throw notFound('change', id);
    const report = db.snapshots.latestReport(id);
    if (report === null) throw new HttpError(404, 'no-snapshot', `change ${String(id)} has no snapshot yet`);
    return reply.type('application/json; charset=utf-8').send(report);
  });

  http.get<{ Querystring: Query }>('/api/search', (request): SearchResult[] => {
    const q = parseSearchQuery(request.query);
    const limit = parseLimit(request.query);
    return search(db, q, limit);
  });

  registerReviewRoutes(http, { db, broadcast: deps.broadcast ?? (() => undefined), now: deps.now ?? (() => new Date()) });
}
