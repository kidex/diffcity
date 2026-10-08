// The ADR-038 read schedule of the session tracker, with a stub job: a read
// one delay after the hook, one more if the transcript had grown, one per later
// hook, never two at once for a session; failures stored as a code only.

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionJob, SessionJobResult } from '../../../src/core/session/index.js';
import { createPool } from '../../../src/daemon/collector/pool.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import { createSessionTracker, type SessionTracker } from '../../../src/daemon/session/tracker.js';
import { waitFor } from '../../helpers/daemon.js';
import { T0, addRepo, tempDb, type TempDb } from '../db/db-helpers.js';

const DELAY = 30;
const ID = '0a1b2c3d-0000-4000-8000-000000000001';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Harness {
  temp: TempDb;
  tracker: SessionTracker;
  jobs: SessionJob[];
  repoId: number;
  hook(at?: string): Promise<void>;
}

function harness(answer: (job: SessionJob, index: number) => Promise<SessionJobResult> | SessionJobResult): Harness {
  const temp = tempDb();
  const repo = addRepo(temp.db);
  const jobs: SessionJob[] = [];
  const pool = createPool<SessionJob, SessionJobResult>({
    runner: { kind: 'inline', compute: async (job) => { jobs.push(job); return answer(job, jobs.length - 1); } },
    size: 1,
  });
  const tracker = createSessionTracker({
    db: temp.db,
    pool,
    log: createStreamLogger(new PassThrough()),
    projectsDir: '/claude/projects',
    worktreeOf: () => null,
    delayMs: DELAY,
  });
  cleanups.push(() => { temp.cleanup(); }, () => tracker.close());
  return {
    temp,
    tracker,
    jobs,
    repoId: repo.id,
    hook: (at = T0) => tracker.hook(repo.id, { sessionId: ID, transcriptPath: `/claude/projects/p/${ID}.jsonl`, cwd: '/work/sample-shop', event: 'Stop' }, at),
  };
}

const done = (parsedBytes: number, grew: boolean, digest = `{"n":${String(parsedBytes)}}`): SessionJobResult => ({
  ok: true,
  digest,
  parsedBytes,
  title: 'A title',
  firstAt: T0,
  lastAt: T0,
  grew,
  runDirs: [],
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('session tracker schedule', () => {
  it('reads one delay after the hook, from the stored digest, and mirrors the main cursor', async () => {
    const h = harness((_job, index) => done(100 * (index + 1), false));
    await h.hook();
    expect(h.jobs).toHaveLength(0);
    await waitFor(() => h.tracker.pending === 0 && h.jobs.length === 1, 5000);
    expect(h.jobs[0]).toMatchObject({ sessionId: ID, previous: null, active: true, projectsDir: '/claude/projects' });
    const row = h.temp.db.sessions.find(h.repoId, ID);
    expect(row).toMatchObject({ parsedBytes: 100, digest: '{"n":100}', title: 'A title' });

    await h.hook('2026-09-01T11:00:00.000Z');
    await waitFor(() => h.tracker.pending === 0 && h.jobs.length === 2, 5000);
    expect(h.jobs[1]?.previous).toBe('{"n":100}');
  });

  it('reads once more when the transcript grew past the first read, and no more', async () => {
    const h = harness(() => done(10, true));
    await h.hook();
    await waitFor(() => h.jobs.length === 2 && h.tracker.pending === 0, 5000);
    await sleep(DELAY * 4);
    expect(h.jobs).toHaveLength(2);
  });

  it('a hook during a read gives exactly one more read after it; hooks before the delay coalesce', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(async (_job, index) => {
      if (index === 0) await gate;
      return done(10 * (index + 1), false);
    });
    await h.hook();
    await h.hook();
    await waitFor(() => h.jobs.length === 1, 5000);
    await h.hook();
    await h.hook();
    release();
    await waitFor(() => h.jobs.length === 2 && h.tracker.pending === 0, 5000);
    await sleep(DELAY * 4);
    expect(h.jobs).toHaveLength(2);
  });

  it('a refused or failed read stores a code, never the message', async () => {
    const h = harness((_job, index) => {
      if (index === 0) return { ok: false, code: 'outside-projects' };
      throw new Error('ENOENT: /claude/projects/p/secret-path.jsonl');
    });
    await h.hook();
    await waitFor(() => h.jobs.length === 1 && h.tracker.pending === 0, 5000);
    expect(h.temp.db.sessions.find(h.repoId, ID)?.parseError).toBe('outside-projects');
    await h.hook();
    await waitFor(() => h.jobs.length === 2 && h.tracker.pending === 0, 5000);
    expect(h.temp.db.sessions.find(h.repoId, ID)?.parseError).toBe('read-failed');
  });

  it('SessionEnd reads the session as no longer active', async () => {
    const h = harness(() => done(10, false));
    await h.tracker.hook(h.repoId, { sessionId: ID, transcriptPath: `/claude/projects/p/${ID}.jsonl`, cwd: '/work/sample-shop', event: 'SessionEnd' }, T0);
    await waitFor(() => h.jobs.length === 1, 5000);
    expect(h.jobs[0]?.active).toBe(false);
  });

  it('close cancels a scheduled read', async () => {
    const h = harness(() => done(10, false));
    await h.hook();
    await h.tracker.close();
    await sleep(DELAY * 3);
    expect(h.jobs).toHaveLength(0);
  });
});
