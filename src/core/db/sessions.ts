// The sessions tables (ADR-038, schema v4): the Claude Code sessions that
// `track --agent` reported, their digests, and the changes they are linked to.
// Written only by the daemon's main thread. The digest column holds the
// serialized SessionDigest; its `state` holds every file cursor and is the
// source of truth for them. `parsedBytes` mirrors the main transcript's cursor.

import type { Connection } from './driver.js';
import { isoTime } from './time.js';

/** A row of `sessions`. */
export interface SessionRecord {
  id: number;
  repoId: number;
  /** Claude Code's session id, validated by the daemon before the row is written. */
  sessionId: string;
  /** The realpath of the transcript, under the Claude Code projects directory. */
  transcriptPath: string;
  /** The directory the session ran in, as the hook reported it. */
  cwd: string;
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
  /** The serialized SessionDigest; null until the first read. */
  digest: string | null;
  parsedBytes: number;
  /** A refusal or read failure code; never the content or the path. */
  parseError: string | null;
}

/** A row of `change_sessions`. */
export interface SessionLink {
  changeId: number;
  sessionRowId: number;
  /** The change's head when the session was first linked to it. */
  firstHead: string | null;
  /** The change's head at the latest link. */
  lastHead: string | null;
  linkedAt: string;
}

export interface SessionSighting {
  repoId: number;
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  /** The hook's time: the first and last time of a session not read yet. */
  at: string;
}

export interface SessionDigestWrite {
  digest: string;
  parsedBytes: number;
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
}

export interface SessionStore {
  /** Records a session reported by a hook: inserted, or its path and cwd updated. */
  see(sighting: SessionSighting): SessionRecord;
  get(id: number): SessionRecord | null;
  find(repoId: number, sessionId: string): SessionRecord | null;
  /** Stores a digest read; clears parseError. */
  storeDigest(id: number, write: SessionDigestWrite): void;
  /** Records why the session could not be read: a code, never content. */
  setParseError(id: number, code: string): void;
  /** Links the session to a change at `head`: firstHead on the first link, lastHead always. */
  link(changeId: number, sessionRowId: number, head: string | null, at: string): void;
  /** The changes a session is linked to, in link order. */
  links(sessionRowId: number): SessionLink[];
  /** The sessions linked to a change, newest first (by their last activity), at most `limit`. */
  forChange(changeId: number, limit: number): { session: SessionRecord; link: SessionLink }[];
}

interface JoinedRow extends SessionRecord {
  changeId: number;
  sessionRowId: number;
  firstHead: string | null;
  lastHead: string | null;
  linkedAt: string;
}

function toSession(row: SessionRecord): SessionRecord {
  return {
    id: row.id,
    repoId: row.repoId,
    sessionId: row.sessionId,
    transcriptPath: row.transcriptPath,
    cwd: row.cwd,
    title: row.title,
    firstAt: row.firstAt,
    lastAt: row.lastAt,
    digest: row.digest,
    parsedBytes: row.parsedBytes,
    parseError: row.parseError,
  };
}

function toLink(row: SessionLink): SessionLink {
  return { changeId: row.changeId, sessionRowId: row.sessionRowId, firstHead: row.firstHead, lastHead: row.lastHead, linkedAt: row.linkedAt };
}

const optionalTime = (value: string | null, field: string): string | null => (value === null ? null : isoTime(value, field));

export function createSessionStore(db: Connection): SessionStore {
  const upsert = db.prepare<[number, string, string, string, string, string], SessionRecord>(
    `INSERT INTO sessions (repoId, sessionId, transcriptPath, cwd, firstAt, lastAt) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (repoId, sessionId) DO UPDATE SET transcriptPath = excluded.transcriptPath, cwd = excluded.cwd
     RETURNING *`,
  );
  const byId = db.prepare<[number], SessionRecord>('SELECT * FROM sessions WHERE id = ?');
  const byKey = db.prepare<[number, string], SessionRecord>('SELECT * FROM sessions WHERE repoId = ? AND sessionId = ?');
  const digest = db.prepare<[string, number, string | null, string | null, string | null, number]>(
    'UPDATE sessions SET digest = ?, parsedBytes = ?, title = ?, firstAt = coalesce(?, firstAt), lastAt = coalesce(?, lastAt), parseError = NULL WHERE id = ?',
  );
  const parseError = db.prepare<[string, number]>('UPDATE sessions SET parseError = ? WHERE id = ?');
  const link = db.prepare<[number, number, string | null, string | null, string]>(
    `INSERT INTO change_sessions (changeId, sessionRowId, firstHead, lastHead, linkedAt) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (changeId, sessionRowId) DO UPDATE SET lastHead = excluded.lastHead, linkedAt = excluded.linkedAt`,
  );
  const links = db.prepare<[number], SessionLink>('SELECT * FROM change_sessions WHERE sessionRowId = ? ORDER BY rowid');
  const forChange = db.prepare<[number, number], JoinedRow>(
    `SELECT s.*, l.changeId, l.sessionRowId, l.firstHead, l.lastHead, l.linkedAt
     FROM change_sessions l JOIN sessions s ON s.id = l.sessionRowId
     WHERE l.changeId = ?
     ORDER BY coalesce(s.lastAt, l.linkedAt) DESC, s.id DESC LIMIT ?`,
  );

  return {
    see: (sighting) => {
      const at = isoTime(sighting.at, 'at');
      const row = upsert.get(sighting.repoId, sighting.sessionId, sighting.transcriptPath, sighting.cwd, at, at);
      if (row === undefined) throw new Error(`session of repo ${String(sighting.repoId)} was not stored`);
      return toSession(row);
    },
    get: (id) => {
      const row = byId.get(id);
      return row === undefined ? null : toSession(row);
    },
    find: (repoId, sessionId) => {
      const row = byKey.get(repoId, sessionId);
      return row === undefined ? null : toSession(row);
    },
    storeDigest: (id, write) => {
      digest.run(write.digest, write.parsedBytes, write.title, optionalTime(write.firstAt, 'firstAt'), optionalTime(write.lastAt, 'lastAt'), id);
    },
    setParseError: (id, code) => {
      parseError.run(code, id);
    },
    link: (changeId, sessionRowId, head, at) => {
      link.run(changeId, sessionRowId, head, head, isoTime(at, 'linkedAt'));
    },
    links: (sessionRowId) => links.all(sessionRowId).map(toLink),
    forChange: (changeId, limit) => forChange.all(changeId, limit).map((row) => ({ session: toSession(row), link: toLink(row) })),
  };
}
