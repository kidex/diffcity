// Sessions through a real daemon (ADR-038): a `track --agent` with a session
// is validated, stored, linked to changes and read in the session pool on the
// ADR-038 schedule. Invented repos and transcripts under temporary
// directories; the user's Claude configuration is never touched.

import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionDigest } from '../../../src/core/session/index.js';
import { transcript } from '../../helpers/transcript.js';
import type { TempRepo } from '../../helpers/repo.js';
import { cleanupAfterEach, sampleRepo } from '../collect/collect-helpers.js';
import { claudeDir, sessionDaemon, sessionId, type ClaudeDir, type SessionDaemon } from './session-helpers.js';

cleanupAfterEach();

const claudes: ClaudeDir[] = [];
afterEach(async () => {
  for (const claude of claudes.splice(0)) await claude.cleanup();
});

async function setup(): Promise<{ claude: ClaudeDir; daemon: SessionDaemon }> {
  const claude = await claudeDir();
  claudes.push(claude);
  return { claude, daemon: await sessionDaemon(claude) };
}

/** sample-shop with `.worktrees/` ignored and `feature/cart` checked out one commit ahead of main. */
async function shopOnBranch(): Promise<{ repo: TempRepo; dir: string }> {
  const repo = await sampleRepo();
  await repo.commit('ignore worktrees', { '.gitignore': '.worktrees/\n' });
  await repo.branch('feature/cart');
  await repo.commit('count the cart', { 'src/cart/count.ts': 'export const count = (items: number[]): number => items.length;\n' });
  return { repo, dir: await realpath(repo.dir) };
}

/** A linked worktree `.worktrees/<name>` on a new branch with one commit of its own. */
async function linkedWorktree(repo: TempRepo, dir: string, name: string): Promise<string> {
  await repo.git('worktree', 'add', '--quiet', `.worktrees/${name}`, '-b', `feature/${name}`, 'main');
  const tree = join(dir, '.worktrees', name);
  await writeFile(join(tree, 'src', `${name}.ts`), `export const ${name} = 1;\n`);
  await repo.git('-C', tree, 'add', '.');
  await repo.git('-C', tree, 'commit', '--quiet', '-m', `add ${name}`);
  return tree;
}

const session = (claude: ClaudeDir, id: string, cwd: string): Record<string, string> => ({ sessionId: id, transcriptPath: claude.transcriptPath(id), cwd, event: 'Stop' });

function changeByRef(daemon: SessionDaemon, ref: string): { id: number; head: string } {
  for (const repo of daemon.db.repos.list()) {
    const change = daemon.db.changes.listLive(repo.id).find((candidate) => candidate.ref === ref);
    if (change !== undefined) return change;
  }
  throw new Error(`no live change ${ref}`);
}

function linkedRefs(daemon: SessionDaemon, rowId: number): string[] {
  return daemon.db.sessions
    .links(rowId)
    .map((link) => daemon.db.changes.get(link.changeId)?.ref ?? '?')
    .sort();
}

const digestOf = (text: string | null): SessionDigest => JSON.parse(text ?? 'null') as SessionDigest;

