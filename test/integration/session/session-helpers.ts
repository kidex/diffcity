// Shared setup for the session integration tests (ADR-038): an in-process
// daemon with the collection and the API, a temporary Claude config directory
// holding invented transcripts, and a logger the tests can read. Nothing here
// touches the user's real Claude configuration or diffcity home.

import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db, SessionRecord } from '../../../src/core/db/index.js';
import type { SocketRequest, TrackSession } from '../../../src/core/model/types.js';
import { subagentsDir } from '../../../src/core/session/index.js';
import { sendRequest } from '../../../src/daemon/client.js';
import type { Logger } from '../../../src/daemon/log.js';
import { waitFor } from '../../helpers/daemon.js';
import { agentMeta, type TranscriptBuilder } from '../../helpers/transcript.js';
import { ghNotInstalled, startTestDaemon, type TestDaemon } from '../collect/collect-helpers.js';

/** A delay short enough for tests, long enough to see the schedule. */
export const TEST_DELAY_MS = 40;

export const AT = '2026-09-01T12:00:00.000Z';

export function sessionId(n: number): string {
  return `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export interface MemoryLog extends Logger {
  readonly lines: string[];
}

export function memoryLog(): MemoryLog {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
    close: () => undefined,
  };
}

export interface ClaudeDir {
  /** The temporary Claude config directory. */
  dir: string;
  /** `<dir>/projects/-work-sample-shop`. */
  project: string;
  transcriptPath(id: string): string;
  write(id: string, main: TranscriptBuilder): Promise<string>;
  append(id: string, more: TranscriptBuilder): Promise<void>;
  sidechain(id: string, agentId: string, side: TranscriptBuilder, meta?: { agentType: string }): Promise<void>;
  cleanup(): Promise<void>;
}

export async function claudeDir(): Promise<ClaudeDir> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dc-claude-')));
  const project = join(dir, 'projects', '-work-sample-shop');
  await mkdir(project, { recursive: true });
  const transcriptPath = (id: string): string => join(project, `${id}.jsonl`);
  return {
    dir,
    project,
    transcriptPath,
    write: async (id, main) => {
      await writeFile(transcriptPath(id), main.jsonl());
      return transcriptPath(id);
    },
    append: (id, more) => appendFile(transcriptPath(id), more.jsonl()),
    sidechain: async (id, agentId, side, meta) => {
      const subagents = subagentsDir(transcriptPath(id));
      await mkdir(subagents, { recursive: true });
      await writeFile(join(subagents, `agent-${agentId}.jsonl`), side.jsonl());
      if (meta !== undefined) await writeFile(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify(agentMeta(meta)));
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export interface SessionDaemon {
  test: TestDaemon;
  db: Db;
  log: MemoryLog;
  /** `track --agent` as the CLI sends it, with a session. */
  hook(dir: string, session: TrackSession | Record<string, unknown>, at?: string): Promise<unknown>;
  /** Waits until the collections and the session reads are over. */
  settle(): Promise<void>;
  /** The stored row of a session, in whichever repo it is. */
  row(id: string): SessionRecord | null;
  /** Waits until the row of `id` satisfies `check`, then until nothing is pending. */
  until(id: string, check: (row: SessionRecord) => boolean, what?: string): Promise<SessionRecord>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
}

export async function sessionDaemon(claude: ClaudeDir): Promise<SessionDaemon> {
  const log = memoryLog();
  const test = await startTestDaemon({ gh: ghNotInstalled(), claudeConfigDir: claude.dir, sessionDelayMs: TEST_DELAY_MS }, { api: true, log });
  const db = test.collection.db();
  const row = (id: string): SessionRecord | null => {
    for (const repo of db.repos.list()) {
      const found = db.sessions.find(repo.id, id);
      if (found !== null) return found;
    }
    return null;
  };
  return {
    test,
    db,
    log,
    hook: (dir, session, at = AT) =>
      // The session is sent as given, valid or not: the daemon must validate it.
      sendRequest(test.daemon.info.socket, { v: 1, type: 'track', dir, agent: true, at, session } as SocketRequest),
    settle: async () => {
      await test.idle();
      // A hook stores its session after the collection: wait for the reads it scheduled.
      await new Promise((resolve) => setTimeout(resolve, TEST_DELAY_MS));
      await waitFor(() => (test.collection.sessions()?.pending ?? 0) === 0, 30_000, 'the session reads to finish');
      await test.idle();
    },
    row,
    until: async (id, check, what = `session ${id}`) => {
      const found = await waitFor(() => {
        const current = row(id);
        return current !== null && check(current) ? current : undefined;
      }, 30_000, what);
      await waitFor(() => (test.collection.sessions()?.pending ?? 0) === 0, 30_000, 'the session reads to finish');
      return row(id) ?? found;
    },
    get: (path, headers = {}) => fetch(`http://127.0.0.1:${String(test.daemon.info.port)}${path}`, { headers }),
  };
}
