// The served view of a linked session (ADR-038): parse state stripped, runs
// filtered to the change's working tree and marked `here`, activity scoped to
// what is shown, no dangling parents, ended/stale/unreadable states.

import { describe, expect, it } from 'vitest';
import { sessionView, treeContaining, type SessionRow } from '../../../src/core/session/index.js';
import { digestOf, transcript } from '../../helpers/transcript.js';

const MAIN = '/work/shopfront';
const RACK = '/work/shopfront/.worktrees/rack';
const SCRATCH = '/work/shopfront/.worktrees/scratch';

function row(digest: string | null, overrides: Partial<SessionRow> = {}): SessionRow {
  return { sessionId: 'abcdef01', title: 'T', firstAt: null, lastAt: null, cwd: MAIN, digest, parseError: null, firstHead: 'h', lastHead: 'h', linkedAt: '2026-09-01T09:00:00.000Z', ...overrides };
}

function sample(state: { ended?: boolean } = {}): string {
  const main = transcript().prompt('Split');
  main.toolCall('Edit', { file_path: `${MAIN}/src/main.ts` });
  main.agent({ agentId: 'a1', foreground: { report: 'r1', durationMs: 1, toolUses: 1 } });
  main.agent({ agentId: 'a2', foreground: { report: 'r2', durationMs: 1, toolUses: 1 } });
  main.agent({ agentId: 'a3', foreground: { report: 'r3', durationMs: 1, toolUses: 1 } });
  const a2 = transcript({ agentId: 'a2', cwd: RACK });
  a2.toolCall('Edit', { file_path: `${RACK}/src/rack.ts` });
  // a4 is launched by a2 (in rack) but works in the main tree.
  a2.agent({ agentId: 'a4', foreground: { report: 'r4', durationMs: 1, toolUses: 1 } });
  const digest = digestOf({
    main,
    metas: { a4: { agentType: 'dev', spawnDepth: 2, parentAgentId: 'a2' } },
    sidechains: {
      a1: transcript({ agentId: 'a1', cwd: `${MAIN}/src` }).text('r1'),
      a2: a2.text('r2'),
      a3: transcript({ agentId: 'a3', cwd: '/tmp/scratch' }).text('r3'),
      a4: transcript({ agentId: 'a4', cwd: MAIN }).text('r4'),
    },
  });
  if (state.ended !== undefined) digest.state.ended = state.ended;
  return JSON.stringify(digest);
}

