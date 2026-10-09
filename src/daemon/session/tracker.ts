// The sessions `track --agent` reports (ADR-038): stored, linked to changes,
// and read in the session pool on the ADR-038 schedule.
//
// - A hook (an already validated session, validate.ts) stores or updates the
//   session row and links it to the change of the working tree its cwd is in.
// - The transcript is read SESSION_READ_DELAY_MS after the hook, once more
//   (after the same delay) if it had grown past what that read took, and again
//   on every later hook. Reads of one session never overlap: a hook during a
//   read schedules one more read after it.
// - Each read resumes from the stored digest: its `state` holds every file's
//   cursor and is the source of truth; `sessions.parsedBytes` mirrors the main
//   one. The worker checks the transcript path again before it reads.
// - After a read, the session is also linked to the change of each working
//   tree its runs worked in, so a session whose subagents work in linked
//   worktrees reaches each of their changes.
// - After each stored read, SSE `sessions` with `{ changeId }` goes out for
//   every change the session is linked to; it carries no session content.
//
// Failures and refusals are logged with the session row id and a code, never a
// path or transcript content, and stored as `parseError`.

import { realpath } from 'node:fs/promises';
import { changeOfWorktree, type WorktreeInfo } from '../../core/changes/index.js';
import type { Db } from '../../core/db/index.js';
import type { SseEvent } from '../../core/model/types.js';
import type { SessionJob } from '../../core/session/job.js';
import type { ValidatedSession } from '../../core/session/validate.js';
import { errorMessage, type Logger } from '../log.js';
import type { SessionPool } from './pool.js';

/** The delay between a hook and the read of its transcript (ADR-038). */
export const SESSION_READ_DELAY_MS = 1500;

export interface SessionTrackerOptions {
  db: Db;
  pool: SessionPool;
  log: Logger;
  /** `<claude config dir>/projects`: the only place a transcript is read from. */
  projectsDir: string;
  /** The working tree containing a realpath, as the repo's last collection listed it. */
  worktreeOf: (repoId: number, dir: string) => WorktreeInfo | null;
  /** Defaults to SESSION_READ_DELAY_MS. */
  delayMs?: number;
  now?: () => Date;
  /** The home the redactor replaces by `~`; os.homedir() when absent. */
  home?: string | null;
  /** Sends an SSE signal; a no-op when absent. */
  broadcast?: (event: SseEvent) => void;
}

export interface SessionTracker {
  /** A hook reported `session` for the repo at `at`: store, link, and schedule a read. */
  hook(repoId: number, session: ValidatedSession, at: string): Promise<void>;
  /**
   * The socket-time validation refused `transcriptPath` for this session: the
   * stored row takes `code` (and its changes get SSE `sessions`) only when it
   * exists in the repo with exactly that transcript path. Returns whether a row was marked.
   */
  refused(repoId: number, sessionId: string, transcriptPath: string, code: string): boolean;
  /** Sessions with a read scheduled or running. */
  readonly pending: number;
  /** Cancels scheduled reads, waits for running ones and stops the pool. */
  close(): Promise<void>;
}

interface ReadState {
  timer: NodeJS.Timeout | null;
  running: boolean;
  /** A hook arrived while a read ran: read once more after it. */
  again: boolean;
  /** The next read checks whether the transcript grew past it (the first read after a hook). */
  checkGrowth: boolean;
  active: boolean;
  repoId: number;
}

