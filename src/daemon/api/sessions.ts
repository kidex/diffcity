// GET /api/changes/:id/sessions (ADR-038): the Claude Code sessions linked to
// a change, outside the Report (ADR-002). They hold the user's prompts and
// agent reports, so the code-bearing GET rules apply (ADR-027): a cross-site
// browser request is refused (403), on top of the Host check, and nothing of
// a session goes into a log line.

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../core/db/index.js';
import type { SessionsResponse } from '../../core/model/types.js';
import { HttpError } from '../http/errors.js';
import { sessionViewsOf } from '../session/views.js';
import { isSameOrigin } from './origin.js';
import { parseId } from './params.js';

export interface SessionsRouteDeps {
  db: Db;
  /** The daemon's HTTP port, read per request. */
  port: () => number;
}

export function registerSessionsRoute(http: FastifyInstance, deps: SessionsRouteDeps): void {
  http.get<{ Params: { id: string } }>('/api/changes/:id/sessions', (request, reply): SessionsResponse => {
    reply.header('cache-control', 'no-store');
    if (!isSameOrigin(request, deps.port())) {
      throw new HttpError(403, 'forbidden', 'sessions are for the daemon page only');
    }
    const id = parseId('id', request.params.id);
    const change = deps.db.changes.get(id);
    if (change === null) throw new HttpError(404, 'not-found', `change ${String(id)} not found`);
    return { sessions: sessionViewsOf(deps.db, change) };
  });
}
