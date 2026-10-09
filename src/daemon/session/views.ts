// The sessions of a change as served (ADR-038), for GET
// /api/changes/:id/sessions and the `sessions` socket request: the 20 newest
// linked sessions, their runs filtered to the change's working tree
// (src/core/session/view.ts). The repo's working trees are those its last
// collection listed (the listing the tracker links with), plus its main one
// and those its live changes are checked out in, for a repo not listed yet.

import type { Db } from '../../core/db/index.js';
import type { ChangeRecord, SessionsResponse } from '../../core/model/types.js';
import { SESSIONS_PER_CHANGE, sessionView } from '../../core/session/view.js';

export function sessionViewsOf(db: Db, change: ChangeRecord, listed: readonly string[] | null): SessionsResponse {
  const repo = db.repos.get(change.repoId);
  const trees = new Set<string>(listed ?? []);
  if (repo !== null) trees.add(repo.path);
  for (const live of db.changes.listLive(change.repoId)) if (live.worktreePath !== null) trees.add(live.worktreePath);
  const context = { changeTree: change.worktreePath, trees: [...trees] };
  const sessions = db.sessions.forChange(change.id, SESSIONS_PER_CHANGE).map(({ session, link }) =>
    sessionView(
      {
        sessionId: session.sessionId,
        title: session.title,
        firstAt: session.firstAt,
        lastAt: session.lastAt,
        cwd: session.cwd,
        digest: session.digest,
        parseError: session.parseError,
        firstHead: link.firstHead,
        lastHead: link.lastHead,
        linkedAt: link.linkedAt,
      },
      context,
    ),
  );
  return { sessions, total: db.sessions.countForChange(change.id) };
}
