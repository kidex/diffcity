// The sessions of a change as served (ADR-038), for GET
// /api/changes/:id/sessions and the `sessions` socket request: the 20 newest
// linked sessions, their runs filtered to the change's working tree
// (src/core/session/view.ts). The repo's working trees are its main one and
// those its live changes are checked out in.

import type { Db } from '../../core/db/index.js';
import type { ChangeRecord, SessionView } from '../../core/model/types.js';
import { SESSIONS_PER_CHANGE, sessionView } from '../../core/session/view.js';

export function sessionViewsOf(db: Db, change: ChangeRecord): SessionView[] {
  const repo = db.repos.get(change.repoId);
  const trees = new Set<string>(repo === null ? [] : [repo.path]);
  for (const live of db.changes.listLive(change.repoId)) if (live.worktreePath !== null) trees.add(live.worktreePath);
  const context = { changeTree: change.worktreePath, trees: [...trees] };
  return db.sessions.forChange(change.id, SESSIONS_PER_CHANGE).map(({ session, link }) =>
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
}