export function createSessionTracker(options: SessionTrackerOptions): SessionTracker {
  const { db, pool, log } = options;
  const delayMs = options.delayMs ?? SESSION_READ_DELAY_MS;
  const now = options.now ?? ((): Date => new Date());
  const states = new Map<number, ReadState>();
  const reads = new Set<Promise<void>>();
  let closed = false;
  /** Read through a function: the flag changes while a read awaits. */
  const isClosed = (): boolean => closed;

  /** Links the session to the change checked out in the working tree containing `dir`, if any. */
  function linkDir(repoId: number, rowId: number, dir: string): void {
    const tree = options.worktreeOf(repoId, dir);
    if (tree === null) return;
    const change = changeOfWorktree(db.changes.listLive(repoId), tree);
    if (change === null) return;
    db.sessions.link(change.id, rowId, change.head, now().toISOString());
  }

  function schedule(rowId: number, state: ReadState): void {
    if (closed) return;
    if (state.running) {
      state.again = true;
      return;
    }
    if (state.timer !== null) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      const done = read(rowId, state).finally(() => {
        reads.delete(done);
      });
      reads.add(done);
    }, delayMs);
  }

  async function read(rowId: number, state: ReadState): Promise<void> {
    state.running = true;
    const checkGrowth = state.checkGrowth;
    state.checkGrowth = false;
    let grew = false;
    try {
      const row = db.sessions.get(rowId);
      if (row === null || closed) return;
      const tree = options.worktreeOf(state.repoId, row.cwd);
      const job: SessionJob = {
        sessionId: row.sessionId,
        transcriptPath: row.transcriptPath,
        projectsDir: options.projectsDir,
        previous: row.digest,
        repoRoot: tree?.path ?? db.repos.get(state.repoId)?.path ?? null,
        active: state.active,
        ...(options.home === undefined ? {} : { home: options.home }),
      };
      const result = await pool.submit(`session:${String(rowId)}`, 'normal', job);
      if (isClosed()) return;
      if (!result.ok) {
        db.sessions.setParseError(rowId, result.code);
        log.warn(`session ${String(rowId)}: not read: ${result.code}`);
        return;
      }
      const linked = db.transaction(() => {
        db.sessions.storeDigest(rowId, result);
        for (const dir of result.runDirs) linkDir(state.repoId, rowId, dir);
        return db.sessions.links(rowId);
      });
      for (const link of linked) options.broadcast?.({ event: 'sessions', data: { changeId: link.changeId } });
      grew = result.grew;
    } catch (error) {
      if (isClosed()) return;
      // The pool's message may name a file: only a code goes to the log and the row.
      db.sessions.setParseError(rowId, 'read-failed');
      log.warn(`session ${String(rowId)}: not read: read-failed${error instanceof Error && error.message.includes('timed out') ? ' (timeout)' : ''}`);
    } finally {
      state.running = false;
      if (state.again) {
        state.again = false;
        state.checkGrowth = true;
        schedule(rowId, state);
      } else if (checkGrowth && grew) {
        schedule(rowId, state);
      } else if (state.timer === null) {
        states.delete(rowId);
      }
    }
  }

  return {
    async hook(repoId, session, at) {
      if (closed) return;
      const cwd = await realpath(session.cwd).catch(() => session.cwd);
      const row = db.sessions.see({ repoId, sessionId: session.sessionId, transcriptPath: session.transcriptPath, cwd, at });
      try {
        linkDir(repoId, row.id, cwd);
      } catch (error) {
        log.error(`session ${String(row.id)}: link failed: ${errorMessage(error)}`);
      }
      const state = states.get(row.id) ?? { timer: null, running: false, again: false, checkGrowth: false, active: true, repoId };
      states.set(row.id, state);
      state.repoId = repoId;
      state.active = session.event !== 'SessionEnd';
      state.checkGrowth = true;
      schedule(row.id, state);
    },
    refused(repoId, sessionId, transcriptPath, code) {
      if (closed) return false;
      const row = db.sessions.find(repoId, sessionId);
      if (row?.transcriptPath !== transcriptPath) return false;
      db.sessions.setParseError(row.id, code);
      for (const link of db.sessions.links(row.id)) options.broadcast?.({ event: 'sessions', data: { changeId: link.changeId } });
      return true;
    },
    get pending() {
      return states.size;
    },
    async close() {
      closed = true;
      for (const state of states.values()) {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
      }
      await Promise.allSettled([...reads]);
      states.clear();
      await pool.shutdown();
    },
  };
}
