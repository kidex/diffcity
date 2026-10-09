// "Send review to the agent" over HTTP (ADR-029): the preview, the confirmed
// run and every refusal, checked at preview and again at run. A stub claude
// on a temporary PATH records its argv, cwd, stdin and environment; nothing
// here starts a real claude.

import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../helpers/daemon.js';
import { createToolStubs, type ToolStubs } from '../../helpers/tool-stub.js';
import {
  REWRITE_NOTE,
  SESSION,
  agentRunEvents,
  claudeResult,
  enabled,
  linkSession,
  preview,
  run,
  seedChange,
  startAgentDaemon,
  type AgentDaemon,
} from './agent-helpers.js';

let stubs: ToolStubs;
/** The stub claude's realpath: the argv shows the resolved binary. */
let claude: string;
let test: AgentDaemon;
let clock = Date.now();

beforeAll(async () => {
  stubs = await createToolStubs(['claude'], { stdin: true });
  await stubs.warm();
  claude = await realpath(stubs.path('claude'));
}, 120_000);

afterAll(async () => {
  await stubs.cleanup();
});

beforeEach(async () => {
  await stubs.clear();
  await stubs.mode('json', { stdout: claudeResult() });
  clock = Date.now();
  test = await startAgentDaemon({ stubs, plugin: { tokens: { now: () => clock } } });
});

afterEach(async () => {
  await test.close();
});

const codes = (refusals: { code: string }[]): string[] => refusals.map((refusal) => refusal.code);

