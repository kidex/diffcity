// A SessionEnd hook only ends its session (DC-128): the session reads as no
// longer active and its runs with no outcome as `unknown`, while the change's
// agent and review state, its events and the collections stay as they were.
// Invented repos and transcripts under temporary directories.

import { realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionsResponse } from '../../../src/core/model/types.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { transcript } from '../../helpers/transcript.js';
import { cleanupAfterEach, sampleRepo } from '../collect/collect-helpers.js';
import { claudeDir, sessionDaemon, sessionId, type ClaudeDir } from './session-helpers.js';

cleanupAfterEach();

const claudes: ClaudeDir[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const claude of claudes.splice(0)) await claude.cleanup();
});

describe('a SessionEnd hook', () => {
  it('session/session-end-only-ends: with no Stop before it, the change keeps its agent and review state and no collection runs; the session reads as ended', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/cart');
    await repo.commit('count the cart', { 'src/cart/count.ts': 'export const count = (items: number[]): number => items.length;\n' });
    const dir = await realpath(repo.dir);
    const claude = await claudeDir();
    claudes.push(claude);
    const daemon = await sessionDaemon(claude);

    // The shell hook tracked the repo: it is collected, the change is there, no agent worked on it.
    await sendRequest(daemon.test.daemon.info.socket, { v: 1, type: 'track', dir, agent: false, at: '2026-09-01T11:00:00.000Z' });
    await daemon.settle();
    const repoRecord = daemon.db.repos.list()[0];
    if (repoRecord === undefined) throw new Error('the repo was not registered');
    const change = daemon.db.changes.listLive(repoRecord.id).find((candidate) => candidate.ref === 'branch:feature/cart');
    if (change === undefined) throw new Error('no change for feature/cart');
    const eventsBefore = daemon.db.events.listForRepo(repoRecord.id);
    const seenBefore = daemon.db.repos.list()[0];

    const id = sessionId(128);
    const main = transcript({ sessionId: id, cwd: dir }).prompt('Clear right away');
    main.agent({ agentId: 'bgnone', type: 'dev' });
    await claude.write(id, main);
    const collect = vi.spyOn(daemon.test.collection.collector(), 'request');
    const mark = vi.spyOn(daemon.test.collection.collector(), 'markAgent');

    await daemon.hook(dir, { sessionId: id, transcriptPath: claude.transcriptPath(id), cwd: dir, event: 'SessionEnd' }, '2026-09-01T12:00:00.000Z');
    await daemon.until(id, (row) => row.digest !== null);
    await daemon.settle();

    expect(collect).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    const after = daemon.db.changes.get(change.id);
    expect(after).toMatchObject({ reviewState: change.reviewState, lastEventType: change.lastEventType, lastEventAt: change.lastEventAt });
    expect(after?.lastEventType).not.toBe('agent');
    expect(daemon.db.events.listForRepo(repoRecord.id)).toEqual(eventsBefore);
    expect(daemon.db.repos.list()[0]).toEqual(seenBefore);

    const response = await daemon.get(`/api/changes/${String(change.id)}/sessions`);
    const { sessions } = (await response.json()) as SessionsResponse;
    expect(sessions.map((session) => [session.sessionId, session.active])).toEqual([[id, false]]);
    expect(sessions[0]?.digest?.runs.map((run) => [run.agentId, run.status])).toEqual([['bgnone', 'unknown']]);
  });

  it('session/session-end-unknown-repo: in a repo diffcity does not know, it registers nothing and answers with the reason', async () => {
    const repo = await sampleRepo();
    const dir = await realpath(repo.dir);
    const claude = await claudeDir();
    claudes.push(claude);
    const daemon = await sessionDaemon(claude);
    const id = sessionId(129);
    await claude.write(id, transcript({ sessionId: id, cwd: dir }).prompt('Never stopped'));

    const answer = await daemon.hook(dir, { sessionId: id, transcriptPath: claude.transcriptPath(id), cwd: dir, event: 'SessionEnd' });
    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining('is not tracked') as unknown });
    await daemon.settle();
    expect(daemon.db.repos.list()).toEqual([]);
    expect(daemon.row(id)).toBeNull();
  });
});