describe('session links', () => {
  it('session/link-to-branch-change: the session is stored, read and linked to the branch checked out in its cwd; the agent event carries its id only', async () => {
    const { repo, dir } = await shopOnBranch();
    const { claude, daemon } = await setup();
    const id = sessionId(1);
    const path = await claude.write(id, transcript({ sessionId: id, cwd: dir }).prompt('Count the cart items'));

    expect(await daemon.hook(dir, session(claude, id, dir))).toMatchObject({ ok: true });
    const row = await daemon.until(id, (current) => current.digest !== null);
    const change = changeByRef(daemon, 'branch:feature/cart');
    expect(row).toMatchObject({ transcriptPath: path, cwd: dir, title: 'Count the cart items', parseError: null });
    expect(row.parsedBytes).toBe(digestOf(row.digest).state.main.parsedBytes);
    expect(row.parsedBytes).toBeGreaterThan(0);
    expect(daemon.db.sessions.links(row.id)).toEqual([{ changeId: change.id, sessionRowId: row.id, firstHead: change.head, lastHead: change.head, linkedAt: expect.any(String) as unknown }]);

    const agent = daemon.db.events.listForRepo(row.repoId).find((event) => event.type === 'agent');
    expect(agent?.payload).toEqual({ worktree: dir, sessionId: id });
    expect(JSON.stringify(agent)).not.toContain(path);
    await repo.cleanup();
  });

  it('session/link-to-draft: uncommitted work on main links the session to the draft', async () => {
    const repo = await sampleRepo();
    const dir = await realpath(repo.dir);
    await writeFile(join(dir, 'src', 'cart', 'total.ts'), 'export function total(items: number[]): number {\n  return items.length * 2;\n}\n');
    const { claude, daemon } = await setup();
    const id = sessionId(2);
    await claude.write(id, transcript({ sessionId: id, cwd: dir }).prompt('Double the total'));
    await daemon.hook(dir, session(claude, id, dir));
    const row = await daemon.until(id, (current) => current.digest !== null);
    expect(linkedRefs(daemon, row.id)).toEqual(['draft:.']);
  });

  it('session/worktree-cwd-maps-to-its-change: a session in a linked worktree links to that worktree change, not the main one', async () => {
    const { repo, dir } = await shopOnBranch();
    const rack = await linkedWorktree(repo, dir, 'rack');
    const { claude, daemon } = await setup();
    const id = sessionId(3);
    await claude.write(id, transcript({ sessionId: id, cwd: rack }).prompt('Build the rack'));
    await daemon.hook(rack, session(claude, id, rack));
    const row = await daemon.until(id, (current) => current.digest !== null);
    expect(linkedRefs(daemon, row.id)).toEqual(['branch:feature/rack']);
  });

  it('session/link-several-changes: runs in other worktrees and a branch switch between Stops link the session to each change', async () => {
    const { repo, dir } = await shopOnBranch();
    const rack = await linkedWorktree(repo, dir, 'rack');
    const { claude, daemon } = await setup();
    const id = sessionId(4);
    const main = transcript({ sessionId: id, cwd: dir }).prompt('Split the work');
    main.agent({ agentId: 'rackdev', type: 'dev', foreground: { report: 'Rack done', durationMs: 1000, toolUses: 2 } });
    await claude.write(id, main);
    const side = transcript({ sessionId: id, agentId: 'rackdev', cwd: rack });
    side.toolCall('Edit', { file_path: join(rack, 'src', 'rack.ts') });
    await claude.sidechain(id, 'rackdev', side.text('Rack done'), { agentType: 'dev' });

    await daemon.hook(dir, session(claude, id, dir));
    const row = await daemon.until(id, (current) => current.digest !== null && daemon.db.sessions.links(current.id).length === 2);
    expect(linkedRefs(daemon, row.id)).toEqual(['branch:feature/cart', 'branch:feature/rack']);

    // The main working tree moves to another branch; the next Stop links that change too.
    await repo.branch('feature/totals', 'main');
    await repo.commit('totals', { 'src/cart/totals.ts': 'export const totals = 2;\n' });
    await claude.append(id, transcript({ sessionId: id, cwd: dir, start: '2026-09-01T10:00:00.000Z' }).prompt('Now the totals'));
    await daemon.hook(dir, session(claude, id, dir), '2026-09-01T12:05:00.000Z');
    await daemon.until(id, (current) => daemon.db.sessions.links(current.id).length === 3, 'a third link');
    expect(linkedRefs(daemon, row.id)).toEqual(['branch:feature/cart', 'branch:feature/rack', 'branch:feature/totals']);
  });

  it('session/reparse-on-second-stop: a later Stop reads from the stored cursor; nothing is read twice', async () => {
    const { dir } = await shopOnBranch();
    const { claude, daemon } = await setup();
    const id = sessionId(5);
    await claude.write(id, transcript({ sessionId: id, cwd: dir }).prompt('First prompt'));
    await daemon.hook(dir, session(claude, id, dir));
    const first = await daemon.until(id, (current) => current.digest !== null);
    expect(digestOf(first.digest).prompts.map((prompt) => prompt.text)).toEqual(['First prompt']);

    await claude.append(id, transcript({ sessionId: id, cwd: dir, start: '2026-09-01T10:00:00.000Z' }).prompt('Second prompt'));
    await daemon.hook(dir, session(claude, id, dir), '2026-09-01T12:05:00.000Z');
    const second = await daemon.until(id, (current) => current.parsedBytes > first.parsedBytes);
    expect(digestOf(second.digest).prompts.map((prompt) => prompt.text)).toEqual(['First prompt', 'Second prompt']);
    expect(second.lastAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('session/late-subagent-report-picked-up: a background run finishing after the Stop is read at the next Stop', async () => {
    const { dir } = await shopOnBranch();
    const { claude, daemon } = await setup();
    const id = sessionId(6);
    const main = transcript({ sessionId: id, cwd: dir }).prompt('Review in the background');
    const toolUseId = main.agent({ agentId: 'bgrev', type: 'reviewer' });
    await claude.write(id, main);
    await daemon.hook(dir, session(claude, id, dir));
    const first = await daemon.until(id, (current) => current.digest !== null);
    expect(digestOf(first.digest).runs.map((run) => [run.agentId, run.status, run.report])).toEqual([['bgrev', 'running', null]]);

    await claude.sidechain(id, 'bgrev', transcript({ sessionId: id, agentId: 'bgrev', cwd: dir, start: '2026-09-01T09:05:00.000Z' }).text('Late review report'), { agentType: 'reviewer' });
    await claude.append(id, transcript({ sessionId: id, cwd: dir, start: '2026-09-01T09:10:00.000Z' }).notification({ agentId: 'bgrev', toolUseId, status: 'completed', durationMs: 4000, toolUses: 3 }));
    await daemon.hook(dir, session(claude, id, dir), '2026-09-01T12:10:00.000Z');
    const second = await daemon.until(id, (current) => digestOf(current.digest).runs[0]?.status === 'completed');
    expect(digestOf(second.digest).runs.map((run) => [run.agentId, run.status, run.report])).toEqual([['bgrev', 'completed', 'Late review report']]);
  });
});

describe('session refusals', () => {
  it('session/forged-socket-message-no-read: a session outside the projects directory, or misnamed, is refused by code; no row, no read; the track still marks the agent', async () => {
    const { dir } = await shopOnBranch();
    const { claude, daemon } = await setup();
    const id = sessionId(8);
    const elsewhere = join(claude.dir, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const forged = join(elsewhere, `${id}.jsonl`);
    await writeFile(forged, transcript({ sessionId: id, cwd: dir }).prompt('FORGED SECRET PROMPT').jsonl());
    await claude.write(sessionId(9), transcript({ sessionId: sessionId(9), cwd: dir }).prompt('Another session'));

    const attempts: Record<string, unknown>[] = [
      { sessionId: id, transcriptPath: forged, cwd: dir, event: 'Stop' },
      { sessionId: id, transcriptPath: claude.transcriptPath(sessionId(9)), cwd: dir, event: 'Stop' },
      { sessionId: '../../etc/passwd', transcriptPath: forged, cwd: dir, event: 'Stop' },
      { sessionId: id, transcriptPath: `${claude.project}/../../elsewhere/${id}.jsonl`, cwd: dir, event: 'Stop' },
    ];
    for (const attempt of attempts) expect(await daemon.hook(dir, attempt)).toMatchObject({ ok: true });
    await daemon.settle();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(daemon.row(id)).toBeNull();
    expect(daemon.row(sessionId(9))).toBeNull();
    expect(daemon.db.repos.list().flatMap((repo) => daemon.db.changes.listLive(repo.id)).every((change) => daemon.db.sessions.forChange(change.id, 20).length === 0)).toBe(true);
    const refusals = daemon.log.lines.filter((line) => line.includes('session refused'));
    expect(refusals).toEqual([
      'warn session refused: outside-projects',
      'warn session refused: basename-mismatch',
      'warn session refused: bad-session-id',
      'warn session refused: bad-transcript-path',
    ]);
    expect(daemon.log.lines.join('\n')).not.toContain(elsewhere);
    expect(daemon.log.lines.join('\n')).not.toContain('FORGED');
    // The agent mark went through for every attempt, without a session id.
    const agents = daemon.db.repos.list().flatMap((repo) => daemon.db.events.listForRepo(repo.id)).filter((event) => event.type === 'agent');
    expect(agents).toHaveLength(4);
    for (const event of agents) expect(event.payload).not.toHaveProperty('sessionId');
  });
});