describe('agent preview and run', () => {
  it('agent/preview-then-run: the previewed argv runs in the working tree with the summary on stdin', async () => {
    const change = seedChange(test);
    await linkSession(test, change);
    await test.settings(enabled(test, stubs, { permissionMode: 'acceptEdits' }));

    const shown = await preview(test, change.id);
    expect(shown.refusals).toEqual([]);
    expect(shown.mode).toBe('resume');
    expect(shown.sessionId).toBe(SESSION);
    expect(shown.cwd).toBe(test.repoDir);
    expect(shown.argv).toEqual([claude, '--resume', SESSION, '-p', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
    expect(shown.summary).toContain(REWRITE_NOTE);
    expect(shown.token).toEqual(expect.any(String));
    expect(await stubs.records()).toEqual([]);

    const started = await run(test, change.id, { token: shown.token, summaryHash: shown.summaryHash });
    expect(started.status).toBe(202);
    const { runId } = started.json() as { runId: string };
    await test.agent.runs().idle();

    const [record] = await stubs.records();
    expect(record?.argv).toEqual(shown.argv?.slice(1));
    expect(record?.cwd).toBe(test.repoDir);
    expect(record?.stdin).toBe(shown.summary);
    // The summary never goes in the argv.
    expect(record?.argv.join(' ')).not.toContain(REWRITE_NOTE);
    await waitFor(() => test.events().some((event) => event.event === 'agent-run' && event.data['state'] === 'done'), 10_000, 'the done signal');
    expect(test.events().filter((event) => event.event === 'agent-run').map((event) => event.data)).toEqual([
      { changeId: change.id, runId, state: 'running' },
      { changeId: change.id, runId, state: 'done' },
    ]);
  });

  it('a change with no usable session runs in new mode in the same tree, and the preview says why', async () => {
    const change = seedChange(test);
    await test.settings(enabled(test, stubs));
    let shown = await preview(test, change.id);
    expect(shown).toMatchObject({ mode: 'new', sessionId: null, newSessionReason: 'no-session-linked', cwd: test.repoDir });
    expect(shown.argv).toEqual([claude, '-p', '--output-format', 'json']);

    const elsewhere = join(test.scratch, 'other-tree');
    await mkdir(elsewhere);
    await linkSession(test, change, { cwd: elsewhere });
    shown = await preview(test, change.id);
    expect(shown).toMatchObject({ mode: 'new', newSessionReason: 'session-other-directory' });

    await linkSession(test, change, { sessionId: '22222222-2222-4333-8444-555555555555', at: '2026-09-01T12:00:00.000Z', transcript: false });
    shown = await preview(test, change.id);
    expect(shown).toMatchObject({ mode: 'new', newSessionReason: 'transcript-gone' });
  });

  it('agent/token-single-use: a token runs once', async () => {
    const change = seedChange(test);
    await test.settings(enabled(test, stubs));
    const shown = await preview(test, change.id);
    expect((await run(test, change.id, { token: shown.token, summaryHash: shown.summaryHash })).status).toBe(202);
    await test.agent.runs().idle();
    const again = await run(test, change.id, { token: shown.token, summaryHash: shown.summaryHash });
    expect(again.status).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'token-invalid' } });
    expect(await stubs.records()).toHaveLength(1);
  });

  it('agent/token-expired: a token is void after two minutes', async () => {
    const change = seedChange(test);
    await test.settings(enabled(test, stubs));
    const shown = await preview(test, change.id);
    clock += 2 * 60 * 1000;
    const late = await run(test, change.id, { token: shown.token, summaryHash: shown.summaryHash });
    expect(late.status).toBe(409);
    expect(late.json()).toMatchObject({ error: { code: 'token-invalid' } });
    expect(await stubs.records()).toEqual([]);
  });

  it('a token is bound to its change', async () => {
    const change = seedChange(test);
    const other = seedChange(test, { name: 'coupons' });
    await test.settings(enabled(test, stubs));
    const shown = await preview(test, change.id);
    const answer = await run(test, other.id, { token: shown.token, summaryHash: shown.summaryHash });
    expect(answer.json()).toMatchObject({ error: { code: 'token-invalid' } });
    expect(await stubs.records()).toEqual([]);
  });

  it('agent/summary-changed-refused: a summary edited since the preview, or a hash that is not the previewed one, is refused', async () => {
    const change = seedChange(test);
    await test.settings(enabled(test, stubs));
    let shown = await preview(test, change.id);
    test.db.review.setNote(change.id, 'Also rename the helper.', '2026-09-01T11:00:00.000Z');
    let answer = await run(test, change.id, { token: shown.token, summaryHash: shown.summaryHash });
    expect(answer.status).toBe(409);
    expect(answer.json()).toMatchObject({ error: { code: 'summary-changed' } });

    shown = await preview(test, change.id);
    answer = await run(test, change.id, { token: shown.token, summaryHash: '0'.repeat(64) });
    expect(answer.json()).toMatchObject({ error: { code: 'summary-changed' } });
    expect(await stubs.records()).toEqual([]);
  });

  it('agent/disabled-refused: off by default, and off when enabled is false; no token, nothing runs', async () => {
    const change = seedChange(test);
    let shown = await preview(test, change.id);
    expect(codes(shown.refusals)).toEqual(['agent-launch-disabled']);
    expect(shown.token).toBeNull();

    await test.settings(enabled(test, stubs, { enabled: false }));
    shown = await preview(test, change.id);
    expect(codes(shown.refusals)).toEqual(['agent-launch-disabled']);
    expect(shown.token).toBeNull();
    expect((await run(test, change.id, { token: 'x'.repeat(43), summaryHash: shown.summaryHash })).json()).toMatchObject({ error: { code: 'token-invalid' } });
    expect(await stubs.records()).toEqual([]);
  });

  it('agent/repo-not-listed-refused: only listed repos, compared after realpath', async () => {
    const change = seedChange(test);
    await test.settings(enabled(test, stubs, { repos: [join(test.scratch, 'other-shop')] }));
    expect(codes((await preview(test, change.id)).refusals)).toEqual(['agent-launch-disabled']);
    // A path that reaches the repo through `..` is the same repo once resolved.
    await test.settings(enabled(test, stubs, { repos: [join(test.scratch, 'claude', '..', 'sample-shop')] }));
    expect(codes((await preview(test, change.id)).refusals)).toEqual([]);
  });

  it('every refusal is checked again at run: disabled between preview and run', async () => {
    const change = seedChange(test);
    await test.settings(enabled(test, stubs));
    const shown = await preview(test, change.id);
    await test.settings(enabled(test, stubs, { enabled: false }));
    const answer = await run(test, change.id, { token: shown.token, summaryHash: shown.summaryHash });
    expect(answer.json()).toMatchObject({ error: { code: 'agent-launch-disabled' } });
    expect(await stubs.records()).toEqual([]);
  });

  it('a claude binary changed between preview and run is refused', async () => {
    const change = seedChange(test);
    await test.settings(enabled(test, stubs));
    const shown = await preview(test, change.id);
    const other = join(test.scratch, 'other-bin', 'claude');
    await mkdir(join(test.scratch, 'other-bin'));
    await writeFile(other, '#!/bin/sh\nexit 0\n');
    await chmod(other, 0o755);
    await test.settings(enabled(test, stubs, { claudePath: other }));
    const answer = await run(test, change.id, { token: shown.token, summaryHash: shown.summaryHash });
    expect(answer.status).toBe(409);
    expect(answer.json()).toMatchObject({ error: { code: 'token-invalid' } });
    expect(await stubs.records()).toEqual([]);
    expect(agentRunEvents(test)).toEqual([]);
  });

  it('a session linked between preview and run changes the argv: the token is refused', async () => {
    const change = seedChange(test);
    await test.settings(enabled(test, stubs));
    const shown = await preview(test, change.id);
    expect(shown.mode).toBe('new');
    await linkSession(test, change);
    expect((await preview(test, change.id)).argv).toContain(SESSION);
    const answer = await run(test, change.id, { token: shown.token, summaryHash: shown.summaryHash });
    expect(answer.status).toBe(409);
    expect(answer.json()).toMatchObject({ error: { code: 'token-invalid' } });
    expect(await stubs.records()).toEqual([]);
  });

  it('agent/claude-in-repo-refused: a claude inside a registered repo never runs', async () => {
    const change = seedChange(test);
    const shim = join(test.repoDir, 'node_modules', '.bin', 'claude');
    await mkdir(join(test.repoDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(shim, '#!/bin/sh\nexit 0\n');
    await chmod(shim, 0o755);
    await test.settings(enabled(test, stubs, { claudePath: shim }));
    const shown = await preview(test, change.id);
    expect(codes(shown.refusals)).toEqual(['claude-path-in-repo']);
    expect(shown.token).toBeNull();

    await test.settings(enabled(test, stubs, { claudePath: join(test.scratch, 'missing', 'claude') }));
    expect(codes((await preview(test, change.id)).refusals)).toEqual(['claude-not-found']);
  });

  it('claude is looked up on the daemon PATH when no path is set', async () => {
    const change = seedChange(test);
    await test.settings({ enabled: true, repos: [test.repoDir] });
    expect((await preview(test, change.id)).argv?.[0]).toBe(claude);
  });

  it('no-working-tree, working-tree-missing, archived and nothing-to-send are refused', async () => {
    await test.settings(enabled(test, stubs));
    const nowhere = seedChange(test, { name: 'nowhere', worktreePath: null });
    expect(codes((await preview(test, nowhere.id)).refusals)).toEqual(['no-working-tree']);
    const gone = seedChange(test, { name: 'gone', worktreePath: join(test.scratch, 'removed-tree') });
    expect(codes((await preview(test, gone.id)).refusals)).toEqual(['working-tree-missing']);
    const empty = seedChange(test, { name: 'empty', rewrite: false });
    expect(codes((await preview(test, empty.id)).refusals)).toEqual(['nothing-to-send']);
    const noteOnly = seedChange(test, { name: 'note-only', rewrite: false, note: 'Split the module.' });
    expect(codes((await preview(test, noteOnly.id)).refusals)).toEqual([]);
    const archived = seedChange(test, { name: 'archived', archived: true });
    expect(codes((await preview(test, archived.id)).refusals)).toEqual(['archived']);
    expect(await stubs.records()).toEqual([]);
  });

  it('agent/settings-key-validated: an invalid agentLaunch turns the launch off and names the key', async () => {
    const change = seedChange(test);
    await test.settings(enabled(test, stubs, { permissionMode: 'bypassPermissions' }));
    const shown = await preview(test, change.id);
    expect(shown.refusals).toEqual([{ code: 'agent-launch-disabled', message: expect.stringContaining('agentLaunch.permissionMode') as unknown }]);
    expect(shown.token).toBeNull();
    expect(shown.argv?.join(' ') ?? '').not.toMatch(/bypass|dangerously/i);
    await test.settings(enabled(test, stubs, { timeoutMinutes: 0 }));
    expect((await preview(test, change.id)).refusals[0]?.message).toContain('agentLaunch.timeoutMinutes');
  });

  it('agent/cross-site-403: preview and run from another site are refused before anything runs', async () => {
    const change = seedChange(test);
    await test.settings(enabled(test, stubs));
    const shown = await preview(test, change.id);
    const evil = { origin: 'http://evil.invalid', 'content-type': 'application/json' };
    const crossSite = { origin: `http://127.0.0.1:${String(test.port)}`, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' };
    for (const headers of [evil, crossSite, { 'content-type': 'application/json' }]) {
      const pre = await test.post(`/api/changes/${String(change.id)}/agent/preview`, {}, headers);
      expect(pre.status).toBe(403);
      const answer = await test.post(`/api/changes/${String(change.id)}/agent/run`, { token: shown.token, summaryHash: shown.summaryHash }, headers);
      expect(answer.status).toBe(403);
      expect(answer.json()).toMatchObject({ error: { code: 'cross-site' } });
    }
    expect(await stubs.records()).toEqual([]);
    // The token was never presented to the route, so it still works from the daemon page.
    expect((await run(test, change.id, { token: shown.token, summaryHash: shown.summaryHash })).status).toBe(202);
    await test.agent.runs().idle();
    expect(agentRunEvents(test)).toHaveLength(1);
  });
});