describe('session view', () => {
  it('treeContaining picks the innermost tree, never a sibling with a common prefix', () => {
    expect(treeContaining([MAIN, RACK], `${RACK}/src`)).toBe(RACK);
    expect(treeContaining([MAIN, RACK], `${MAIN}/src`)).toBe(MAIN);
    expect(treeContaining([MAIN], '/work/shopfront-old/src')).toBeNull();
    expect(treeContaining([MAIN], MAIN)).toBe(MAIN);
  });

  it('runs here are marked, runs in another tree are counted out, runs in no known tree are kept; a hidden parent is never named', () => {
    const view = sessionView(row(sample()), { changeTree: MAIN, trees: [MAIN, RACK] });
    expect(view.here).toBe(true);
    // a4's parent a2 worked in rack and is left out: a4 names no parent.
    expect(view.digest?.runs.map((run) => [run.agentId, run.here, run.parentAgentId]).sort()).toEqual([
      ['a1', true, null],
      ['a3', false, null],
      ['a4', true, null],
    ]);
    expect(view.digest?.runsElsewhere).toBe(1);
    expect(view.digest).not.toHaveProperty('state');
    // One title, on the session; the digest repeats none of the session's own fields.
    for (const key of ['title', 'sessionId', 'firstAt', 'lastAt', 'files', 'outsideFiles']) expect(view.digest).not.toHaveProperty(key);
  });

  it('on the linked worktree change, the session is not here; its run there and the unknown one are kept', () => {
    const view = sessionView(row(sample()), { changeTree: RACK, trees: [MAIN, RACK] });
    expect(view.here).toBe(false);
    expect(view.digest?.runs.map((run) => [run.agentId, run.here])).toEqual([
      ['a2', true],
      ['a3', false],
    ]);
  });

  it('activity is scoped: the main agent only when the session is here; session totals under sessionWide', () => {
    const onMain = sessionView(row(sample()), { changeTree: MAIN, trees: [MAIN, RACK] });
    expect(onMain.digest?.main?.files).toEqual(['src/main.ts']);
    expect(onMain.digest?.sessionWide.files).toEqual(['src/main.ts', '.worktrees/rack/src/rack.ts']);
    const onRack = sessionView(row(sample()), { changeTree: RACK, trees: [MAIN, RACK] });
    expect(onRack.digest?.main).toBeNull();
    expect(onRack.digest?.runs.find((run) => run.agentId === 'a2')?.activity.files).toEqual(['.worktrees/rack/src/rack.ts']);
    expect(onRack.digest?.sessionWide.files).toEqual(['src/main.ts', '.worktrees/rack/src/rack.ts']);
  });

  it('a nested working tree with no change is still another tree: its runs are not here on the main change', () => {
    const main = transcript().prompt('Scratch');
    main.agent({ agentId: 's1', foreground: { report: 'r', durationMs: 1, toolUses: 1 } });
    const digest = JSON.stringify(digestOf({ main, sidechains: { s1: transcript({ agentId: 's1', cwd: SCRATCH }).text('r') } }));
    expect(sessionView(row(digest), { changeTree: MAIN, trees: [MAIN, SCRATCH] }).digest).toMatchObject({ runs: [], runsElsewhere: 1 });
    // Without the listing, it would wrongly count as the main tree.
    expect(sessionView(row(digest), { changeTree: MAIN, trees: [MAIN] }).digest?.runs.map((run) => run.here)).toEqual([true]);
  });

  it('a kept run keeps a parent that is shown', () => {
    const main = transcript().prompt('Lead');
    main.agent({ agentId: 'lead', foreground: { report: 'r', durationMs: 1, toolUses: 1 } });
    const lead = transcript({ agentId: 'lead', cwd: MAIN });
    lead.agent({ agentId: 'dev', foreground: { report: 'd', durationMs: 1, toolUses: 1 } });
    const digest = JSON.stringify(digestOf({ main, metas: { dev: { agentType: 'dev', spawnDepth: 2, parentAgentId: 'lead' } }, sidechains: { lead: lead.text('r'), dev: transcript({ agentId: 'dev', cwd: MAIN }).text('d') } }));
    const runs = sessionView(row(digest), { changeTree: MAIN, trees: [MAIN] }).digest?.runs ?? [];
    expect(runs.find((run) => run.agentId === 'dev')?.parentAgentId).toBe('lead');
  });

  it('a change checked out nowhere keeps every run, none here', () => {
    const view = sessionView(row(sample()), { changeTree: null, trees: [MAIN, RACK] });
    expect(view.here).toBe(false);
    expect(view.digest?.runs.map((run) => run.here)).toEqual([false, false, false, false]);
    expect(view.digest?.runsElsewhere).toBe(0);
  });

  it('active until the session ended', () => {
    expect(sessionView(row(sample()), { changeTree: MAIN, trees: [MAIN] }).active).toBe(true);
    expect(sessionView(row(sample({ ended: true })), { changeTree: MAIN, trees: [MAIN] }).active).toBe(false);
    expect(sessionView(row(null), { changeTree: MAIN, trees: [MAIN] }).active).toBe(true);
  });

  it('transient failures (read-failed, transcript-missing) keep the last good digest as stale', () => {
    for (const code of ['read-failed', 'transcript-missing']) {
      const view = sessionView(row(sample(), { parseError: code }), { changeTree: MAIN, trees: [MAIN] });
      expect(view, code).toMatchObject({ stale: true, unreadable: false });
      expect(view.digest?.prompts.map((prompt) => prompt.text)).toEqual(['Split']);
    }
  });

  it('a validation refusal is unreadable with no digest, even with a good one stored', () => {
    for (const code of ['symlink', 'outside-projects', 'basename-mismatch', 'not-a-file', 'no-projects-dir', 'bad-transcript-path']) {
      const view = sessionView(row(sample(), { parseError: code }), { changeTree: MAIN, trees: [MAIN] });
      expect(view, code).toMatchObject({ unreadable: true, stale: false, digest: null, title: null });
      expect(JSON.stringify(view)).not.toContain('Split');
      expect(JSON.stringify(view)).not.toContain(code);
    }
    expect(sessionView(row(null, { parseError: 'symlink' }), { changeTree: MAIN, trees: [MAIN] })).toMatchObject({ unreadable: true, stale: false, digest: null });
  });

  it('a failed re-read keeps the last good digest as stale; with no good digest it is unreadable, with no content', () => {
    const stale = sessionView(row(sample(), { parseError: 'read-failed' }), { changeTree: MAIN, trees: [MAIN] });
    expect(stale).toMatchObject({ stale: true, unreadable: false });
    expect(stale.digest?.prompts.map((prompt) => prompt.text)).toEqual(['Split']);
    expect(sessionView(row(null, { parseError: 'outside-projects' }), { changeTree: MAIN, trees: [MAIN] })).toMatchObject({ unreadable: true, stale: false, digest: null });
    expect(sessionView(row('{"format":99}'), { changeTree: MAIN, trees: [MAIN] })).toMatchObject({ unreadable: true, digest: null });
    expect(sessionView(row(null), { changeTree: MAIN, trees: [MAIN] })).toMatchObject({ unreadable: false, stale: false, digest: null });
    expect(JSON.stringify(stale)).not.toContain('read-failed');
  });
});
