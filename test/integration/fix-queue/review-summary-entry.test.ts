// The fallback channel of "send review to the agent" (ADR-029): "Add to fix
// queue" writes the review summary as one `review-summary` item of the change's
// fix queue, for /diffcity-review. Nothing is executed, and agent launch need
// not be enabled.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasFixQueue, readFixQueue } from '../../helpers/fix-queue.js';
import { createToolStubs, type ToolStubs } from '../../helpers/tool-stub.js';
import { REWRITE_NOTE, preview, seedChange, startAgentDaemon, type AgentDaemon } from '../agent/agent-helpers.js';

let stubs: ToolStubs;
let test: AgentDaemon;

beforeAll(async () => {
  stubs = await createToolStubs(['claude'], { stdin: true });
});

afterAll(async () => {
  await stubs.cleanup();
});

beforeEach(async () => {
  test = await startAgentDaemon({ stubs });
});

afterEach(async () => {
  await test.close();
});

const queue = (changeId: number, body: unknown, headers?: Record<string, string>) => test.post(`/api/changes/${String(changeId)}/review/summary/queue`, body, headers);

describe('review summary to the fix queue', () => {
  it('fix-queue/review-summary-entry: the summary shown becomes one item, once; nothing runs', async () => {
    const change = seedChange(test);
    const shown = await preview(test, change.id);
    // Agent launch is off (no settings), which does not matter here.
    expect(shown.refusals.map((refusal) => refusal.code)).toEqual(['agent-launch-disabled']);

    const first = await queue(change.id, { summaryHash: shown.summaryHash });
    expect(first.status).toBe(200);
    const answer = first.json() as { key: string; queued: boolean; count: number };
    expect(answer).toMatchObject({ queued: true, count: 1 });
    const items = readFixQueue(test.repoDir);
    expect(items).toEqual([{ kind: 'review-summary', key: answer.key, message: shown.summary, queuedAt: expect.any(String) as unknown }]);
    expect(shown.summary).toContain(REWRITE_NOTE);

    const again = await queue(change.id, { summaryHash: shown.summaryHash });
    expect(again.json()).toMatchObject({ key: answer.key, queued: false, count: 1 });
    expect(await stubs.records()).toEqual([]);
  });

  it('a general note alone, or a "Needs rewrite" mark with no note, is queued; nothing-to-send needs both empty', async () => {
    const noteOnly = seedChange(test, { name: 'note-only', rewrite: false, note: 'Split the cart module before merging.' });
    const shownNote = await preview(test, noteOnly.id);
    const queued = await queue(noteOnly.id, { summaryHash: shownNote.summaryHash });
    expect(queued.status).toBe(200);
    expect(queued.json()).toMatchObject({ queued: true, count: 1 });
    expect(readFixQueue(test.repoDir).map((item) => item.message)).toEqual([shownNote.summary]);
    expect(shownNote.summary).toContain('> Split the cart module before merging.');

    const bare = seedChange(test, { name: 'bare-rewrite', rewriteNote: null, worktreePath: test.repoDir });
    const shownBare = await preview(test, bare.id);
    expect(shownBare.summary).toContain('- Rewrite `total`');
    expect((await queue(bare.id, { summaryHash: shownBare.summaryHash })).status).toBe(200);
  });

  it('refuses a summary that changed, nothing to send, an archived change, no working tree and a cross-site request', async () => {
    const change = seedChange(test);
    const shown = await preview(test, change.id);
    test.db.review.setNote(change.id, 'Also split the module.', '2026-09-01T11:00:00.000Z');
    expect((await queue(change.id, { summaryHash: shown.summaryHash })).json()).toMatchObject({ error: { code: 'summary-changed' } });
    expect((await queue(change.id, {})).status).toBe(400);

    const empty = seedChange(test, { name: 'empty', rewrite: false });
    expect((await queue(empty.id, { summaryHash: (await preview(test, empty.id)).summaryHash })).json()).toMatchObject({ error: { code: 'nothing-to-send' } });

    const archived = seedChange(test, { name: 'archived', archived: true });
    expect((await queue(archived.id, { summaryHash: (await preview(test, archived.id)).summaryHash })).json()).toMatchObject({ error: { code: 'archived' } });

    const nowhere = seedChange(test, { name: 'nowhere', worktreePath: null });
    expect((await queue(nowhere.id, { summaryHash: (await preview(test, nowhere.id)).summaryHash })).json()).toMatchObject({ error: { code: 'no-working-tree' } });

    const fresh = await preview(test, change.id);
    const cross = await queue(change.id, { summaryHash: fresh.summaryHash }, { origin: 'http://evil.invalid', 'content-type': 'application/json' });
    expect(cross.status).toBe(403);
    expect(hasFixQueue(test.repoDir)).toBe(false);
  });
});
