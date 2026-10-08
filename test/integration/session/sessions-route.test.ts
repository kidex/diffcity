// GET /api/changes/:id/sessions (ADR-038): the linked sessions outside the
// Report, refused cross-site like the other code-bearing GETs (ADR-027), runs
// filtered to the change's working tree. Invented repos and transcripts only.

import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionsResponse } from '../../../src/core/model/types.js';
import { transcript } from '../../helpers/transcript.js';
import type { TempRepo } from '../../helpers/repo.js';
import { cleanupAfterEach, sampleRepo } from '../collect/collect-helpers.js';
import { claudeDir, sessionDaemon, sessionId, type ClaudeDir, type SessionDaemon } from './session-helpers.js';

cleanupAfterEach();

const claudes: ClaudeDir[] = [];
afterEach(async () => {
  for (const claude of claudes.splice(0)) await claude.cleanup();
});

/** sample-shop on `feature/cart`, with `.worktrees/rack` on `feature/rack`, and a session in the main tree whose runs work in both. */
async function scenario(): Promise<{ daemon: SessionDaemon; repo: TempRepo; dir: string; rack: string; id: string }> {
  const repo = await sampleRepo();
  await repo.commit('ignore worktrees', { '.gitignore': '.worktrees/\n' });
  await repo.branch('feature/cart');
  await repo.commit('count the cart', { 'src/cart/count.ts': 'export const count = 1;\n' });
  const dir = await realpath(repo.dir);
  await repo.git('worktree', 'add', '--quiet', '.worktrees/rack', '-b', 'feature/rack', 'main');
  const rack = join(dir, '.worktrees', 'rack');
  await writeFile(join(rack, 'src', 'rack.ts'), 'export const rack = 1;\n');
  await repo.git('-C', rack, 'add', '.');
  await repo.git('-C', rack, 'commit', '--quiet', '-m', 'add rack');

  const claude = await claudeDir();
  claudes.push(claude);
  const daemon = await sessionDaemon(claude);
  const id = sessionId(21);
  const main = transcript({ sessionId: id, cwd: dir }).prompt('Cart here, rack there');
  main.agent({ agentId: 'cartdev', type: 'dev', foreground: { report: 'Cart report', durationMs: 1000, toolUses: 1 } });
  main.agent({ agentId: 'rackdev', type: 'dev', foreground: { report: 'Rack report', durationMs: 1000, toolUses: 1 } });
  main.agent({ agentId: 'nodir', type: 'dev', foreground: { report: 'No sidechain', durationMs: 1000, toolUses: 1 } });
  await claude.write(id, main);
  await claude.sidechain(id, 'cartdev', transcript({ sessionId: id, agentId: 'cartdev', cwd: join(dir, 'src') }).text('Cart report'), { agentType: 'dev' });
  await claude.sidechain(id, 'rackdev', transcript({ sessionId: id, agentId: 'rackdev', cwd: rack }).text('Rack report'), { agentType: 'dev' });
  await daemon.hook(dir, { sessionId: id, transcriptPath: claude.transcriptPath(id), cwd: dir, event: 'Stop' });
  await daemon.until(id, (row) => row.digest !== null && daemon.db.sessions.links(row.id).length === 2);
  return { daemon, repo, dir, rack, id };
}

function changeId(daemon: SessionDaemon, ref: string): number {
  for (const repo of daemon.db.repos.list()) {
    const change = daemon.db.changes.listLive(repo.id).find((candidate) => candidate.ref === ref);
    if (change !== undefined) return change.id;
  }
  throw new Error(`no live change ${ref}`);
}

describe('GET /api/changes/:id/sessions', () => {
  it('session/sessions-route-cross-site-403: a cross-site browser request is refused; the own page and plain clients are served', async () => {
    const { daemon } = await scenario();
    const id = changeId(daemon, 'branch:feature/cart');
    const port = String(daemon.test.daemon.info.port);
    const path = `/api/changes/${String(id)}/sessions`;
    for (const headers of [{ origin: 'http://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { referer: 'http://evil.example/page' }]) {
      const response = await daemon.get(path, headers);
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).not.toContain('Cart here');
    }
    expect((await daemon.get(path, { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    const plain = await daemon.get(path);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('cache-control')).toBe('no-store');
    expect((await daemon.get('/api/changes/99999/sessions')).status).toBe(404);
    expect((await daemon.get('/api/changes/abc/sessions')).status).toBe(400);
  });

  it('session/sessions-route-filters-runs-to-change: each change sees the runs of its working tree, marked here; the others are counted; no parse state is served', async () => {
    const { daemon, dir, rack } = await scenario();
    const cart = (await (await daemon.get(`/api/changes/${String(changeId(daemon, 'branch:feature/cart'))}/sessions`)).json()) as SessionsResponse;
    expect(cart.sessions).toHaveLength(1);
    const [onCart] = cart.sessions;
    expect(onCart).toMatchObject({ sessionId: sessionId(21), title: 'Cart here, rack there', here: true, unreadable: false });
    expect(onCart?.digest?.runs.map((run) => [run.agentId, run.here])).toEqual([
      ['cartdev', true],
      ['nodir', true],
    ]);
    expect(onCart?.digest?.runsElsewhere).toBe(1);

    const rackView = (await (await daemon.get(`/api/changes/${String(changeId(daemon, 'branch:feature/rack'))}/sessions`)).json()) as SessionsResponse;
    const [onRack] = rackView.sessions;
    expect(onRack?.here).toBe(false);
    expect(onRack?.digest?.runs.map((run) => [run.agentId, run.here, run.report])).toEqual([['rackdev', true, 'Rack report']]);
    expect(onRack?.digest?.runsElsewhere).toBe(2);

    for (const body of [JSON.stringify(cart), JSON.stringify(rackView)]) {
      expect(body).not.toContain('"state"');
      expect(body).not.toContain('parsedBytes');
      expect(body).not.toContain(rack);
      expect(body).not.toContain(dir);
    }
  });

  it('an unreadable session is served without content', async () => {
    const { daemon, id } = await scenario();
    const row = daemon.row(id);
    if (row === null) throw new Error('no row');
    daemon.db.sessions.setParseError(row.id, 'read-failed');
    const view = (await (await daemon.get(`/api/changes/${String(changeId(daemon, 'branch:feature/cart'))}/sessions`)).json()) as SessionsResponse;
    expect(view.sessions[0]).toMatchObject({ unreadable: true, digest: null });
    expect(JSON.stringify(view)).not.toContain('read-failed');
  });
});
